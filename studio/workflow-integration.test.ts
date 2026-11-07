import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import Fastify from "fastify";
import { z } from "zod";
import { ProjectStore, sha256 } from "./store.ts";
import { AgentHub } from "./agent.ts";
import { registerWorkflowRoutes } from "./workflow-routes.ts";
import { permissionTools, defaultToolPolicies } from "./tool-permissions.ts";
import { contextFor, DraftQueue, taskCreationTarget, taskReviewContract, directionPayload, directionMaterial } from "../web/workflow-state.ts";
import type { ProductionTask } from "./workflow-model.ts";

class StubRuntime extends EventEmitter {
  calls: { method: string; input: any }[] = [];
  overrides: string[];
  closed = false;
  turn = 0;
  interruptGate?: Promise<void>;
  configReportsDisabled = true;
  constructor(overrides: string[]) { super(); this.overrides = overrides; }
  async initialize() {}
  async request(method: string, input: any) {
    this.calls.push({ method, input });
    if (method === "config/read") return { config: { features: { image_generation: this.configReportsDisabled ? this.overrides.includes("features.image_generation=true") : true } } };
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: input.threadId || "stub-thread" }, model: input.model };
    if (method === "mcpServerStatus/list") return { data: [] };
    if (method === "turn/start") return { turn: { id: `stub-${randomUUID()}-${++this.turn}` } };
    if (method === "turn/interrupt") { await this.interruptGate; return {}; }
    return {};
  }
  async close() { this.closed = true; }
}
async function waitFor(check: () => unknown) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(check(), "expected workflow state");
}
function result(result: any): any { return JSON.parse(result.content.find((item: any) => item.type === "text").text); }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "studio-workflow-")), sourcePath = join(root, "synthetic.png");
  const made = spawnSync(process.env.SPRITE_STUDIO_PYTHON || "python", ["-I", "-c", "from PIL import Image,ImageDraw; import sys; im=Image.new('RGBA',(64,32)); d=ImageDraw.Draw(im); d.rectangle((5,5,26,26),fill='red'); d.rectangle((37,5,58,26),fill='blue'); im.save(sys.argv[1])", sourcePath], { windowsHide: true });
  assert.equal(made.status, 0, made.stderr.toString());
  const store = new ProjectStore(join(root, "projects")), pid = store.createProject("isolated workflow").id;
  const image = await store.importImage(pid, "source.png", readFileSync(sourcePath), "reference");
  const runtimes: StubRuntime[] = [];
  const hub: AgentHub = Object.assign(Object.create(AgentHub.prototype), {
    store, endpoint: "http://127.0.0.1:9999", clients: new Map(), tokens: new Map(), timers: new Map(), imports: new Map(), prompts: new Map(), frameSaves: new Map(), toolWaits: new Map(), toolTails: new Map(), toolEpochs: new Map(), promptTails: new Map(), staleTurns: new Map(), clientGenerationModes: new Map(), generationIntents: new Map(), transitioning: new Set(), disabled: [], status: { connected: true }, bootstrapPromise: Promise.resolve(), stopped: false,
  });
  (hub as any).createRuntime = (_workspace: string, overrides: string[]) => { const runtime = new StubRuntime(overrides); runtimes.push(runtime); return runtime; };
  const app = Fastify();
  app.setErrorHandler((error: any, _request, reply) => reply.code(error.statusCode || 400).send({ error: error instanceof z.ZodError ? error.issues.map((i: any) => i.message).join(";") : error.message }));
  registerWorkflowRoutes(app, store, hub);
  const api = async (path: string, body?: any, method: "GET" | "POST" | "PUT" = body === undefined ? "GET" : "POST") => app.inject({ method, url: path, ...(body === undefined ? {} : { payload: body }) });
  const taskPath = (id: string) => `/api/projects/${pid}/tasks/${id}`;
  const create = async (extra: any = {}) => {
    const response = await api(`/api/projects/${pid}/tasks`, { requestId: randomUUID(), title: "produce", description: "明确制作请求", target: { mode: "saved", assetId: image.id }, ...extra });
    assert.equal(response.statusCode, 200, response.body); return response.json<ProductionTask>();
  };
  const begin = async (task: ProductionTask, context?: any, text = "请制作并检查，不要自动重试生成") => {
    const response = await api(`/api/sessions/${task.sessionId}/messages`, { requestId: randomUUID(), text, taskId: task.id, ...(context ? { context } : {}) });
    assert.equal(response.statusCode, 202, response.body);
    const session = store.session(task.sessionId!);
    await waitFor(() => session.status === "failed" || (session.status === "running" && session.turnId));
    assert.equal(session.status, "running", session.error); return session;
  };
  const emit = async (sessionId: string, method: string, item: any, turnId?: string) => {
    const session = store.session(sessionId);
    await (hub as any).notification(session, { method, params: { threadId: session.threadId, turnId: turnId || session.turnId, item } });
  };
  const generate = async (task: ProductionTask) => {
    const id = `synthetic-event-${randomUUID()}`, session = store.session(task.sessionId!);
    await emit(session.id, "item/started", { id, type: "imageGeneration", status: "inProgress" });
    await emit(session.id, "item/completed", { id, type: "imageGeneration", status: "completed", savedPath: sourcePath, inputImages: (session.workflowReferenceHashes || []).map(sha256 => ({ sha256 })) });
    await Promise.all(hub.imports.get(session.id) || []);
    return store.generated.list(pid, session.id).find(g => g.generationId === id)!;
  };
  const approveExisting = (task: ProductionTask, snapshotId?: string) => {
    const current = store.tasks.get(pid, task.id);
    return store.tasks.decideDirection(pid, task.id, { expectedRevision: current.revision, accept: true, ...(snapshotId ? { snapshotId } : { assetId: image.id }) });
  };
  const clip = (count = 2) => store.createClip(pid, "rough", Array.from({ length: count }, () => ({ id: randomUUID(), imageId: image.id, durationUs: 100000 })));
  const cleanup = async () => { await hub.close(); await app.close(); await store.worker.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, sourcePath, store, pid, image, runtimes, hub, app, api, taskPath, create, begin, emit, generate, approveExisting, clip, cleanup };
}

test("real store/worker: initial direction generation audit, frozen one-click precheck/save, production slicing and object draft, ready/accept", async () => {
  const f = await fixture();
  try {
    let task = await f.create();
    const session = await f.begin(task, undefined, "请明确生成一张方向图，再完成确定性制作");
    assert.ok(f.runtimes[0]!.overrides.includes("features.image_generation=true"));
    await assert.rejects(f.hub.tool(session.id, "create_clip", { name: "forbidden before precheck", requestId: randomUUID() }), /方向/);
    const generated = await f.generate(task);
    task = f.store.tasks.get(f.pid, task.id);
    assert.equal(task.attempts[0]!.status, "completed"); assert.equal(task.attempts[0]!.preflightVerified, false); assert.equal(task.attempts[0]!.referenceEvidence?.verified, true);
    const args = { generatedId: generated.id, type: "resource", name: "approved-sheet", folder: ".", requestId: randomUUID() }, exact = structuredClone(args);
    const save = f.hub.tool(session.id, "save_image", args);
    args.name = "mutated-after-enqueue";
    await waitFor(() => session.toolApproval);
    const approval = session.toolApproval!;
    assert.equal(approval.directionRequired, true); assert.equal(approval.arguments.name, "approved-sheet");
    assert.throws(() => f.hub.resolveToolApproval(session.id, approval.id, true), /direction/);
    const binding = { sessionId: session.id, approvalId: approval.id };
    assert.equal((await f.api(`${f.taskPath(task.id)}/direction`, { expectedRevision: task.revision - 1, accept: true, generatedId: generated.id, toolApproval: binding })).statusCode, 409);
    assert.equal(f.store.assets(f.pid).length, 1);
    const rejectedBlank = await f.api(`${f.taskPath(task.id)}/direction`, { ...directionPayload(task, session, true, ""), accept: false, feedback: "" });
    assert.equal(rejectedBlank.statusCode, 400); assert.equal(f.store.tasks.get(f.pid, task.id).revision, task.revision);
    const decision = await f.api(`${f.taskPath(task.id)}/direction`, directionPayload(task, session, true, "   "));
    assert.equal(decision.statusCode, 200, decision.body);
    const saved = result(await save); assert.equal(saved.name, "approved-sheet.png");
    await waitFor(() => f.runtimes.length === 2 && session.status === "running" && session.turnId);
    assert.equal(f.runtimes[0]!.closed, true); assert.ok(f.runtimes[1]!.overrides.includes("features.image_generation=false"));
    assert.ok(f.runtimes[1]!.calls.some(c => c.method === "config/read"));
    assert.match(f.runtimes[1]!.calls.find(c => c.method === "turn/start")!.input.input[0].text, /真实结果/);
    assert.equal(f.store.generated.list(f.pid).length, 1);
    // Retry is a tool decision, not another direction decision or another image.
    const retry = f.hub.tool(session.id, "save_image", exact);
    await waitFor(() => session.toolApproval); assert.equal(session.toolApproval!.directionRequired, false);
    f.hub.resolveToolApproval(session.id, session.toolApproval!.id, true);
    assert.equal(result(await retry).id, saved.id);
    const source = result(await f.hub.tool(session.id, "read_document", { documentId: saved.id }));
    const recipe = source.recipe; recipe.slicing.grid.columns = 2; recipe.slicing.items = [{ cell: [0, 0], name: "left", enabled: true }, { cell: [1, 0], name: "right", enabled: true }];
    const written = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: saved.id, expectedDocumentRevision: source.documentRevision, text: JSON.stringify(recipe) }] }))[0];
    const sliced = result(await f.hub.tool(session.id, "slice_sheet", { assetId: saved.id, expectedDefinitionRevision: written.definitionRevision, requestId: randomUUID() }));
    assert.equal(sliced.outputIds.length, 2);
    const created = result(await f.hub.tool(session.id, "create_clip", { name: "produced-action", requestId: randomUUID() }));
    task = f.store.tasks.get(f.pid, task.id); assert.equal(task.target?.clipId, created.id); assert.equal(task.contract.scope?.clipId, created.id); assert.equal(task.direction?.generatedId, generated.id);
    const draft = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: created.id, revision: created.revision }));
    const body = JSON.parse(draft.text); body.frames = sliced.outputIds.map((imageId: string, i: number) => ({ id: randomUUID(), imageId, durationUs: (i + 1) * 100000 }));
    const docs = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(body) }] }));
    const draftReview = result(await f.hub.tool(session.id, "inspect_clip", { draftId: draft.documentId, documentRevision: docs[0].documentRevision }));
    assert.equal(draftReview.stale, false);
    const committed = result(await f.hub.tool(session.id, "save_clip_draft", { draftId: draft.documentId, documentRevision: docs[0].documentRevision }));
    assert.equal(committed.saved, true); assert.equal(committed.clip.frames.length, 2);
    const ready = result(await f.hub.tool(session.id, "workflow_task", { action: "ready" }));
    assert.equal(ready.task.status, "ready"); assert.equal(ready.checks[0].status, "passed"); assert.equal(ready.checks[1].status, "unverified"); assert.equal(ready.pendingHumanDynamicReview, true);
    const fixed = await f.api(`/api/projects/${f.pid}/snapshots/${ready.snapshot.id}`); assert.equal(fixed.statusCode, 200); assert.equal(fixed.json().clip.frames[1].durationUs, 200000);
    const accept = await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: ready.task.revision, action: "accept", snapshotId: ready.snapshot.id });
    assert.equal(accept.statusCode, 200, accept.body); assert.equal(accept.json().status, "accepted");
    assert.equal(f.store.state(f.pid).qualityCapabilities.temporal.verified, false);
    assert.ok(f.store.state(f.pid).tasks.length); assert.ok(f.store.state(f.pid).clipDrafts);
  } finally { await f.cleanup(); }
});

test("allow still needs direction; typed save-location rejects frozen old request but preserves attempts and direction", async () => {
  const f = await fixture();
  try {
    let task = await f.create(); const session = await f.begin(task); const generated = await f.generate(task);
    f.store.permissions.write({ save_image: "allow" });
    const old = f.hub.tool(session.id, "save_image", { generatedId: generated.id, type: "resource", name: "old-location", requestId: randomUUID() });
    await waitFor(() => session.toolApproval); task = f.store.tasks.get(f.pid, task.id);
    const before = structuredClone(task);
    const response = await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: task.revision, action: "save-location", text: "放到更合适的目录并更名", toolApproval: { sessionId: session.id, approvalId: session.toolApproval!.id } });
    assert.equal(response.statusCode, 200, response.body); assert.match(result(await old).reason, /同generatedId/);
    task = f.store.tasks.get(f.pid, task.id); assert.equal(task.intentVersion, before.intentVersion); assert.equal(task.barrierVersion, before.barrierVersion); assert.deepEqual(task.attempts, before.attempts); assert.equal(task.direction, undefined);
    const corrected = f.hub.tool(session.id, "save_image", { generatedId: generated.id, type: "resource", name: "corrected", requestId: randomUUID() });
    await waitFor(() => session.toolApproval);
    const accepted = await f.api(`${f.taskPath(task.id)}/direction`, { expectedRevision: task.revision, accept: true, generatedId: generated.id, toolApproval: { sessionId: session.id, approvalId: session.toolApproval!.id } });
    assert.equal(accepted.statusCode, 200, accepted.body); assert.equal(result(await corrected).name, "corrected.png");
    assert.equal(f.store.generated.list(f.pid).length, 1); assert.equal(f.store.tasks.get(f.pid, task.id).attempts.length, 1);
  } finally { await f.cleanup(); }
});

test("direction denial returns feedback, stops old runtime/queue and preserves generated output without retries", async () => {
  const f = await fixture();
  try {
    let task = await f.create(); const session = await f.begin(task); const generated = await f.generate(task);
    const save = f.hub.tool(session.id, "save_image", { generatedId: generated.id, type: "resource", name: "not-approved", requestId: randomUUID() });
    const queued = f.hub.tool(session.id, "list_assets", {}); const rejectedQueue = assert.rejects(queued, /任务已取消|失效/);
    await waitFor(() => session.toolApproval); task = f.store.tasks.get(f.pid, task.id);
    const deny = await f.api(`${f.taskPath(task.id)}/direction`, { expectedRevision: task.revision, accept: false, feedback: "方向不对，先保留不要再生成", generatedId: generated.id, toolApproval: { sessionId: session.id, approvalId: session.toolApproval!.id } });
    assert.equal(deny.statusCode, 200, deny.body); assert.match(result(await save).reason, /先保留/); await rejectedQueue;
    assert.equal(f.store.assets(f.pid).length, 1); assert.equal(f.store.generated.list(f.pid).length, 1); assert.equal(session.status, "interrupted");
    assert.equal(f.store.tasks.get(f.pid, task.id).phase, "direction");
    await f.begin(f.store.tasks.get(f.pid, task.id));
    assert.ok(f.runtimes.at(-1)!.overrides.includes("features.image_generation=false"), "a later user message is not an unattended regeneration authorization");
  } finally { await f.cleanup(); }
});

test("save failure keeps approved direction, returns actual failure receipt to continuation, and recovers without regeneration", async () => {
  const f = await fixture();
  try {
    let task = await f.create(); const session = await f.begin(task); const generated = await f.generate(task);
    // Name collision in the resource category, not a fake tool error.
    await f.store.importImage(f.pid, "collision.png", readFileSync(f.sourcePath), "image");
    const save = f.hub.tool(session.id, "save_image", { generatedId: generated.id, type: "resource", name: "collision", requestId: randomUUID() });
    await waitFor(() => session.toolApproval); task = f.store.tasks.get(f.pid, task.id);
    const response = await f.api(`${f.taskPath(task.id)}/direction`, { expectedRevision: task.revision, accept: true, generatedId: generated.id, toolApproval: { sessionId: session.id, approvalId: session.toolApproval!.id } });
    assert.equal(response.statusCode, 200, response.body); const failure = result(await save); assert.equal(failure.saved, false); assert.equal(failure.directionAccepted, true); assert.match(failure.reason, /同名/);
    await waitFor(() => session.status === "running" && f.runtimes.length === 2);
    assert.match(f.runtimes[1]!.calls.find(c => c.method === "turn/start")!.input.input[0].text, /directionAccepted/);
    const retry = f.hub.tool(session.id, "save_image", { generatedId: generated.id, type: "resource", name: "recovered", requestId: randomUUID() });
    await waitFor(() => session.toolApproval); assert.equal(session.toolApproval!.directionRequired, false);
    f.hub.resolveToolApproval(session.id, session.toolApproval!.id, true);
    assert.equal(result(await retry).name, "recovered.png"); assert.equal(f.store.tasks.get(f.pid, task.id).attempts.length, 1);
  } finally { await f.cleanup(); }
});

test("handoff during real rendering invalidates actual ClipDrafts beforeCommit and the queue before interrupt acknowledgement", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(); let task = await f.create({ target: { mode: "saved", clipId: clip.id } }); task = f.approveExisting(task, task.target!.snapshotId);
    const session = await f.begin(task);
    const draft = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision }));
    const body = JSON.parse(draft.text); body.frames[0].transform = { scale: 0.6, offsetX: 0, offsetY: 0, clip: false };
    const edited = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(body) }] }))[0];
    let releaseRender!: () => void, releaseInterrupt!: () => void, rendering = false, guardCalls = 0;
    const renderGate = new Promise<void>(r => releaseRender = r), originalRun = f.store.worker.run.bind(f.store.worker);
    f.store.worker.run = (async (command: string, input: any) => { const value = await originalRun(command, input); if (command === "transform") { rendering = true; await renderGate; } return value; }) as any;
    const originalSave = f.store.clipDrafts.save.bind(f.store.clipDrafts);
    f.store.clipDrafts.save = (pid, id, revision, beforeCommit) => originalSave(pid, id, revision, () => { guardCalls++; assert.ok(beforeCommit); beforeCommit!(); });
    f.runtimes.at(-1)!.interruptGate = new Promise<void>(r => releaseInterrupt = r);
    const save = f.hub.tool(session.id, "save_clip_draft", { draftId: draft.documentId, documentRevision: edited.documentRevision });
    const rejectedSave = assert.rejects(save, /任务已取消|失效/);
    const queued = f.hub.tool(session.id, "list_assets", {}); const rejectedQueue = assert.rejects(queued, /任务已取消|失效/);
    await waitFor(() => rendering); task = f.store.tasks.get(f.pid, task.id);
    const handingOff = f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: task.revision, action: "handoff" });
    await waitFor(() => f.store.tasks.get(f.pid, task.id).status === "paused");
    releaseRender(); await rejectedSave; await rejectedQueue;
    assert.equal(guardCalls, 1, "the real Agent path passes and invokes ClipDrafts.save's beforeCommit");
    assert.equal(f.store.animation.clip(f.pid, clip.id).revision, clip.revision);
    const human = f.store.clipDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision }, "human");
    const humanBody = JSON.parse(human.text); humanBody.frames[1].durationUs = 220000;
    f.store.clipDrafts.write(f.pid, human.documentId, { expectedDocumentRevision: human.documentRevision, text: JSON.stringify(humanBody) });
    releaseInterrupt(); assert.equal((await handingOff).statusCode, 200);
    assert.equal(JSON.parse(f.store.clipDrafts.read(f.pid, human.documentId).text).frames[1].durationUs, 220000);
    assert.equal(f.store.clipDrafts.read(f.pid, draft.documentId).draft.status, "editing");
  } finally { await f.cleanup(); }
});

test("draft-only contexts freeze unsaved full body, provide transformed pixels/hashes, and derive without overwriting human text", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(), human = f.store.clipDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision }, "human");
    const body = JSON.parse(human.text); body.frames.reverse(); body.frames[0].durationUs = 190000; body.frames[0].transform = { scale: 0.5, offsetX: 0, offsetY: 0, clip: false };
    const edited = f.store.clipDrafts.write(f.pid, human.documentId, { expectedDocumentRevision: human.documentRevision, text: JSON.stringify(body) });
    const context = { mode: "draft", draftId: human.documentId, documentRevision: edited.documentRevision };
    let task = await f.create({ target: context });
    assert.notEqual(task.target!.snapshotId, human.draft.baseSnapshotId);
    const frozen = f.store.animation.snapshot(f.pid, task.target!.snapshotId!); assert.equal(frozen.clip.frames[0]!.id, body.frames[0].id); assert.equal(frozen.clip.frames[0]!.durationUs, 190000);
    const session = await f.begin(task, context, "明确生成一张参考方向图，保留人工草稿编排");
    const input = f.runtimes[0]!.calls.find(c => c.method === "turn/start")!.input.input;
    const actualPath = input.find((item: any) => item.type === "localImage").path;
    const actualHash = sha256(readFileSync(actualPath)); assert.notEqual(actualHash, f.image.contentHash); assert.ok(session.workflowReferenceHashes!.includes(actualHash));
    const generated = await f.generate(task); task = f.store.tasks.get(f.pid, task.id);
    assert.equal(task.attempts[0]!.referenceEvidence?.verified, true); assert.ok(task.attempts[0]!.referenceEvidence!.expectedHashes.includes(actualHash));
    // Frozen draft snapshot itself is also a legitimate direction material.
    const direction = await f.api(`${f.taskPath(task.id)}/direction`, { expectedRevision: task.revision, accept: true, snapshotId: task.target!.snapshotId });
    assert.equal(direction.statusCode, 200, direction.body); await waitFor(() => f.runtimes.length === 2 && session.status === "running");
    await assert.rejects(f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision }), /派生/);
    const derived = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision, fromDraftId: human.documentId, expectedFromDocumentRevision: edited.documentRevision }));
    assert.deepEqual(JSON.parse(derived.text), JSON.parse(edited.text)); assert.notEqual(derived.documentId, human.documentId);
    const next = JSON.parse(derived.text); next.frames[1].durationUs = 240000;
    const written = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: derived.documentId, expectedDocumentRevision: derived.documentRevision, text: JSON.stringify(next) }] }))[0];
    const saved = result(await f.hub.tool(session.id, "save_clip_draft", { draftId: derived.documentId, documentRevision: written.documentRevision }));
    assert.equal(saved.saved, false); assert.equal(saved.delivered, true); assert.equal(saved.pendingHumanAdoption, true);
    const proposal = f.store.animation.snapshot(f.pid, saved.delivery.snapshotId);
    assert.equal(proposal.clip.frames[0]!.durationUs, 190000); assert.equal(proposal.clip.frames[1]!.durationUs, 240000);
    assert.equal(f.store.animation.clip(f.pid, clip.id).revision, clip.revision);
    assert.equal(f.store.clipDrafts.read(f.pid, human.documentId).text, edited.text);
    assert.equal(f.store.generated.record(f.pid, generated.id).sessionId, session.id);
  } finally { await f.cleanup(); }
});

test("human source edits during render block late Agent save even without a task", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(), human = f.store.clipDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision }, "human"), session = f.store.createSession(f.pid);
    f.hub.send(session.id, "修改草稿", [], randomUUID(), undefined, [], undefined, undefined, { mode: "draft", draftId: human.documentId, documentRevision: human.documentRevision });
    await waitFor(() => session.status === "running" && session.turnId);
    const derived = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision, fromDraftId: human.documentId, expectedFromDocumentRevision: human.documentRevision }));
    const body = JSON.parse(derived.text); body.frames[0].transform = { scale: 0.6, offsetX: 0, offsetY: 0, clip: false };
    const doc = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: derived.documentId, expectedDocumentRevision: derived.documentRevision, text: JSON.stringify(body) }] }))[0];
    let release!: () => void, running = false; const gate = new Promise<void>(r => release = r), original = f.store.worker.run.bind(f.store.worker);
    f.store.worker.run = (async (command: string, input: any) => { const value = await original(command, input); if (command === "transform") { running = true; await gate; } return value; }) as any;
    const saving = f.hub.tool(session.id, "save_clip_draft", { draftId: derived.documentId, documentRevision: doc.documentRevision }); const rejected = assert.rejects(saving, /人工来源草稿/);
    await waitFor(() => running);
    const humanBody = JSON.parse(human.text); humanBody.frames[1].durationUs = 300000;
    f.store.clipDrafts.write(f.pid, human.documentId, { expectedDocumentRevision: human.documentRevision, text: JSON.stringify(humanBody) });
    release(); await rejected; assert.equal(f.store.animation.clip(f.pid, clip.id).revision, clip.revision);
  } finally { await f.cleanup(); }
});

test("local feedback and ready-task messages carry snapshot direction; fresh current checks and exact accept remain mandatory", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(); let task = await f.create({ target: { mode: "saved", clipId: clip.id } }); task = f.approveExisting(task, task.target!.snapshotId);
    const session = await f.begin(task);
    const initial = result(await f.hub.tool(session.id, "workflow_task", { action: "ready" })); assert.equal(initial.task.status, "ready");
    await (f.hub as any).notification(session, { method: "turn/completed", params: { threadId: session.threadId, turn: { id: session.turnId, status: "completed" } } });
    assert.equal(session.status, "idle"); assert.equal(f.store.tasks.get(f.pid, task.id).status, "ready", "conversation completion does not accept/finish the task");
    const originalDirection = f.store.tasks.get(f.pid, task.id).direction!.snapshotId;
    const response = await f.api(`/api/sessions/${session.id}/messages`, { requestId: randomUUID(), taskId: task.id, text: "第2帧停久一点" });
    assert.equal(response.statusCode, 202, response.body); await waitFor(() => session.status === "running" && session.turnId);
    task = f.store.tasks.get(f.pid, task.id); assert.equal(task.phase, "production"); assert.equal(task.direction!.snapshotId, originalDirection); assert.equal(task.intentVersion, initial.task.intentVersion + 1);
    assert.throws(() => f.store.tasks.action(f.pid, task.id, { action: "ready", expectedRevision: task.revision, snapshotId: initial.snapshot.id }), /检查/);
    const draft = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision }));
    const body = JSON.parse(draft.text); body.frames[1].durationUs = 250000;
    const doc = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(body) }] }))[0];
    await f.hub.tool(session.id, "save_clip_draft", { draftId: draft.documentId, documentRevision: doc.documentRevision });
    const checked = result(await f.hub.tool(session.id, "workflow_task", { action: "ready" })); assert.equal(checked.task.status, "ready");
    const accepted = await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: checked.task.revision, action: "accept", snapshotId: checked.snapshot.id }); assert.equal(accepted.statusCode, 200, accepted.body);
    const current = f.store.animation.clip(f.pid, clip.id);
    f.store.updateClip(f.pid, clip.id, { revision: current.revision, frames: current.frames.map((frame, i) => i ? { ...frame, durationUs: 270000 } : frame), loop: current.loop });
    const stale = f.store.tasks.get(f.pid, task.id); assert.equal(stale.status, "blocked"); assert.equal(stale.acceptanceHistory.length, 1);
  } finally { await f.cleanup(); }
});

test("known renderer overflow is failed and cannot be self-reported passed or ready", async () => {
  const f = await fixture();
  try {
    let clip = f.clip(); clip = f.store.updateClip(f.pid, clip.id, { revision: clip.revision, frames: clip.frames.map((frame, i) => i ? frame : { ...frame, transform: { scale: 2, offsetX: 60, offsetY: 0, clip: false } }), loop: clip.loop });
    let task = await f.create({ target: { mode: "saved", clipId: clip.id } }); task = f.approveExisting(task, task.target!.snapshotId);
    const session = await f.begin(task);
    const inputs = f.runtimes.at(-1)!.calls.find(call => call.method === "turn/start")!.input.input;
    const visualNotice = inputs.find((input: any) => input.type === "text" && input.text.includes("诊断preview"));
    assert.match(visualNotice.text, /"blocking":true/); assert.match(visualNotice.text, /可能被画布截断/);
    const actualInput = inputs.find((input: any) => input.type === "localImage"); assert.ok(actualInput);
    assert.ok(session.workflowReferenceHashes!.includes(sha256(readFileSync(actualInput.path))));
    const check = result(await f.hub.tool(session.id, "workflow_task", { action: "check" })); assert.equal(check.checks[0].status, "failed"); assert.ok(check.checks[0].findings.some((finding: any) => /越界/.test(finding.message)));
    await assert.rejects(f.hub.tool(session.id, "workflow_task", { action: "ready", passed: true }), /Unrecognized|未识别|key/);
    const ready = await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: check.task.revision, action: "ready", snapshotId: check.snapshot.id }); assert.equal(ready.statusCode, 409); assert.match(ready.body, /失败/);
    assert.equal((await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "accept", snapshotId: check.snapshot.id })).statusCode, 409);
    const draft = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision }));
    const repaired = JSON.parse(draft.text); repaired.frames[0].transform = { scale: 0.5, offsetX: 0, offsetY: 0, clip: false };
    const edited = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(repaired) }] }))[0];
    await f.hub.tool(session.id, "save_clip_draft", { draftId: draft.documentId, documentRevision: edited.documentRevision });
    assert.equal(result(await f.hub.tool(session.id, "workflow_task", { action: "ready" })).task.status, "ready");
  } finally { await f.cleanup(); }
});

test("multi-Review consumers use sequence dependencies and report every batch/edge; new references block deletion", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(18); let task = await f.create({ target: { mode: "saved", clipId: clip.id } }); task = f.approveExisting(task, task.target!.snapshotId);
    const session = await f.begin(task);
    const definition = result(await f.hub.tool(session.id, "review_sequence", { action: "create", definition: { requestId: randomUUID(), name: "all-actions", loop: true, segments: [{ id: randomUUID(), clipId: clip.id, repeat: 2, speed: 1 }] } }));
    const reviewResult = await f.hub.tool(session.id, "review_sequence", { action: "inspect", sequenceId: definition.id }); const inspected = result(reviewResult);
    assert.equal(inspected.coverage.totalFrames, 36); assert.equal(inspected.coverage.complete, true); assert.equal(inspected.reviews.length, 3); assert.equal(reviewResult.content.filter((i: any) => i.type === "image").length, 6); assert.ok(inspected.coverage.boundaries.every((b: any) => b.covered));
    const all = f.store.state(f.pid).reviews; assert.equal(all.length, 3); assert.ok(all.every(r => r.stale === false));
    for (const r of all) { assert.equal(f.store.animation.review(f.pid, r.id).stale, false); assert.ok(f.store.animation.evidence(f.pid, r.id, "contact")); }
    const plan = f.store.library.planDelete(f.pid, { assetIds: [clip.id, f.image.id], folders: [] }); assert.ok(plan.blockers.some(b => /Review/.test(b.reason))); assert.ok(plan.blockers.some(b => /任务/.test(b.reason)));
    await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "handoff" });
    f.store.updateClip(f.pid, clip.id, { revision: clip.revision, frames: clip.frames.map((frame, i) => i ? frame : { ...frame, durationUs: 120000 }), loop: clip.loop });
    const snapshots = await f.api(`/api/projects/${f.pid}/review-sequences/${definition.id}/snapshots`); assert.equal(snapshots.json()[0].stale, true);
    assert.ok(f.store.state(f.pid).reviews.every(r => r.stale)); assert.ok(all.every(r => f.store.animation.review(f.pid, r.id).stale));
    const fixed = f.store.animation.snapshot(f.pid, inspected.snapshotId); assert.equal(fixed.clip.frames[0]!.durationUs, 100000); assert.ok((await f.store.animation.renderFrame(f.pid, fixed.id, fixed.clip.frames[0]!.id)).path);
    const boundaryDefinition = await f.api(`/api/projects/${f.pid}/review-sequences`, { requestId: randomUUID(), name: "stable-boundary", loop: false, segments: [{ id: randomUUID(), clipId: clip.id, startFrameId: clip.frames[0]!.id, endFrameId: clip.frames[1]!.id }] }); assert.equal(boundaryDefinition.statusCode, 200);
    const current = f.store.animation.clip(f.pid, clip.id); f.store.updateClip(f.pid, clip.id, { revision: current.revision, frames: current.frames.slice(1), loop: current.loop });
    const definitions = await f.api(`/api/projects/${f.pid}/review-sequences`); assert.ok(definitions.json().find((d: any) => d.id === boundaryDefinition.json().id).unresolved.length);
    assert.equal((await f.api(`/api/projects/${f.pid}/review-sequences/${boundaryDefinition.json().id}/capture`, {})).statusCode, 409);
  } finally { await f.cleanup(); }
});

test("HTTP validates project/source/session/version, source derivation CAS, and task creation returns one stable idle session", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(), other = f.store.createProject("other").id;
    const input = { requestId: randomUUID(), title: "idempotent", description: "offline", target: { mode: "saved", clipId: clip.id } };
    const first = await f.api(`/api/projects/${f.pid}/tasks`, input), repeated = await f.api(`/api/projects/${f.pid}/tasks`, input);
    assert.equal(first.statusCode, 200); assert.equal(first.json().sessionId, repeated.json().sessionId); assert.equal(f.runtimes.length, 0); assert.equal(f.store.session(first.json().sessionId).status, "idle");
    const task = first.json();
    assert.equal((await f.api(`/api/projects/${other}/tasks/${task.id}/actions`, { expectedRevision: task.revision, action: "handoff" })).statusCode, 404);
    assert.equal((await f.api(`/api/projects/${other}/snapshots/${task.target.snapshotId}`)).statusCode, 404);
    const human = await f.api(`/api/projects/${f.pid}/clip-drafts`, { clipId: clip.id, revision: clip.revision, source: "human" }); assert.equal(human.statusCode, 200);
    const doc = human.json();
    assert.equal((await f.api(`/api/projects/${other}/clip-drafts/${doc.documentId}`)).statusCode, 404);
    assert.equal((await f.api(`/api/projects/${f.pid}/clip-drafts`, { clipId: clip.id, revision: clip.revision, source: "agent" })).statusCode, 400);
    assert.equal((await f.api(`/api/projects/${f.pid}/clip-drafts`, { clipId: clip.id, revision: clip.revision, fromDraftId: doc.documentId, expectedFromDocumentRevision: "stale" })).statusCode, 409);
    const body = JSON.parse(doc.text); body.frames[1].durationUs = 210000;
    const put = await f.api(`/api/projects/${f.pid}/clip-drafts/${doc.documentId}`, { expectedDocumentRevision: doc.documentRevision, text: JSON.stringify(body) }, "PUT"); assert.equal(put.statusCode, 200);
    assert.equal((await f.api(`/api/projects/${f.pid}/clip-drafts/${doc.documentId}/preview`, { documentRevision: doc.documentRevision })).statusCode, 409);
    const legacy = f.store.frameDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision, frameId: clip.frames[0]!.id }, "human");
    assert.equal((await f.api(`/api/projects/${f.pid}/clip-drafts`, { clipId: clip.id, revision: clip.revision, fromDraftId: legacy.documentId, expectedFromDocumentRevision: "stale" })).statusCode, 409);
    const otherSession = f.store.createSession(other);
    assert.equal((await f.api(`/api/sessions/${otherSession.id}/messages`, { requestId: randomUUID(), text: "cross", taskId: task.id })).statusCode, 404);
    assert.equal((await f.api(`/api/sessions/${task.sessionId}/messages`, { requestId: randomUUID(), text: "bad draft", context: { mode: "draft", draftId: doc.documentId } })).statusCode, 400);
    const sequence = await f.api(`/api/projects/${f.pid}/review-sequences`, { requestId: randomUUID(), name: "sequence", loop: true, segments: [{ id: randomUUID(), clipId: clip.id }] }); assert.equal(sequence.statusCode, 200);
    assert.equal((await f.api(`/api/projects/${other}/review-sequences/${sequence.json().id}/snapshots`)).statusCode, 404);
    const capture = await f.api(`/api/projects/${f.pid}/review-sequences/${sequence.json().id}/capture`, {}); assert.equal(capture.statusCode, 200);
    const inspect = await f.api(`/api/projects/${f.pid}/review-sequences/${sequence.json().id}/inspect`, { snapshotId: capture.json().id }); assert.equal(inspect.statusCode, 200);
    const discard = await f.api(`/api/projects/${f.pid}/clip-drafts/${doc.documentId}/discard`, { documentRevision: put.json().documentRevision }); assert.equal(discard.statusCode, 200);
    assert.throws(() => f.store.deleteSession(task.sessionId), /绑定/);
  } finally { await f.cleanup(); }
});

test("new tools inherit old deny/ask policies, and MCP inventory exactly matches host permissions", async () => {
  const f = await fixture();
  try {
    const originalNames = ["save_image", "create_clip", "write_documents", "slice_sheet", "adjust_image", "create_frame_draft", "save_frame_draft", "list_assets", "list_generated_images", "view_image", "get_schema", "read_document", "validate_document", "inspect_clip"];
    for (const name of originalNames) assert.equal((defaultToolPolicies as any)[name], name === "save_image" ? "ask" : "allow");
    const clip = f.clip(); let task = await f.create({ target: { mode: "saved", clipId: clip.id } }); task = f.approveExisting(task, task.target!.snapshotId); const session = await f.begin(task);
    f.store.permissions.write({ create_frame_draft: "deny", create_clip_draft: "allow" });
    assert.equal((await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision })).isError, true); assert.equal(f.store.clipDrafts.list(f.pid).length, 0);
    f.store.permissions.write({ create_frame_draft: "ask" });
    const pending = f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision }); await waitFor(() => session.toolApproval); f.hub.resolveToolApproval(session.id, session.toolApproval!.id, true); const draft = result(await pending);
    f.store.permissions.write({ save_frame_draft: "deny", save_clip_draft: "allow", inspect_clip: "deny", workflow_task: "allow" });
    assert.equal((await f.hub.tool(session.id, "save_clip_draft", { draftId: draft.documentId, documentRevision: draft.documentRevision })).isError, true);
    assert.equal((await f.hub.tool(session.id, "workflow_task", { action: "check" })).isError, true); assert.equal(f.store.tasks.get(f.pid, task.id).checks.length, 0);
    assert.equal((await f.hub.tool(session.id, "review_sequence", { action: "inspect", sequenceId: randomUUID() })).isError, true);
    const child = spawn(process.execPath, ["studio/mcp.ts", "http://127.0.0.1:9999", session.id], { env: { ...process.env, SPRITE_STUDIO_TOOL_TOKEN: "fixture-only" }, windowsHide: true });
    const lines = createInterface({ input: child.stdout }); const received: any[] = []; lines.on("line", line => received.push(JSON.parse(line)));
    try {
      child.stdin.write(JSON.stringify({ id: 1, method: "tools/list" }) + "\n"); await waitFor(() => received.length);
      assert.deepEqual(received[0].result.tools.map((tool: any) => tool.name).sort(), permissionTools.map(tool => tool.name).sort());
    } finally { child.kill(); lines.close(); }
  } finally { await f.cleanup(); }
});

test("active human writes require backend handoff, while accepted-stale history permits consecutive manual saves", async () => {
  const f = await fixture();
  try {
    let clip = f.clip();
    const human = f.store.clipDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision }, "human");
    const body = JSON.parse(human.text); body.frames[0].durationUs = 170000;
    const edited = f.store.clipDrafts.write(f.pid, human.documentId, { expectedDocumentRevision: human.documentRevision, text: JSON.stringify(body) });
    let task = await f.create({ target: { mode: "saved", clipId: clip.id } }); task = f.approveExisting(task, task.target!.snapshotId);
    const session = await f.begin(task);
    assert.equal((await f.api(`/api/projects/${f.pid}/clip-drafts/${human.documentId}/save`, { documentRevision: edited.documentRevision })).statusCode, 409);
    assert.equal((await f.api(`/api/projects/${f.pid}/clip-drafts/${human.documentId}`, { expectedDocumentRevision: edited.documentRevision, text: edited.text }, "PUT")).statusCode, 409);
    assert.throws(() => f.store.updateClip(f.pid, clip.id, { revision: clip.revision, frames: clip.frames, loop: clip.loop }), /handoff/);
    const direct = f.store.documents.read(f.pid, clip.id);
    assert.throws(() => f.store.documents.write(f.pid, [{ documentId: clip.id, expectedDocumentRevision: direct.documentRevision, text: direct.text }]), /handoff/);
    assert.equal((await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: task.revision, action: "handoff" })).statusCode, 200);
    const saved = await f.api(`/api/projects/${f.pid}/clip-drafts/${human.documentId}/save`, { documentRevision: edited.documentRevision }); assert.equal(saved.statusCode, 200, saved.body);
    task = f.store.tasks.get(f.pid, task.id);
    await f.hub.taskAction(f.pid, task.id, { expectedRevision: task.revision, action: "resume" });
    await f.begin(f.store.tasks.get(f.pid, task.id));
    const ready = result(await f.hub.tool(session.id, "workflow_task", { action: "ready" }));
    const accepted = await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: ready.task.revision, action: "accept", snapshotId: ready.snapshot.id }); assert.equal(accepted.statusCode, 200, accepted.body);
    for (const durationUs of [230000, 280000]) {
      clip = f.store.animation.clip(f.pid, clip.id);
      const draft = await f.api(`/api/projects/${f.pid}/clip-drafts`, { clipId: clip.id, revision: clip.revision, source: "human" }); assert.equal(draft.statusCode, 200, draft.body);
      const document = draft.json(), value = JSON.parse(document.text); value.frames[1].durationUs = durationUs;
      const put = await f.api(`/api/projects/${f.pid}/clip-drafts/${document.documentId}`, { expectedDocumentRevision: document.documentRevision, text: JSON.stringify(value) }, "PUT"); assert.equal(put.statusCode, 200, put.body);
      const save = await f.api(`/api/projects/${f.pid}/clip-drafts/${document.documentId}/save`, { documentRevision: put.json().documentRevision }); assert.equal(save.statusCode, 200, save.body);
      assert.equal(f.store.tasks.get(f.pid, task.id).status, "blocked");
    }
    assert.equal(f.store.tasks.get(f.pid, task.id).acceptanceHistory.length, 1);
    assert.equal(f.store.tasks.protectsSession(f.pid, session.id), false, "expired accepted history is not an active session lease");
    await (f.hub as any).notification(session, { method: "turn/completed", params: { threadId: session.threadId, turn: { id: session.turnId, status: "completed" } } });
    const continueMessage = await f.api(`/api/sessions/${session.id}/messages`, { requestId: randomUUID(), taskId: task.id, text: "继续调整下一帧" }); assert.equal(continueMessage.statusCode, 202, continueMessage.body);
    await waitFor(() => session.status === "running" && session.turnId);
    assert.equal(f.store.tasks.get(f.pid, task.id).phase, "production"); assert.equal(f.store.tasks.get(f.pid, task.id).acceptanceHistory.length, 1);
  } finally { await f.cleanup(); }
});

test("in-flight human save rechecks backend ownership after a task starts", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(), human = f.store.clipDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision }, "human");
    const body = JSON.parse(human.text); body.frames[0].transform = { scale: 0.5, offsetX: 0, offsetY: 0, clip: false };
    const edited = f.store.clipDrafts.write(f.pid, human.documentId, { expectedDocumentRevision: human.documentRevision, text: JSON.stringify(body) });
    let release!: () => void, rendering = false;
    const gate = new Promise<void>(resolve => release = resolve), original = f.store.worker.run.bind(f.store.worker);
    f.store.worker.run = (async (command: string, input: any) => { const value = await original(command, input); if (command === "transform") { rendering = true; await gate; } return value; }) as any;
    const saving = f.api(`/api/projects/${f.pid}/clip-drafts/${human.documentId}/save`, { documentRevision: edited.documentRevision });
    await waitFor(() => rendering);
    const task = await f.create({ target: { mode: "saved", clipId: clip.id } }); await f.begin(task);
    release(); const response = await saving; assert.equal(response.statusCode, 409, response.body); assert.match(response.body, /handoff/);
    assert.equal(f.store.animation.clip(f.pid, clip.id).revision, clip.revision);
  } finally { await f.cleanup(); }
});

test("pause/stop/handoff and typed local/direction feedback invalidate task approvals/queues before interrupt and keep exact draft", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(); f.store.permissions.write({ save_clip_draft: "ask" });
    for (const action of ["pause", "stop", "handoff", "local", "direction"] as const) {
      let task = await f.create({ target: { mode: "saved", clipId: clip.id } }); task = f.approveExisting(task, task.target!.snapshotId); const session = await f.begin(task);
      const draft = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision }));
      const value = JSON.parse(draft.text); value.frames[0].durationUs = 180000;
      const doc = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(value) }] }))[0];
      const waiting = f.hub.tool(session.id, "save_clip_draft", { draftId: draft.documentId, documentRevision: doc.documentRevision });
      const queued = f.hub.tool(session.id, "list_assets", {}), rejectedQueue = assert.rejects(queued, /任务已取消|失效/);
      await waitFor(() => session.toolApproval);
      let release!: () => void; f.runtimes.at(-1)!.interruptGate = new Promise<void>(resolve => release = resolve);
      const acting = f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: action === "local" || action === "direction" ? "feedback" : action, ...(action === "local" || action === "direction" ? { feedbackKind: action, text: "explicit correction" } : {}) });
      await waitFor(() => f.runtimes.at(-1)!.calls.some(call => call.method === "turn/interrupt"));
      assert.ok(session.toolApproval, "old model is interrupted before its blocked callback is released");
      release(); assert.equal((await acting).statusCode, 200); assert.equal((await waiting).isError, true); await rejectedQueue;
      assert.equal(f.store.animation.clip(f.pid, clip.id).revision, clip.revision); assert.equal(f.store.clipDrafts.read(f.pid, draft.documentId).text, doc.text);
      const after = f.store.tasks.get(f.pid, task.id);
      assert.equal(after.phase, action === "direction" ? "direction" : "production");
      if (action === "local") { assert.ok(after.direction?.accept); assert.equal(after.status, "running"); }
    }
  } finally { await f.cleanup(); }
});

test("failed real draft repairs record exact evidence and stop after two new no-progress bodies; previews cannot satisfy ready", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(); let task = await f.create({ target: { mode: "saved", clipId: clip.id } }); task = f.approveExisting(task, task.target!.snapshotId); const session = await f.begin(task);
    let draft = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision }));
    for (const durationUs of [110000, 120000, 130000]) {
      const body = JSON.parse(draft.text); body.frames[0].durationUs = durationUs; body.frames[0].transform = { scale: 2, offsetX: 120, offsetY: 0, clip: false };
      draft = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(body) }] }))[0];
      await assert.rejects(f.hub.tool(session.id, "save_clip_draft", { draftId: draft.documentId, documentRevision: draft.documentRevision }), /超出画布/);
    }
    task = f.store.tasks.get(f.pid, task.id); assert.equal(task.repairRounds!.length, 2); assert.ok(task.repairRounds!.every(round => round.improved === false));
    assert.ok(task.checks.some(check => check.draftId === draft.documentId && check.status === "failed"));
    assert.equal(f.store.animation.clip(f.pid, clip.id).revision, clip.revision);
    const body = JSON.parse(draft.text); body.frames[0].durationUs = 140000;
    await assert.rejects(f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(body) }] }), /no-progress/);
    await assert.rejects(f.hub.tool(session.id, "workflow_task", { action: "ready" }), /未保存/);
    assert.throws(() => f.store.tasks.action(f.pid, task.id, { expectedRevision: task.revision, action: "ready", snapshotId: task.checks.at(-1)!.snapshotId }), /已保存/);
  } finally { await f.cleanup(); }
});

test("composite direction claims its frozen approval once and revalidates after interrupt", async () => {
  const f = await fixture();
  try {
    let task = await f.create(); const session = await f.begin(task), generated = await f.generate(task);
    const save = f.hub.tool(session.id, "save_image", { generatedId: generated.id, type: "resource", name: "frozen", requestId: randomUUID() }); await waitFor(() => session.toolApproval);
    task = f.store.tasks.get(f.pid, task.id); const approval = session.toolApproval!, input = { expectedRevision: task.revision, accept: true, generatedId: generated.id, toolApproval: { sessionId: session.id, approvalId: approval.id } };
    let release!: () => void; f.runtimes[0]!.interruptGate = new Promise<void>(resolve => release = resolve);
    const deciding = f.api(`${f.taskPath(task.id)}/direction`, input);
    await waitFor(() => f.runtimes[0]!.calls.some(call => call.method === "turn/interrupt"));
    assert.throws(() => f.hub.resolveToolApproval(session.id, approval.id, false, "late second click"), /正在提交/);
    assert.equal((await f.api(`${f.taskPath(task.id)}/direction`, input)).statusCode, 409);
    approval.arguments.name = "tampered frozen card";
    release(); const response = await deciding; assert.equal(response.statusCode, 409, response.body); assert.equal((await save).isError, true);
    assert.equal(f.store.tasks.get(f.pid, task.id).direction, undefined); assert.equal(f.store.assets(f.pid).length, 1); assert.equal(f.store.generated.list(f.pid).length, 1);
  } finally { await f.cleanup(); }
});

test("production fails closed if runtime cannot confirm native generation disabled; unexpected generation stays unknown", async () => {
  const f = await fixture();
  try {
    let task = await f.create({ contract: { generationLimit: 0 } }); task = f.approveExisting(task);
    (f.hub as any).createRuntime = (_workspace: string, overrides: string[]) => { const runtime = new StubRuntime(overrides); runtime.configReportsDisabled = false; f.runtimes.push(runtime); return runtime; };
    const response = await f.api(`/api/sessions/${task.sessionId}/messages`, { requestId: randomUUID(), taskId: task.id, text: "continue deterministic production" }); assert.equal(response.statusCode, 202);
    await waitFor(() => f.store.session(task.sessionId!).status === "failed");
    assert.equal(f.store.tasks.get(f.pid, task.id).waitReason, "capability"); assert.ok(!f.runtimes[0]!.calls.some(call => call.method === "turn/start"));
    assert.equal(f.store.generated.list(f.pid).length, 0);
    assert.equal((await f.api(`/api/projects/${f.pid}/tasks`, { requestId: randomUUID(), title: "no expansion", description: "x", contract: { generationLimit: 3 } })).statusCode, 400);
  } finally { await f.cleanup(); }
  const g = await fixture();
  try {
    let task = await g.create(); task = g.approveExisting(task); const session = await g.begin(task);
    await g.emit(session.id, "item/started", { id: "unexpected", type: "imageGeneration", status: "inProgress" });
    await g.emit(session.id, "item/completed", { id: "unexpected", type: "imageGeneration", status: "completed", savedPath: g.sourcePath });
    await Promise.all(g.hub.imports.get(session.id) || []);
    const current = g.store.tasks.get(g.pid, task.id); assert.equal(current.status, "paused"); assert.equal(current.attempts[0]!.status, "unknown"); assert.equal(current.attempts[0]!.preflightVerified, false); assert.ok(current.attempts[0]!.generatedId);
    assert.equal(g.store.assets(g.pid).length, 1); assert.equal(g.runtimes.length, 1);
  } finally { await g.cleanup(); }
});

test("task range cannot modify outsiders or bind unrelated clips; multi-document draft writes preserve global instance identity", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(3); let task = await f.create({ target: { mode: "saved", clipId: clip.id }, contract: { scope: { clipId: clip.id, startFrameId: clip.frames[1]!.id, endFrameId: clip.frames[1]!.id } } }); task = f.approveExisting(task, task.target!.snapshotId); const session = await f.begin(task);
    const draft = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision })); const body = JSON.parse(draft.text); body.frames[0].durationUs = 180000;
    await assert.rejects(f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(body) }] }), /区间/);
    await assert.rejects(f.hub.tool(session.id, "create_clip", { name: "unrelated", requestId: randomUUID() }), /已经绑定/);
    assert.equal(f.store.assets(f.pid).filter(asset => asset.type === "clip").length, 1);
    const otherSession = f.store.createSession(f.pid), a = f.store.documents.createClip(f.pid, { name: "A", fps: 12, requestId: randomUUID() }), b = f.store.documents.createClip(f.pid, { name: "B", fps: 12, requestId: randomUUID() });
    const da = f.store.clipDrafts.create(f.pid, { clipId: a.id, revision: a.revision }, "agent", otherSession.id), db = f.store.clipDrafts.create(f.pid, { clipId: b.id, revision: b.revision }, "agent", otherSession.id), frameId = randomUUID();
    const documents = [da, db].map(document => { const value = JSON.parse(document.text); value.frames = [{ id: frameId, imageId: f.image.id, durationUs: 100000 }]; return { documentId: document.documentId, expectedDocumentRevision: document.documentRevision, text: JSON.stringify(value) }; });
    assert.throws(() => f.store.documents.write(f.pid, documents), /不同动画/);
    assert.equal(f.store.clipDrafts.read(f.pid, da.documentId).documentRevision, da.documentRevision); assert.equal(f.store.clipDrafts.read(f.pid, db.documentId).documentRevision, db.documentRevision);
  } finally { await f.cleanup(); }
});

test("late direction-runtime startup cannot overwrite the resumed production connection", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(); let task = await f.create({ target: { mode: "saved", clipId: clip.id } }); task = f.approveExisting(task, task.target!.snapshotId);
    let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
    (f.hub as any).createRuntime = (_workspace: string, overrides: string[]) => {
      const runtime = new StubRuntime(overrides), original = runtime.request.bind(runtime);
      if (!f.runtimes.length) runtime.request = async (method, input) => {
        const value = await original(method, input);
        if (method === "thread/start") { await gate; return { thread: { id: "obsolete-thread" }, model: input.model }; }
        return value;
      };
      f.runtimes.push(runtime); return runtime;
    };
    const first = await f.api(`/api/sessions/${task.sessionId}/messages`, { requestId: randomUUID(), text: "start", taskId: task.id }); assert.equal(first.statusCode, 202);
    await waitFor(() => f.runtimes[0]?.calls.some(call => call.method === "thread/start"));
    await f.hub.taskAction(f.pid, task.id, { expectedRevision: task.revision, action: "handoff" });
    task = await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "resume" });
    const session = await f.begin(task);
    assert.equal(f.runtimes.length, 2); assert.equal(session.threadId, "stub-thread");
    release(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(session.threadId, "stub-thread"); assert.equal(f.hub.clients.get(session.id), f.runtimes[1]); assert.equal(session.status, "running");
  } finally { await f.cleanup(); }
});

test("same-goal source renewal requires typed feedback plus exact context and never treats browsing as retarget authorization", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(), human = f.store.clipDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision }, "human");
    const originalContext = { mode: "draft", draftId: human.documentId, documentRevision: human.documentRevision };
    let task = await f.create({ target: originalContext }); task = f.approveExisting(task, task.target!.snapshotId);
    const session = await f.begin(task, originalContext);
    await f.hub.taskAction(f.pid, task.id, { expectedRevision: task.revision, action: "handoff" });
    const body = JSON.parse(human.text); body.frames[1].durationUs = 260000;
    const updated = f.store.clipDrafts.write(f.pid, human.documentId, { expectedDocumentRevision: human.documentRevision, text: JSON.stringify(body) });
    task = await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "resume" }); assert.equal(task.phase, "direction");
    const response = await f.api(`/api/sessions/${session.id}/messages`, { requestId: randomUUID(), taskId: task.id, text: "保留方向，继续新的技术参数", feedbackKind: "local", context: { mode: "draft", draftId: human.documentId, documentRevision: updated.documentRevision } });
    assert.equal(response.statusCode, 202, response.body); await waitFor(() => session.status === "running" && session.turnId);
    task = f.store.tasks.get(f.pid, task.id); assert.equal(task.phase, "production"); assert.equal(task.target!.documentRevision, updated.documentRevision); assert.ok(task.direction?.accept);
    const derived = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision, fromDraftId: human.documentId, expectedFromDocumentRevision: updated.documentRevision })); assert.equal(JSON.parse(derived.text).frames[1].durationUs, 260000);
    await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "handoff" });
    const other = f.clip(), changed = JSON.parse(updated.text); changed.frames[0].imageId = (await f.store.importImage(f.pid, "new-pixels.png", readFileSync(f.sourcePath), "image")).id;
    // Same bytes under another ID remain same source pixels, not a direction change.
    const samePixels = f.store.clipDrafts.write(f.pid, human.documentId, { expectedDocumentRevision: updated.documentRevision, text: JSON.stringify(changed) });
    task = await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "resume" });
    const retarget = await f.api(`/api/sessions/${session.id}/messages`, { requestId: randomUUID(), taskId: task.id, text: "not authorized to retarget", feedbackKind: "local", context: { mode: "saved", clipId: other.id } }); assert.equal(retarget.statusCode, 409); assert.equal(f.store.tasks.get(f.pid, task.id).target!.clipId, clip.id);
    assert.equal(f.store.clipDrafts.read(f.pid, human.documentId).documentRevision, samePixels.documentRevision);
    const differentPixels = await f.store.transform(f.pid, f.image.id, f.image.revision, { scale: 0.5 });
    const changedBody = JSON.parse(samePixels.text); changedBody.frames[0].imageId = differentPixels.id;
    const changedSource = f.store.clipDrafts.write(f.pid, human.documentId, { expectedDocumentRevision: samePixels.documentRevision, text: JSON.stringify(changedBody) });
    const nextContext = { mode: "draft", draftId: human.documentId, documentRevision: changedSource.documentRevision };
    const wrongKind = await f.api(`/api/sessions/${session.id}/messages`, { requestId: randomUUID(), taskId: task.id, text: "source changed", feedbackKind: "local", context: nextContext }); assert.equal(wrongKind.statusCode, 409); assert.match(wrongKind.body, /像素/);
    const directionChange = await f.api(`/api/sessions/${session.id}/messages`, { requestId: randomUUID(), taskId: task.id, text: "明确更改方向来源", feedbackKind: "direction", context: nextContext }); assert.equal(directionChange.statusCode, 202, directionChange.body);
    await waitFor(() => session.status === "running" && session.turnId);
    assert.equal(f.store.tasks.get(f.pid, task.id).direction, undefined); assert.equal(f.store.tasks.get(f.pid, task.id).target!.documentRevision, changedSource.documentRevision);
  } finally { await f.cleanup(); }
});

test("empty clip targets can start production but empty snapshots never count as direction or delivery evidence", async () => {
  const f = await fixture();
  try {
    const clip = f.store.documents.createClip(f.pid, { name: "empty-target", fps: 12, requestId: randomUUID() });
    let task = await f.create({ target: { mode: "saved", clipId: clip.id }, referenceIds: [f.image.id] });
    assert.equal((await f.api(`${f.taskPath(task.id)}/direction`, { expectedRevision: task.revision, accept: true, snapshotId: task.target!.snapshotId })).statusCode, 409);
    task = f.approveExisting(task); const session = await f.begin(task);
    const draft = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision })); const body = JSON.parse(draft.text); body.frames = [{ id: randomUUID(), imageId: f.image.id, durationUs: 100000 }];
    const document = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(body) }] }))[0];
    await f.hub.tool(session.id, "save_clip_draft", { draftId: draft.documentId, documentRevision: document.documentRevision });
    assert.equal(result(await f.hub.tool(session.id, "workflow_task", { action: "ready" })).task.status, "ready");
  } finally { await f.cleanup(); }
});

test("review I1: frame targets infer only that frame and explicit scopes must contain the declared selection", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(3), focus = clip.frames[1]!.id;
    let task = await f.create({ target: { mode: "saved", clipId: clip.id, frameId: focus } });
    assert.deepEqual(task.contract.scope, { clipId: clip.id, startFrameId: focus, endFrameId: focus });
    task = f.approveExisting(task, task.target!.snapshotId); const session = await f.begin(task);
    const draft = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision }));
    const outside = JSON.parse(draft.text); outside.frames[0].durationUs = 777000;
    await assert.rejects(f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(outside) }] }), /区间/);
    assert.equal(f.store.animation.clip(f.pid, clip.id).frames[0]!.durationUs, 100000);
    const inside = JSON.parse(draft.text); inside.frames[1].durationUs = 170000;
    const edited = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(inside) }] }))[0];
    await f.hub.tool(session.id, "save_clip_draft", { draftId: draft.documentId, documentRevision: edited.documentRevision });
    assert.deepEqual(f.store.animation.clip(f.pid, clip.id).frames.map(frame => frame.durationUs), [100000, 170000, 100000]);
    task = await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "feedback", feedbackKind: "local", text: "只继续选中帧" });
    assert.deepEqual(task.contract.scope, { clipId: clip.id, startFrameId: focus, endFrameId: focus });
    const range = await f.create({ target: { mode: "saved", clipId: clip.id, startFrameId: focus, endFrameId: clip.frames[2]!.id } });
    assert.deepEqual(range.contract.scope, { clipId: clip.id, startFrameId: focus, endFrameId: clip.frames[2]!.id });
    const bad = await f.api(`/api/projects/${f.pid}/tasks`, { requestId: randomUUID(), title: "bad explicit scope", description: "x", target: { mode: "saved", clipId: clip.id, frameId: focus }, contract: { scope: { clipId: clip.id, startFrameId: clip.frames[0]!.id, endFrameId: clip.frames[0]!.id } } });
    assert.equal(bad.statusCode, 409); assert.match(bad.body, /不包含/);
    const explicit = await f.create({ target: { mode: "saved", clipId: clip.id, frameId: focus }, contract: { scope: { clipId: clip.id } } });
    assert.deepEqual(explicit.contract.scope, { clipId: clip.id }, "a broader scope must be an explicit consistent contract, never inferred from frame focus");
  } finally { await f.cleanup(); }
});

test("review I2: a clean legacy draft cannot hide any dirty current-intent object draft; explicit disposal or a new intent releases it", async () => {
  for (const disposition of ["discard", "new-intent"] as const) {
    const f = await fixture();
    try {
      const clip = f.clip(); let task = await f.create({ target: { mode: "saved", clipId: clip.id } }); task = f.approveExisting(task, task.target!.snapshotId); const session = await f.begin(task);
      const draft = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision }));
      const body = JSON.parse(draft.text); body.frames[0].transform = { scale: 2, offsetX: 120, offsetY: 0, clip: false };
      const dirty = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(body) }] }))[0];
      await f.hub.tool(session.id, "inspect_clip", { draftId: draft.documentId, documentRevision: dirty.documentRevision });
      await assert.rejects(f.hub.tool(session.id, "workflow_task", { action: "ready" }), /未保存/);
      const clean = result(await f.hub.tool(session.id, "create_frame_draft", { clipId: clip.id, revision: clip.revision, frameId: clip.frames[0]!.id }));
      assert.equal(session.agentDraftId, clean.documentId); assert.notEqual(clean.documentId, dirty.documentId);
      assert.ok(f.store.tasks.get(f.pid, task.id).drafts!.some(entry => entry.draftId === dirty.documentId));
      await assert.rejects(f.hub.tool(session.id, "workflow_task", { action: "ready" }), /未保存/);
      assert.equal(f.store.clipDrafts.read(f.pid, dirty.documentId).draft.status, "editing");
      if (disposition === "discard") {
        await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "handoff" });
        assert.equal((await f.api(`/api/projects/${f.pid}/clip-drafts/${dirty.documentId}/discard`, { documentRevision: dirty.documentRevision })).statusCode, 200);
        task = await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "resume" });
      } else {
        task = await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "feedback", feedbackKind: "local", text: "新的明确局部意图，不采用上一轮未保存成果" });
        assert.equal(f.store.clipDrafts.read(f.pid, dirty.documentId).draft.readOnly, true);
        assert.equal(f.store.clipDrafts.read(f.pid, dirty.documentId).text, dirty.text);
      }
      await f.begin(task);
      await f.hub.tool(session.id, "create_frame_draft", { clipId: clip.id, revision: clip.revision, frameId: clip.frames[0]!.id });
      assert.equal(result(await f.hub.tool(session.id, "workflow_task", { action: "ready" })).task.status, "ready");
    } finally { await f.cleanup(); }
  }
});

test("review I4: stopped-task Agent drafts release leases without deleting their text or captured pixels", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(), extra = await f.store.importImage(f.pid, "extra.png", readFileSync(f.sourcePath), "image");
    let task = await f.create({ target: { mode: "saved", clipId: clip.id }, referenceIds: [extra.id] }); task = f.approveExisting(task, task.target!.snapshotId); const session = await f.begin(task);
    let draft = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision }));
    let body = JSON.parse(draft.text); body.frames[0].imageId = extra.id;
    draft = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(body) }] }))[0];
    body = JSON.parse(draft.text); body.frames[0].imageId = f.image.id; body.frames[0].durationUs = 160000;
    draft = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(body) }] }))[0];
    const review = result(await f.hub.tool(session.id, "inspect_clip", { draftId: draft.documentId, documentRevision: draft.documentRevision }));
    const beforePixels = readFileSync((await f.store.animation.renderFrame(f.pid, review.snapshotId, clip.frames[0]!.id)).path);
    assert.equal((await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "stop" })).statusCode, 200);
    const historical = f.store.clipDrafts.read(f.pid, draft.documentId); assert.equal(historical.draft.status, "editing"); assert.equal(historical.draft.readOnly, true); assert.equal(historical.text, draft.text);
    assert.equal(f.store.assets(f.pid).length, 3, "stop itself never deletes user assets");
    const selection = { assetIds: [clip.id, f.image.id, extra.id], folders: [] };
    assert.deepEqual(f.store.library.planDelete(f.pid, selection).blockers, []);
    f.store.library.delete(f.pid, selection, f.store.library.revision(f.pid));
    assert.equal(f.store.clipDrafts.read(f.pid, draft.documentId).text, draft.text); assert.equal(f.store.tasks.get(f.pid, task.id).status, "stopped");
    const attemptedWrite = await f.api(`/api/projects/${f.pid}/clip-drafts/${draft.documentId}`, { expectedDocumentRevision: draft.documentRevision, text: draft.text }, "PUT"); assert.equal(attemptedWrite.statusCode, 409); assert.match(attemptedWrite.body, /只读历史/);
    assert.deepEqual(readFileSync((await f.store.animation.renderFrame(f.pid, review.snapshotId, clip.frames[0]!.id)).path), beforePixels);
    assert.ok(f.store.animation.evidence(f.pid, review.id, "contact"));
  } finally { await f.cleanup(); }
});

test("review I4: reversible Review archive releases the last definition lease, enforces CAS/permissions and preserves history", async () => {
  const f = await fixture();
  try {
    const clip = f.clip();
    let definition = f.store.reviewSequences.create(f.pid, { requestId: randomUUID(), name: "last definition", loop: true, segments: [{ id: randomUUID(), clipId: clip.id }] });
    const captured = f.store.reviewSequences.capture(f.pid, definition.id), inspected = await f.store.reviewSequences.inspect(f.pid, definition.id, { snapshotId: captured.id });
    const task = await f.create({ target: { mode: "saved", clipId: clip.id }, contract: taskReviewContract(definition.id, [definition]) });
    const archivePath = `/api/projects/${f.pid}/review-sequences/${definition.id}/archive`;
    assert.equal((await f.api(archivePath, { expectedRevision: definition.revision, archived: true })).statusCode, 409);
    await f.hub.taskAction(f.pid, task.id, { expectedRevision: task.revision, action: "stop" });
    const response = await f.api(archivePath, { expectedRevision: definition.revision, archived: true }); assert.equal(response.statusCode, 200, response.body);
    const oldRevision = definition.revision; definition = response.json(); assert.equal(definition.archived, true);
    assert.equal(f.store.reviewSequences.listSnapshots(f.pid, definition.id)[0]!.stale, false, "archive is not a visual-content change");
    assert.equal((await f.api(`/api/projects/${f.pid}/review-sequences/${definition.id}/capture`, {})).statusCode, 409);
    assert.equal((await f.api(`/api/projects/${f.pid}/review-sequences/${definition.id}/inspect`, { snapshotId: captured.id })).statusCode, 200);
    assert.equal((await f.api(archivePath, { expectedRevision: oldRevision, archived: false })).statusCode, 409);
    const other = f.store.createProject("archive cross-project").id;
    assert.equal((await f.api(`/api/projects/${other}/review-sequences/${definition.id}/archive`, { expectedRevision: definition.revision, archived: false })).statusCode, 404);
    const session = f.store.createSession(f.pid);
    f.hub.send(session.id, "明确恢复Review定义", [], randomUUID()); await waitFor(() => session.status === "running" && session.turnId);
    f.store.permissions.write({ write_documents: "deny", review_sequence: "allow" });
    assert.equal((await f.hub.tool(session.id, "review_sequence", { action: "archive", sequenceId: definition.id, expectedRevision: definition.revision, archived: false })).isError, true);
    f.store.permissions.write({ write_documents: "ask" });
    const restoring = f.hub.tool(session.id, "review_sequence", { action: "archive", sequenceId: definition.id, expectedRevision: definition.revision, archived: false });
    await waitFor(() => session.toolApproval); f.hub.resolveToolApproval(session.id, session.toolApproval!.id, true); definition = result(await restoring); assert.equal(definition.archived, false);
    assert.ok(f.store.library.planDelete(f.pid, { assetIds: [clip.id], folders: [] }).blockers.some(blocker => /Review/.test(blocker.reason)));
    await f.hub.stop(session.id);
    definition = (await f.api(archivePath, { expectedRevision: definition.revision, archived: true })).json();
    const renamed = f.store.reviewSequences.update(f.pid, definition.id, { expectedRevision: definition.revision, name: "archived rename", loop: definition.loop, segments: definition.segments }); assert.equal(renamed.archived, true); definition = renamed;
    assert.equal(f.store.reviewSequences.listSnapshots(f.pid, definition.id)[0]!.stale, false);
    const entry = f.store.library.delete(f.pid, { assetIds: [clip.id], folders: [] }, f.store.library.revision(f.pid));
    assert.ok((await f.store.animation.renderFrame(f.pid, captured.snapshotId, f.store.animation.snapshot(f.pid, captured.snapshotId).clip.frames[0]!.id)).path);
    assert.ok(f.store.animation.evidence(f.pid, inspected.id, "contact"));
    assert.equal((await f.api(`/api/projects/${f.pid}/review-sequences`)).json()[0].archived, true);
    const unresolvedRestore = await f.api(archivePath, { expectedRevision: definition.revision, archived: false }); assert.equal(unresolvedRestore.statusCode, 200); assert.ok(unresolvedRestore.json().unresolved.length);
    f.store.library.restore(f.pid, entry.id, f.store.library.revision(f.pid));
    assert.equal(f.store.reviewSequences.get(f.pid, definition.id).unresolved.length, 0); assert.equal(f.store.reviewSequences.listSnapshots(f.pid, definition.id)[0]!.stale, false);
  } finally { await f.cleanup(); }
});

test("review I5: an image-only context in an ordinary conversation sends frozen actual localImage bytes and audits their hash", async () => {
  const f = await fixture();
  try {
    const session = f.store.createSession(f.pid);
    const response = await f.api(`/api/sessions/${session.id}/messages`, { requestId: randomUUID(), text: "查看此图", assetIds: [], context: { mode: "saved", assetId: f.image.id, revision: f.image.revision } });
    assert.equal(response.statusCode, 202, response.body); await waitFor(() => session.status === "running" && session.turnId);
    const inputs = f.runtimes.at(-1)!.calls.find(call => call.method === "turn/start")!.input.input, images = inputs.filter((input: any) => input.type === "localImage");
    assert.equal(images.length, 1); assert.equal(sha256(readFileSync(images[0].path)), f.image.contentHash);
    assert.deepEqual(session.workflowReferenceHashes, [f.image.contentHash]); assert.deepEqual(session.messages.at(-1)!.assetIds, [f.image.id]);
    assert.equal(f.store.tasks.list(f.pid).length, 0);
  } finally { await f.cleanup(); }
});

test("review I6: human drafts protect every frozen image dependency, including images removed from the current body", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(), extra = await f.store.importImage(f.pid, "temporarily-used.png", readFileSync(f.sourcePath), "image");
    let draft = f.store.clipDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision }, "human");
    let body = JSON.parse(draft.text); body.frames.push({ id: randomUUID(), imageId: extra.id, durationUs: 100000 });
    draft = f.store.clipDrafts.write(f.pid, draft.documentId, { expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(body) });
    body = JSON.parse(draft.text); body.frames.pop();
    draft = f.store.clipDrafts.write(f.pid, draft.documentId, { expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(body) });
    assert.ok(f.store.clipDrafts.dependencyImageIds(f.pid, draft.documentId).includes(extra.id)); assert.ok(!JSON.parse(draft.text).frames.some((frame: any) => frame.imageId === extra.id));
    const task = await f.create({ target: { mode: "saved", clipId: clip.id } }); await f.hub.taskAction(f.pid, task.id, { expectedRevision: task.revision, action: "stop" });
    assert.notEqual(f.store.clipDrafts.read(f.pid, draft.documentId).draft.readOnly, true, "a human draft is not retired with a task");
    const selection = { assetIds: [extra.id], folders: [] };
    assert.ok(f.store.library.planDelete(f.pid, selection).blockers.some(blocker => /冻结图片/.test(blocker.reason)));
    assert.throws(() => f.store.library.delete(f.pid, selection, f.store.library.revision(f.pid)), /冻结图片/);
    assert.ok((await f.store.clipDrafts.preview(f.pid, draft.documentId, draft.documentRevision)).preview.id);
    draft = f.store.clipDrafts.write(f.pid, draft.documentId, { expectedDocumentRevision: draft.documentRevision, text: draft.text });
    const saved = await f.store.clipDrafts.save(f.pid, draft.documentId, draft.documentRevision);
    assert.deepEqual(f.store.library.planDelete(f.pid, selection).blockers, []); f.store.library.delete(f.pid, selection, f.store.library.revision(f.pid));
    assert.throws(() => f.store.asset(f.pid, extra.id));
    assert.equal((await f.store.clipDrafts.save(f.pid, draft.documentId, draft.documentRevision)).afterSnapshotId, saved.afterSnapshotId);
    assert.ok((await f.store.animation.renderFrame(f.pid, saved.afterSnapshotId, clip.frames[0]!.id)).path);
  } finally { await f.cleanup(); }
});

test("round2 N1: stopped legacy Agent drafts stay read-only through old document/save services and restart; independent editors stay mutable", async () => {
  const f = await fixture(); let restored: ProjectStore | undefined;
  try {
    const clip = f.clip(); let task = await f.create({ target: { mode: "saved", clipId: clip.id } }); task = f.approveExisting(task, task.target!.snapshotId); const session = await f.begin(task);
    const draft = result(await f.hub.tool(session.id, "create_frame_draft", { clipId: clip.id, revision: clip.revision, frameId: clip.frames[0]!.id }));
    const body = JSON.parse(draft.text); body.frames[0].durationUs = 190000;
    const edited = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(body) }] }))[0];
    const inspected = result(await f.hub.tool(session.id, "inspect_clip", { draftId: draft.documentId, documentRevision: edited.documentRevision }));
    assert.equal(edited.draft.taskId, task.id); assert.equal(edited.draft.intentVersion, 1);
    await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "stop" });
    const assertHistorical = async (store: ProjectStore) => {
      assert.equal(store.frameDrafts.get(f.pid, draft.documentId).readOnly, true);
      assert.equal(store.frameDrafts.read(f.pid, draft.documentId).draft.readOnly, true);
      assert.equal(store.documents.read(f.pid, draft.documentId).text, edited.text);
      const replacement = JSON.parse(edited.text); replacement.frames[0].durationUs = 290000;
      const input = { documentId: draft.documentId, expectedDocumentRevision: edited.documentRevision, text: JSON.stringify(replacement) };
      assert.throws(() => store.frameDrafts.prepare(f.pid, input), /只读历史/);
      assert.throws(() => store.documents.write(f.pid, [input]), /只读历史/);
      await assert.rejects(store.frameDrafts.save(f.pid, draft.documentId, edited.documentRevision), /只读历史/);
      assert.equal(store.frameDrafts.read(f.pid, draft.documentId).text, edited.text);
      assert.equal(store.animation.snapshot(f.pid, inspected.snapshotId).clip.frames[0]!.durationUs, 190000);
    };
    await assertHistorical(f.store); assert.equal(f.store.animation.clip(f.pid, clip.id).frames[0]!.durationUs, 100000);
    const human = f.store.frameDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision, frameId: clip.frames[1]!.id }, "human");
    const humanBody = JSON.parse(human.text); humanBody.frames[1].durationUs = 220000;
    const humanEdited = f.store.documents.write(f.pid, [{ documentId: human.documentId, expectedDocumentRevision: human.documentRevision, text: JSON.stringify(humanBody) }])[0]!;
    assert.notEqual(humanEdited.draft.readOnly, true); await f.store.frameDrafts.save(f.pid, human.documentId, humanEdited.documentRevision);
    const ordinary = f.store.createSession(f.pid), current = f.store.animation.clip(f.pid, clip.id);
    f.hub.send(ordinary.id, "普通对话编辑帧，无制作任务", [], randomUUID()); await waitFor(() => ordinary.status === "running" && ordinary.turnId);
    const standalone = result(await f.hub.tool(ordinary.id, "create_frame_draft", { clipId: clip.id, revision: current.revision, frameId: clip.frames[0]!.id }));
    assert.equal(standalone.draft.taskId, undefined); assert.notEqual(standalone.draft.readOnly, true);
    const standaloneBody = JSON.parse(standalone.text); standaloneBody.frames[0].durationUs = 250000;
    const standaloneEdited = result(await f.hub.tool(ordinary.id, "write_documents", { documents: [{ documentId: standalone.documentId, expectedDocumentRevision: standalone.documentRevision, text: JSON.stringify(standaloneBody) }] }))[0];
    assert.equal(result(await f.hub.tool(ordinary.id, "create_frame_draft", { clipId: clip.id, revision: current.revision, frameId: clip.frames[1]!.id })).documentId, standalone.documentId);
    assert.equal(result(await f.hub.tool(ordinary.id, "save_frame_draft", { draftId: standalone.documentId, documentRevision: standaloneEdited.documentRevision })).saved, true);
    await f.hub.close(); await f.store.worker.close(); restored = new ProjectStore(f.store.root);
    await assertHistorical(restored); assert.equal(restored.animation.clip(f.pid, clip.id).frames[0]!.durationUs, 250000);
    assert.notEqual(restored.frameDrafts.get(f.pid, human.documentId).readOnly, true);
  } finally { await restored?.worker.close(); await f.cleanup(); }
});

test("round2 N1: new intents create a fresh clean legacy ID, retain old bodies across startup and require explicit historical derivation", async () => {
  const f = await fixture(); let restored: ProjectStore | undefined;
  try {
    const clip = f.clip(); let task = await f.create({ target: { mode: "saved", clipId: clip.id } }); task = f.approveExisting(task, task.target!.snapshotId); const session = await f.begin(task);
    const old = result(await f.hub.tool(session.id, "create_frame_draft", { clipId: clip.id, revision: clip.revision, frameId: clip.frames[0]!.id }));
    const body = JSON.parse(old.text); body.frames[0].durationUs = 190000;
    const oldEdited = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: old.documentId, expectedDocumentRevision: old.documentRevision, text: JSON.stringify(body) }] }))[0];
    task = await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "feedback", feedbackKind: "local", text: "新intent，不采用上一轮未保存稿" });
    await f.begin(task);
    const fresh = result(await f.hub.tool(session.id, "create_frame_draft", { clipId: clip.id, revision: clip.revision, frameId: clip.frames[0]!.id }));
    assert.notEqual(fresh.documentId, old.documentId); assert.equal(JSON.parse(fresh.text).frames[0].durationUs, 100000); assert.equal(fresh.draft.intentVersion, 2);
    assert.equal(f.store.frameDrafts.get(f.pid, old.documentId).readOnly, true); assert.equal(f.store.frameDrafts.read(f.pid, old.documentId).text, oldEdited.text);
    const currentTask = f.store.tasks.get(f.pid, task.id);
    assert.throws(() => f.store.tasks.registerDraft(f.pid, task.id, { sessionId: session.id, intentVersion: currentTask.intentVersion, barrierVersion: currentTask.barrierVersion, draftId: old.documentId, kind: "frame" }), /历史Agent草稿/);
    assert.ok(!f.store.tasks.get(f.pid, task.id).drafts!.some(entry => entry.draftId === old.documentId && entry.intentVersion === 2));
    assert.equal(result(await f.hub.tool(session.id, "workflow_task", { action: "ready" })).task.status, "ready");
    task = await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "feedback", feedbackKind: "local", text: "另一个明确intent的当前帧稿" });
    await f.begin(task);
    const active = result(await f.hub.tool(session.id, "create_frame_draft", { clipId: clip.id, revision: clip.revision, frameId: clip.frames[1]!.id }));
    const activeBody = JSON.parse(active.text); activeBody.frames[1].durationUs = 230000;
    const activeEdited = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: active.documentId, expectedDocumentRevision: active.documentRevision, text: JSON.stringify(activeBody) }] }))[0];
    await f.hub.close(); await f.store.worker.close(); restored = new ProjectStore(f.store.root);
    const historical = restored.frameDrafts.get(f.pid, old.documentId), stillActive = restored.frameDrafts.get(f.pid, active.documentId);
    assert.equal(historical.readOnly, true); assert.equal(historical.text, oldEdited.text); assert.equal(historical.mergedInto, undefined);
    assert.notEqual(stillActive.readOnly, true); assert.equal(stillActive.text, activeEdited.text); assert.equal(stillActive.mergedInto, undefined);
    assert.deepEqual(JSON.parse(stillActive.text).frames.map((frame: any) => frame.durationUs), [100000, 230000]);
    const adopted = restored.clipDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision, fromDraftId: old.documentId }, "human");
    assert.notEqual(adopted.documentId, old.documentId); assert.equal(JSON.parse(adopted.text).frames[0].durationUs, 190000);
    await restored.clipDrafts.save(f.pid, adopted.documentId, adopted.documentRevision);
    assert.equal(restored.animation.clip(f.pid, clip.id).frames[0]!.durationUs, 190000); assert.equal(restored.frameDrafts.read(f.pid, old.documentId).text, oldEdited.text);
    const changedClip = restored.animation.clip(f.pid, clip.id);
    assert.throws(() => restored!.clipDrafts.create(f.pid, { clipId: clip.id, revision: changedClip.revision, fromDraftId: old.documentId }, "human"), /基线不匹配/);
  } finally { await restored?.worker.close(); await f.cleanup(); }
});

test("round2 N1: a legacy save rechecks historical ownership after the final real render before publication", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(); let task = await f.create({ target: { mode: "saved", clipId: clip.id } }); task = f.approveExisting(task, task.target!.snapshotId); const session = await f.begin(task);
    const draft = result(await f.hub.tool(session.id, "create_frame_draft", { clipId: clip.id, revision: clip.revision, frameId: clip.frames[0]!.id }));
    const body = JSON.parse(draft.text); body.frames[0].durationUs = 190000; body.frames[0].transform.scale = 0.5;
    const edited = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(body) }] }))[0];
    await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "handoff" });
    let release!: () => void, rendering = false, renders = 0, guardCalls = 0;
    const gate = new Promise<void>(resolve => release = resolve), originalRender = f.store.animation.renderFrame.bind(f.store.animation), originalAdjust = f.store.animation.adjustFrames.bind(f.store.animation);
    f.store.animation.renderFrame = async (pid, snapshotId, frameId) => { const value = await originalRender(pid, snapshotId, frameId); if (++renders === 2) { rendering = true; await gate; } return value; };
    f.store.animation.adjustFrames = (pid, input, source, beforeCommit) => originalAdjust(pid, input, source, () => { guardCalls++; assert.ok(beforeCommit); beforeCommit!(); });
    const saving = f.store.frameDrafts.save(f.pid, draft.documentId, edited.documentRevision), rejected = assert.rejects(saving, /只读历史/);
    await waitFor(() => rendering);
    await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "stop" });
    release(); await rejected;
    assert.equal(guardCalls, 1); assert.deepEqual(f.store.animation.clip(f.pid, clip.id).frames, clip.frames); assert.equal(f.store.animation.changes.has(draft.documentId), false);
    const historical = f.store.frameDrafts.get(f.pid, draft.documentId); assert.equal(historical.readOnly, true); assert.equal(historical.text, edited.text); assert.equal(historical.status, "editing");
  } finally { await f.cleanup(); }
});

test("final R1: actual UI queue/context/frame/whole payloads freeze through HTTP tasks and messages", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(3);
    const human = f.store.clipDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision }, "human");
    const path = `/api/projects/${f.pid}/clip-drafts/${human.documentId}`;
    const q = new DraftQueue(human, async (expectedDocumentRevision, text) => {
      const response = await f.api(path, { expectedDocumentRevision, text }, "PUT");
      assert.equal(response.statusCode, 200, response.body); return response.json();
    });
    for (const edited of [false, true]) {
      if (edited) {
        const body = JSON.parse(q.document.text); body.frames.reverse(); body.frames.forEach((frame: any, i: number) => { frame.durationUs = 170000 + i * 20000; frame.transform = { scale: 0.7, offsetX: i, offsetY: 0, clip: false }; });
        q.enqueue(JSON.stringify(body, null, 2));
      }
      const stable = await q.flush();
      const frameId = JSON.parse(stable.text).frames[1].id;
      for (const scope of ["frame", "whole"] as const) {
        const context = taskCreationTarget(contextFor(clip, frameId, stable), scope)!;
        assert.equal(context.snapshotId, undefined, "baseSnapshot is never the draft body");
        const task = await f.create({ target: context });
        assert.notEqual(task.target!.snapshotId, human.draft.baseSnapshotId);
        const frozen = f.store.animation.snapshot(f.pid, task.target!.snapshotId!);
        assert.deepEqual(frozen.clip.frames, JSON.parse(stable.text).frames);
        assert.deepEqual(task.contract.scope, scope === "frame" ? { clipId: clip.id, startFrameId: frameId, endFrameId: frameId } : { clipId: clip.id });
        const session = await f.begin(task, context);
        assert.equal(session.editingContext!.snapshotId, task.target!.snapshotId);
        await (f.hub as any).notification(session, { method: "turn/completed", params: { threadId: session.threadId, turn: { id: session.turnId, status: "completed" } } });
      }
    }
    const wrong = await f.api(`/api/projects/${f.pid}/tasks`, { requestId: randomUUID(), title: "bad baseline", description: "", target: { ...contextFor(clip, undefined, q.document), snapshotId: human.draft.baseSnapshotId } });
    assert.equal(wrong.statusCode, 409); assert.match(wrong.body, /草稿快照/);
  } finally { await f.cleanup(); }
});

test("final R10: trusted Agent result returns to human draft with dual CAS, never auto-publishes", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(1); let human = f.store.clipDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision }, "human");
    const humanBody = JSON.parse(human.text); humanBody.frames[0].durationUs = 170000;
    human = f.store.clipDrafts.write(f.pid, human.documentId, { expectedDocumentRevision: human.documentRevision, text: JSON.stringify(humanBody) });
    const source = structuredClone(human), context = contextFor(clip, undefined, human);
    let task = await f.create({ target: context }); task = f.approveExisting(task, task.target!.snapshotId);
    const session = await f.begin(task, context);
    const agent = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision, fromDraftId: human.documentId, expectedFromDocumentRevision: human.documentRevision }));
    assert.deepEqual(agent.draft.deliveryTarget, { draftId: human.documentId, documentRevision: human.documentRevision });
    const body = JSON.parse(agent.text); body.frames[0].durationUs = 190000;
    const edited = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: agent.documentId, expectedDocumentRevision: agent.documentRevision, text: JSON.stringify(body) }] }))[0];
    const delivered = result(await f.hub.tool(session.id, "save_clip_draft", { draftId: agent.documentId, documentRevision: edited.documentRevision }));
    assert.equal(delivered.saved, false); assert.equal(delivered.delivered, true); assert.equal(delivered.pendingHumanAdoption, true);
    assert.ok(session.messages.some(message => message.clipDraftIds?.includes(agent.documentId)));
    await f.emit(session.id, "item/completed", { id: "proposal-delivered", type: "mcpToolCall", tool: "save_clip_draft", status: "completed", result: { content: [{ type: "text", text: JSON.stringify(delivered) }] } });
    assert.equal(session.activities.find(activity => activity.id === "proposal-delivered")!.status, "completed");
    await f.emit(session.id, "item/completed", { id: "real-save-failure", type: "mcpToolCall", tool: "save_clip_draft", status: "completed", result: { content: [{ type: "text", text: JSON.stringify({ saved: false, reason: "real failure" }) }] } });
    assert.equal(session.activities.find(activity => activity.id === "real-save-failure")!.status, "failed");
    assert.equal(f.store.animation.clip(f.pid, clip.id).frames[0]!.durationUs, 100000);
    assert.deepEqual(f.store.clipDrafts.read(f.pid, human.documentId), source);
    const proposal = f.store.clipDrafts.read(f.pid, agent.documentId); assert.equal(proposal.draft.readOnly, true);
    assert.equal(f.store.animation.snapshot(f.pid, delivered.delivery.snapshotId).clip.frames[0]!.durationUs, 190000);
    assert.deepEqual(result(await f.hub.tool(session.id, "save_clip_draft", { draftId: agent.documentId, documentRevision: edited.documentRevision })), delivered, "retry reads the same result, not a new publication");
    await assert.rejects(f.store.clipDrafts.save(f.pid, agent.documentId, edited.documentRevision), /只能交付待采用/);
    const dirtyReady = await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "ready" });
    assert.equal(dirtyReady.statusCode, 409); assert.match(dirtyReady.body, /待显式采用/);
    await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "handoff" });
    const adoptPath = `/api/projects/${f.pid}/clip-drafts/${human.documentId}/adopt`;
    const wrongResult = await f.api(adoptPath, { expectedDocumentRevision: human.documentRevision, resultDraftId: agent.documentId, expectedResultDocumentRevision: "wrong" });
    assert.equal(wrongResult.statusCode, 409); assert.equal(f.store.clipDrafts.read(f.pid, human.documentId).text, human.text);
    const otherClip = f.clip(1), otherHuman = f.store.clipDrafts.create(f.pid, { clipId: otherClip.id, revision: otherClip.revision }, "human");
    assert.equal((await f.api(`/api/projects/${f.pid}/clip-drafts/${otherHuman.documentId}/adopt`, { expectedDocumentRevision: otherHuman.documentRevision, resultDraftId: agent.documentId, expectedResultDocumentRevision: edited.documentRevision })).statusCode, 409);
    const adopted = await f.api(adoptPath, { expectedDocumentRevision: human.documentRevision, resultDraftId: agent.documentId, expectedResultDocumentRevision: edited.documentRevision });
    assert.equal(adopted.statusCode, 200, adopted.body); human = adopted.json();
    assert.equal(human.draft.source, "human"); assert.equal(human.documentId, source.documentId); assert.equal(JSON.parse(human.text).frames[0].durationUs, 190000);
    assert.equal(f.store.animation.clip(f.pid, clip.id).frames[0]!.durationUs, 100000);
    assert.equal(f.store.clipDrafts.read(f.pid, agent.documentId).text, edited.text);
    assert.ok(readFileSync(f.store.safePath(f.pid, `.studio/clip-draft-history/${source.documentId}-${source.documentRevision}.json`), "utf8").includes(source.documentRevision));
    const saved = await f.api(`/api/projects/${f.pid}/clip-drafts/${human.documentId}/save`, { documentRevision: human.documentRevision });
    assert.equal(saved.statusCode, 200, saved.body); assert.equal(f.store.animation.clip(f.pid, clip.id).frames[0]!.durationUs, 190000);
  } finally { await f.cleanup(); }
});

for (const linkedTask of [false, true]) test(`final R10 aliases: ${linkedTask ? "task" : "ordinary"} human collaboration cannot publish via old saves or direct clip config`, async () => {
  const f = await fixture();
  try {
    const clip = f.clip(1); let human = f.store.clipDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision }, "human");
    const body = JSON.parse(human.text); body.frames[0].durationUs = 170000;
    human = f.store.clipDrafts.write(f.pid, human.documentId, { expectedDocumentRevision: human.documentRevision, text: JSON.stringify(body) });
    const context = contextFor(clip, undefined, human);
    let task = linkedTask ? await f.create({ target: context }) : undefined;
    if (task) task = f.approveExisting(task, task.target!.snapshotId);
    const session = task ? f.store.session(task.sessionId!) : f.store.createSession(f.pid);
    // Old Agent work created before the human collaboration must not become an
    // alternate publication capability after the explicit source handoff.
    const oldFrame = f.store.frameDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision, frameId: clip.frames[0]!.id }, "agent", session.id);
    const oldClip = f.store.clipDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision }, "agent", session.id);
    if (task) await f.begin(task, context); else { f.hub.send(session.id, "改我的未保存人稿", [], randomUUID(), undefined, [], undefined, undefined, context); await waitFor(() => session.status === "running" && session.turnId); }
    const formal = f.store.documents.read(f.pid, clip.id);
    for (const [tool, args] of [["create_frame_draft", { clipId: clip.id, revision: clip.revision, frameId: clip.frames[0]!.id }], ["save_frame_draft", { draftId: oldFrame.documentId, documentRevision: oldFrame.documentRevision }], ["save_clip_draft", { draftId: oldClip.documentId, documentRevision: oldClip.documentRevision }], ["write_documents", { documents: [{ documentId: clip.id, expectedDocumentRevision: formal.documentRevision, text: formal.text }] }]] as const) await assert.rejects(f.hub.tool(session.id, tool, args), /人工草稿协作.*显式采用/);
    assert.equal(f.store.animation.clip(f.pid, clip.id).frames[0]!.durationUs, 100000); assert.equal(f.store.clipDrafts.read(f.pid, human.documentId).text, human.text);
    assert.equal(f.store.frameDrafts.get(f.pid, oldFrame.documentId).status, "editing"); assert.equal(f.store.clipDrafts.read(f.pid, oldClip.documentId).draft.status, "editing");
  } finally { await f.cleanup(); }
});

test("final R10 legacy source: explicit adoption starts unified human session without truncating result or editing old v2", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(1); let legacy = f.store.frameDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision, frameId: clip.frames[0]!.id }, "human");
    const sourceBody = JSON.parse(legacy.text); sourceBody.frames[0].durationUs = 170000;
    legacy = f.store.documents.write(f.pid, [{ documentId: legacy.documentId, expectedDocumentRevision: legacy.documentRevision, text: JSON.stringify(sourceBody) }])[0]!;
    let task = await f.create({ target: { mode: "draft", draftId: legacy.documentId, documentRevision: legacy.documentRevision } }); task = f.approveExisting(task, task.target!.snapshotId);
    const session = await f.begin(task);
    const draft = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision, fromDraftId: legacy.documentId, expectedFromDocumentRevision: legacy.documentRevision }));
    assert.deepEqual(draft.draft.deliveryTarget, { draftId: legacy.documentId, documentRevision: legacy.documentRevision, kind: "frame" });
    const body = JSON.parse(draft.text); body.frames[0].durationUs = 190000; body.frames.push({ id: randomUUID(), imageId: f.image.id, durationUs: 210000 });
    const edited = result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: draft.documentRevision, text: JSON.stringify(body) }] }))[0];
    const delivered = result(await f.hub.tool(session.id, "save_clip_draft", { draftId: draft.documentId, documentRevision: edited.documentRevision }));
    assert.equal(delivered.delivered, true); assert.equal(delivered.saved, false); assert.equal(f.store.animation.clip(f.pid, clip.id).frames[0]!.durationUs, 100000);
    await f.hub.taskAction(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "handoff" });
    const path = `/api/projects/${f.pid}/clip-drafts/${legacy.documentId}/adopt`;
    assert.equal((await f.api(path, { expectedDocumentRevision: legacy.documentRevision, resultDraftId: draft.documentId, expectedResultDocumentRevision: "wrong" })).statusCode, 409);
    const adopted = await f.api(path, { expectedDocumentRevision: legacy.documentRevision, resultDraftId: draft.documentId, expectedResultDocumentRevision: edited.documentRevision });
    assert.equal(adopted.statusCode, 200, adopted.body); const human = adopted.json();
    assert.notEqual(human.documentId, legacy.documentId); assert.equal(human.draft.source, "human"); assert.deepEqual(JSON.parse(human.text), body);
    assert.equal(f.store.frameDrafts.read(f.pid, legacy.documentId).text, legacy.text); assert.equal(f.store.animation.clip(f.pid, clip.id).frames.length, 1);
    sourceBody.frames[0].durationUs = 230000;
    const changed = f.store.documents.write(f.pid, [{ documentId: legacy.documentId, expectedDocumentRevision: legacy.documentRevision, text: JSON.stringify(sourceBody) }])[0]!;
    for (const expectedDocumentRevision of [legacy.documentRevision, changed.documentRevision]) assert.equal((await f.api(path, { expectedDocumentRevision, resultDraftId: draft.documentId, expectedResultDocumentRevision: edited.documentRevision })).statusCode, 409);
    assert.equal(f.store.clipDrafts.read(f.pid, draft.documentId).text, edited.text); assert.equal(f.store.frameDrafts.read(f.pid, legacy.documentId).text, changed.text);
    const saved = await f.api(`/api/projects/${f.pid}/clip-drafts/${human.documentId}/save`, { documentRevision: human.documentRevision });
    assert.equal(saved.statusCode, 200, saved.body); assert.equal(f.store.animation.clip(f.pid, clip.id).frames.length, 2); assert.equal(f.store.animation.clip(f.pid, clip.id).frames[0]!.durationUs, 190000);
  } finally { await f.cleanup(); }
});

test("final R10: a newer human revision cannot authorize overwriting proposal's older source", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(1), source = f.store.clipDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision }, "human");
    const agent = f.store.clipDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision, fromDraftId: source.documentId }, "agent", f.store.createSession(f.pid).id);
    const body = JSON.parse(agent.text); body.frames[0].durationUs = 190000;
    const result = f.store.clipDrafts.write(f.pid, agent.documentId, { expectedDocumentRevision: agent.documentRevision, text: JSON.stringify(body) });
    await f.store.clipDrafts.deliver(f.pid, agent.documentId, result.documentRevision, () => {});
    const mine = JSON.parse(source.text); mine.frames[0].durationUs = 230000;
    const changed = f.store.clipDrafts.write(f.pid, source.documentId, { expectedDocumentRevision: source.documentRevision, text: JSON.stringify(mine) });
    for (const expectedDocumentRevision of [source.documentRevision, changed.documentRevision]) {
      const rejected = await f.api(`/api/projects/${f.pid}/clip-drafts/${source.documentId}/adopt`, { expectedDocumentRevision, resultDraftId: agent.documentId, expectedResultDocumentRevision: result.documentRevision });
      assert.equal(rejected.statusCode, 409); assert.match(rejected.body, /正文已变化/);
    }
    assert.equal(f.store.clipDrafts.read(f.pid, source.documentId).text, changed.text); assert.equal(f.store.clipDrafts.read(f.pid, agent.documentId).text, result.text);
    assert.equal(f.store.animation.clip(f.pid, clip.id).revision, clip.revision);
    assert.throws(() => f.store.clipDrafts.write(f.pid, agent.documentId, { expectedDocumentRevision: result.documentRevision, text: agent.text }), /只读/);
  } finally { await f.cleanup(); }
});

for (const collaboration of [false, true]) test(`final R3: last successful repair can ${collaboration ? "deliver human proposal" : "publish"}, but another body/write cannot bypass limit`, async () => {
  const f = await fixture();
  try {
    const clip = f.clip(1), human = collaboration ? f.store.clipDrafts.create(f.pid, { clipId: clip.id, revision: clip.revision }, "human") : undefined;
    let task = await f.create({ target: contextFor(clip, undefined, human), contract: { repairLimit: 1 } }); task = f.approveExisting(task, task.target!.snapshotId);
    const session = await f.begin(task, human ? contextFor(clip, undefined, human) : undefined);
    const draft = result(await f.hub.tool(session.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision, ...(human ? { fromDraftId: human.documentId, expectedFromDocumentRevision: human.documentRevision } : {}) }));
    const body = JSON.parse(draft.text); body.frames[0].transform = { scale: 1, offsetX: 50, offsetY: 0, clip: false };
    const write = async (document: any, value: any) => result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: document.documentRevision, text: JSON.stringify(value) }] }))[0];
    const failed = await write(draft, body);
    await f.hub.tool(session.id, "inspect_clip", { draftId: draft.documentId, documentRevision: failed.documentRevision });
    assert.equal(f.store.tasks.checksForIntent(f.pid, task.id).at(-2)!.status, "failed");
    body.frames[0].transform.offsetX = 0; body.frames[0].durationUs = 190000;
    const fixed = await write(failed, body);
    await f.hub.tool(session.id, "inspect_clip", { draftId: draft.documentId, documentRevision: fixed.documentRevision });
    task = f.store.tasks.get(f.pid, task.id); assert.equal(task.repairRounds!.length, 1); assert.equal(task.repairRounds![0]!.improved, true);
    const changedBody = structuredClone(body); changedBody.frames[0].durationUs = 210000;
    await assert.rejects(write(fixed, changedBody), /修复已停止.*limit/);
    const forced = f.store.guarded(() => {}, () => f.store.clipDrafts.write(f.pid, draft.documentId, { expectedDocumentRevision: fixed.documentRevision, text: JSON.stringify(changedBody) }));
    await assert.rejects(f.hub.tool(session.id, "save_clip_draft", { draftId: draft.documentId, documentRevision: forced.documentRevision }), /修复已停止.*limit/);
    const restored = f.store.guarded(() => {}, () => f.store.clipDrafts.write(f.pid, draft.documentId, { expectedDocumentRevision: forced.documentRevision, text: JSON.stringify(body) }));
    assert.equal(restored.documentRevision, fixed.documentRevision);
    const published = result(await f.hub.tool(session.id, "save_clip_draft", { draftId: draft.documentId, documentRevision: fixed.documentRevision }));
    assert.equal(published.saved, !collaboration); assert.equal(published.delivered, collaboration ? true : undefined);
    assert.equal(f.store.animation.clip(f.pid, clip.id).frames[0]!.durationUs, collaboration ? 100000 : 190000);
    assert.equal(f.store.tasks.get(f.pid, task.id).repairRounds!.length, 1);
  } finally { await f.cleanup(); }
});

test("final R3: exact legacy final repair survives its existing pending save approval guard", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(1); let task = await f.create({ target: contextFor(clip), contract: { repairLimit: 1 } }); task = f.approveExisting(task, task.target!.snapshotId);
    const session = await f.begin(task);
    const draft = result(await f.hub.tool(session.id, "create_frame_draft", { clipId: clip.id, revision: clip.revision, frameId: clip.frames[0]!.id }));
    const body = JSON.parse(draft.text); body.frames[0].transform.offsetX = 50;
    const write = async (document: any) => result(await f.hub.tool(session.id, "write_documents", { documents: [{ documentId: draft.documentId, expectedDocumentRevision: document.documentRevision, text: JSON.stringify(body) }] }))[0];
    const failed = await write(draft); await f.hub.tool(session.id, "inspect_clip", { draftId: draft.documentId, documentRevision: failed.documentRevision });
    body.frames[0].transform.offsetX = 0; body.frames[0].durationUs = 190000;
    const fixed = await write(failed); await f.hub.tool(session.id, "inspect_clip", { draftId: draft.documentId, documentRevision: fixed.documentRevision });
    assert.equal(f.store.tasks.get(f.pid, task.id).repairRounds!.at(-1)!.improved, true);
    f.store.permissions.write({ save_frame_draft: "ask" });
    const saving = f.hub.tool(session.id, "save_frame_draft", { draftId: draft.documentId, documentRevision: fixed.documentRevision });
    await waitFor(() => session.frameSaveApproval);
    await f.hub.resolveFrameSave(session.id, session.frameSaveApproval!.id, true);
    assert.equal(result(await saving).saved, true); assert.equal(f.store.animation.clip(f.pid, clip.id).frames[0]!.durationUs, 190000);
  } finally { await f.cleanup(); }
});

test("final R4: invalid whole messages leave accepted task and session unchanged, then valid request advances exactly once", async () => {
  const f = await fixture();
  try {
    const clip = f.clip(), other = f.clip();
    let task = await f.create({ target: contextFor(clip) }); task = f.approveExisting(task, task.target!.snapshotId);
    const session = await f.begin(task);
    const ready = result(await f.hub.tool(session.id, "workflow_task", { action: "ready" }));
    task = f.store.tasks.action(f.pid, task.id, { expectedRevision: ready.task.revision, action: "accept", snapshotId: ready.snapshot.id });
    await (f.hub as any).notification(session, { method: "turn/completed", params: { threadId: session.threadId, turn: { id: session.turnId, status: "completed" } } });
    const beforeTask = structuredClone(f.store.tasks.get(f.pid, task.id)), beforeSession = structuredClone(session), count = f.runtimes.length;
    const staleReference = { clipId: other.id, revision: other.revision };
    f.store.updateClip(f.pid, other.id, { revision: other.revision, loop: other.loop, frames: other.frames.map(frame => ({ ...frame, durationUs: 120000 })) });
    for (const extra of [{ clipReferences: [staleReference] }, { assetIds: [randomUUID()] }, { context: { ...contextFor(clip), revision: "invalid explicit source" }, feedbackKind: "local" }, { context: contextFor(other), feedbackKind: "local" }]) {
      const request = { requestId: randomUUID(), taskId: task.id, text: "继续局部制作", ...extra };
      for (let repeat = 0; repeat < 2; repeat++) {
        const rejected = await f.api(`/api/sessions/${session.id}/messages`, request);
        assert.ok(rejected.statusCode >= 400 && rejected.statusCode < 500, rejected.body);
        assert.deepEqual(f.store.tasks.get(f.pid, task.id), beforeTask); assert.deepEqual(session, beforeSession);
        assert.equal(f.runtimes.length, count); assert.ok(!session.messages.some(message => message.id === request.requestId));
      }
    }
    const valid = { requestId: randomUUID(), taskId: task.id, text: "继续局部制作", context: contextFor(clip), feedbackKind: "local" };
    assert.equal((await f.api(`/api/sessions/${session.id}/messages`, valid)).statusCode, 202);
    await waitFor(() => session.status === "running" && session.turnId);
    const advanced = f.store.tasks.get(f.pid, task.id); assert.equal(advanced.intentVersion, beforeTask.intentVersion + 1); assert.equal(advanced.barrierVersion, beforeTask.barrierVersion + 1);
    assert.equal((await f.api(`/api/sessions/${session.id}/messages`, valid)).statusCode, 202);
    assert.equal(f.store.tasks.get(f.pid, task.id).revision, advanced.revision); assert.equal(session.messages.filter(message => message.id === valid.requestId).length, 1);
  } finally { await f.cleanup(); }
});

test("final R5: unknown late artifact is visible to actual UI payload and explicit direction, without retrying generation", async () => {
  const f = await fixture();
  try {
    let task = await f.create(); const session = await f.begin(task), itemId = randomUUID(), turnId = session.turnId;
    await f.emit(session.id, "item/started", { type: "imageGeneration", id: itemId, status: "inProgress" });
    await f.hub.stop(session.id, "unknown terminal state");
    await f.emit(session.id, "item/completed", { type: "imageGeneration", id: itemId, status: "completed", savedPath: f.sourcePath, inputImages: [] }, turnId);
    await Promise.all(f.hub.imports.get(session.id) || []);
    task = f.store.tasks.get(f.pid, task.id); assert.equal(task.attempts[0]!.status, "unknown");
    const material = directionMaterial(task, session); assert.deepEqual(material, { kind: "generated", generatedId: task.attempts[0]!.generatedId });
    task = f.store.tasks.action(f.pid, task.id, { expectedRevision: task.revision, action: "resume" });
    const accepted = await f.api(`${f.taskPath(task.id)}/direction`, directionPayload(task, session, true, ""));
    assert.equal(accepted.statusCode, 200, accepted.body); assert.equal(accepted.json().phase, "production");
    assert.equal(f.store.tasks.get(f.pid, task.id).attempts[0]!.status, "unknown"); assert.equal(f.store.generated.list(f.pid).length, 1);
    assert.throws(() => f.store.tasks.recordAttempt(f.pid, task.id, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, id: randomUUID(), status: "reserved" }), /未知|额度/);
    assert.equal(f.runtimes.length, 1);
  } finally { await f.cleanup(); }
});

test("final R9: mandatory Review unresolved/full-batch/current dependencies gate real ready and accept", async () => {
  const f = await fixture();
  try {
    const a = f.clip(18), b = f.clip(2);
    let definition = f.store.reviewSequences.create(f.pid, { requestId: randomUUID(), name: "A to B", loop: true, segments: [{ id: randomUUID(), clipId: a.id }, { id: randomUUID(), clipId: b.id, startFrameId: b.frames[0]!.id }] });
    let task = await f.create({ target: contextFor(a), contract: taskReviewContract(definition.id, [definition]) }); task = f.approveExisting(task, task.target!.snapshotId);
    const session = await f.begin(task);
    f.store.updateClip(f.pid, b.id, { revision: b.revision, loop: b.loop, frames: b.frames.slice(1) });
    const unresolved = await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: task.revision, action: "ready" });
    assert.equal(unresolved.statusCode, 409); assert.match(unresolved.body, /unresolved/); assert.notEqual(f.store.tasks.get(f.pid, task.id).status, "ready");
    definition = f.store.reviewSequences.update(f.pid, definition.id, { expectedRevision: definition.revision, name: definition.name, loop: definition.loop, segments: definition.segments.map(segment => segment.clipId === b.id ? { ...segment, startFrameId: undefined } : segment) });
    const realInspect = f.store.reviewSequences.inspect.bind(f.store.reviewSequences);
    f.store.reviewSequences.inspect = async (...args) => { const actual = await realInspect(...args); return { ...actual, sequence: { ...actual.sequence, coverage: { ...actual.sequence.coverage, complete: false } } }; };
    const incomplete = await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "ready" });
    assert.equal(incomplete.statusCode, 409); assert.notEqual(f.store.tasks.get(f.pid, task.id).status, "ready");
    assert.equal(f.store.tasks.get(f.pid, task.id).reviewEvidence![0]!.checks[0]!.status, "failed");
    f.store.reviewSequences.inspect = realInspect;
    const checked = result(await f.hub.tool(session.id, "workflow_task", { action: "ready" })); task = checked.task;
    assert.equal(task.status, "ready"); assert.equal(task.reviewEvidence!.length, 2);
    const evidence = task.reviewEvidence!.at(-1)!; assert.equal(evidence.coverage.totalFrames, 19); assert.equal(evidence.coverage.frameIds.length, 19); assert.equal(evidence.coverage.reviewIds.length, 2); assert.equal(evidence.coverage.complete, true);
    assert.equal(evidence.checks[0]!.status, "passed"); assert.equal(evidence.checks[1]!.status, "unverified");
    assert.equal(task.readyReviewEvidenceId, evidence.id); assert.ok(evidence.dependencies.some(dependency => dependency.clipId === b.id));
    // Metadata-only revisions do not invalidate the exact semantic evidence.
    definition = f.store.reviewSequences.update(f.pid, definition.id, { expectedRevision: definition.revision, name: "renamed only", loop: definition.loop, segments: definition.segments });
    assert.equal(f.store.tasks.get(f.pid, task.id).status, "ready");
    const currentB = f.store.animation.clip(f.pid, b.id);
    f.store.updateClip(f.pid, b.id, { revision: currentB.revision, loop: currentB.loop, frames: currentB.frames.map(frame => ({ ...frame, durationUs: 210000 })) });
    assert.equal(f.store.animation.capture(f.pid, a.id).id, checked.snapshot.id, "target itself did not change");
    assert.equal(f.store.tasks.get(f.pid, task.id).status, "blocked");
    const rejected = await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: task.revision, action: "accept", snapshotId: checked.snapshot.id });
    assert.equal(rejected.statusCode, 409); assert.match(rejected.body, /Review/);
    await f.hub.taskAction(f.pid, task.id, { expectedRevision: task.revision, action: "resume" });
    // Resume maintains intent and permits a fresh real Review; old evidence stays historical.
    const refreshed = await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: f.store.tasks.get(f.pid, task.id).revision, action: "ready" });
    assert.equal(refreshed.statusCode, 200, refreshed.body); task = refreshed.json(); assert.equal(task.reviewEvidence!.length, 3);
    const accepted = await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: task.revision, action: "accept", snapshotId: task.readySnapshotId });
    assert.equal(accepted.statusCode, 200, accepted.body); task = accepted.json(); assert.equal(task.acceptanceHistory[0]!.reviewEvidenceId, task.readyReviewEvidenceId);
    const afterB = f.store.animation.clip(f.pid, b.id); f.store.updateClip(f.pid, b.id, { revision: afterB.revision, loop: false, frames: afterB.frames });
    const stale = f.store.tasks.get(f.pid, task.id); assert.equal(stale.status, "blocked"); assert.equal(stale.acceptanceHistory.length, 1); assert.equal(stale.reviewEvidence!.length, 3);
  } finally { await f.cleanup(); }
});

test("final R9: mandatory Review canvas/render failures block delivery, and valid explicit speed remains legal", async () => {
  const f = await fixture();
  try {
    let a = f.clip(1), b = f.clip(1);
    a = f.store.updateClip(f.pid, a.id, { revision: a.revision, loop: true, frames: a.frames.map(frame => ({ ...frame, durationUs: 1000 })) });
    b = f.store.updateClip(f.pid, b.id, { revision: b.revision, loop: true, frames: b.frames.map(frame => ({ ...frame, durationUs: 1000 })) });
    const alternatePath = join(f.root, "other-canvas.png");
    const made = spawnSync("python", ["-I", "-c", "from PIL import Image;import sys;Image.new('RGBA',(64,64),'red').save(sys.argv[1])", alternatePath]); assert.equal(made.status, 0);
    const alternate = await f.store.importImage(f.pid, "other-canvas.png", readFileSync(alternatePath));
    const definition = f.store.reviewSequences.create(f.pid, { requestId: randomUUID(), name: "explicit speed and canvas", loop: true, segments: [{ id: randomUUID(), clipId: a.id, speed: 10 }, { id: randomUUID(), clipId: b.id, speed: 10 }] });
    let task = await f.create({ target: contextFor(a), contract: taskReviewContract(definition.id, [definition]) }); task = f.approveExisting(task, task.target!.snapshotId); await f.begin(task);
    b = f.store.updateClip(f.pid, b.id, { revision: b.revision, loop: true, frames: b.frames.map(frame => ({ ...frame, imageId: alternate.id })) });
    const canvas = await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: task.revision, action: "ready" });
    assert.equal(canvas.statusCode, 400); assert.match(canvas.body, /画布不一致/); assert.notEqual(f.store.tasks.get(f.pid, task.id).status, "ready");
    b = f.store.updateClip(f.pid, b.id, { revision: b.revision, loop: true, frames: b.frames.map(frame => ({ ...frame, imageId: f.image.id, transform: { scale: 1, offsetX: 100, offsetY: 0, clip: false } })) });
    const overflow = await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: task.revision, action: "ready" });
    assert.ok(overflow.statusCode >= 400, overflow.body); assert.notEqual(f.store.tasks.get(f.pid, task.id).status, "ready");
    b = f.store.updateClip(f.pid, b.id, { revision: b.revision, loop: true, frames: b.frames.map(frame => ({ ...frame, transform: { scale: 1, offsetX: 0, offsetY: 0, clip: false } })) });
    const valid = await f.api(`${f.taskPath(task.id)}/actions`, { expectedRevision: task.revision, action: "ready" });
    assert.equal(valid.statusCode, 200, valid.body); const evidence = valid.json().reviewEvidence.at(-1);
    assert.equal(evidence.checks[0].status, "passed"); assert.equal(evidence.checks[1].status, "unverified");
    assert.ok(f.store.animation.snapshot(f.pid, evidence.snapshotId).clip.frames.every(frame => frame.durationUs === 100));
  } finally { await f.cleanup(); }
});

test("restart pauses task, retains unknown generation and never replays a runtime request", async () => {
  const f = await fixture(); let restored: ProjectStore | undefined;
  try {
    const task = await f.create(); const session = await f.begin(task), generationId = "unknown-in-flight";
    await f.emit(session.id, "item/started", { type: "imageGeneration", id: generationId, status: "inProgress" });
    await f.hub.stop(session.id, "user handoff while generation outcome is unknown");
    const staleTurn = session.turnId;
    await f.emit(session.id, "item/completed", { type: "imageGeneration", id: generationId, status: "completed", savedPath: f.sourcePath, inputImages: [] }, staleTurn);
    await Promise.all(f.hub.imports.get(session.id) || []);
    let current = f.store.tasks.get(f.pid, task.id); assert.equal(current.attempts[0]!.status, "unknown"); assert.ok(current.attempts[0]!.generatedId); assert.equal(f.store.generated.list(f.pid).length, 1);
    restored = new ProjectStore(f.store.root); current = restored.tasks.get(f.pid, task.id); assert.equal(current.status, "paused"); assert.equal(current.attempts[0]!.status, "unknown"); assert.equal(restored.session(session.id).toolApproval, undefined);
    assert.throws(() => restored!.tasks.recordAttempt(f.pid, task.id, { expectedRevision: current.revision, id: randomUUID(), status: "reserved" }), /未知|额度/);
    assert.equal(f.runtimes.length, 1);
  } finally { await restored?.worker.close(); await f.cleanup(); }
});
