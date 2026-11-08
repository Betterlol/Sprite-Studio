import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Fastify from "fastify";
import { ProjectStore } from "./store.ts";
import { AgentHub } from "./agent.ts";
import { registerWorkflowRoutes } from "./workflow-routes.ts";
import { captureTaskIntent } from "./workflow-agent.ts";
import { ordinaryAgentInstructions } from "./agent-instructions.ts";

class Runtime extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  async initialize() {}
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: params.threadId || "thread-current" } };
    if (method === "mcpServerStatus/list") return { data: [] };
    if (method === "turn/start") return { turn: { id: randomUUID() } };
    return {};
  }
  async close() {}
}
function host(store: ProjectStore) {
  const runtime = new Runtime();
  const hub: AgentHub = Object.assign(Object.create(AgentHub.prototype), {
    store, endpoint: "http://127.0.0.1:9999", clients: new Map(), tokens: new Map(), timers: new Map(), imports: new Map(), prompts: new Map(), frameSaves: new Map(), toolWaits: new Map(), toolTails: new Map(), toolEpochs: new Map(), promptTails: new Map(), staleTurns: new Map(), clientGenerationModes: new Map(), generationIntents: new Map(), transitioning: new Set(), disabled: [], status: { connected: true }, bootstrapPromise: Promise.resolve(), stopped: false,
  });
  (hub as any).createRuntime = () => runtime;
  return { hub, runtime };
}
async function waitFor(check: () => unknown) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check());
}
const text = (result: any) => JSON.parse(result.content[0].text);

test("tasks are disabled by default, including HTTP entry and MCP tool execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "studio-no-tasks-")), store = new ProjectStore(root);
  const { hub } = host(store), app = Fastify(), pid = store.createProject("ordinary").id, session = store.createSession(pid);
  registerWorkflowRoutes(app, store, hub);
  try {
    assert.equal(store.state(pid).tasksEnabled, false);
    assert.deepEqual(store.tasks.list(pid), []);
    assert.throws(() => store.tasks.create(pid, { requestId: randomUUID(), title: "no", description: "no" }), /停用/);
    for (const path of ["", `/${randomUUID()}/actions`, `/${randomUUID()}/direction`]) {
      assert.equal((await app.inject({ method: "POST", url: `/api/projects/${pid}/tasks${path}`, payload: {} })).statusCode, 404);
    }
    await assert.rejects(hub.tool(session.id, "workflow_task", { action: "status" }), /停用/);
    await assert.rejects(hub.taskAction(pid, randomUUID(), { action: "resume", expectedRevision: 1 }), /停用/);
    await assert.rejects(hub.decideTaskDirection(pid, randomUUID(), { accept: true, expectedRevision: 1 }), /停用/);
    const created = text(await hub.tool(session.id, "create_markdown", { name: "方案.md", text: "# 已确认目标", requestId: randomUUID() }));
    const updated = text(await hub.tool(session.id, "write_markdown", { assetId: created.asset.id, expectedRevision: created.asset.revision, text: "# 已确认目标\n\n阶段结果已记录。" }));
    assert.match(updated.text, /阶段结果/);
    await assert.rejects(hub.tool(session.id, "write_markdown", { assetId: created.asset.id, expectedRevision: created.asset.revision, text: "stale" }), /版本/);
    store.permissions.write({ write_markdown: "deny" });
    assert.equal((await hub.tool(session.id, "write_markdown", { assetId: created.asset.id, expectedRevision: updated.asset.revision, text: "not allowed" })).isError, true);
  } finally { await app.close(); await hub.close(); await store.worker.close(); rmSync(root, { recursive: true, force: true }); }
});

test("disabled mode preserves old task files and readonly drafts but removes active leases and runtime bindings", async () => {
  const root = mkdtempSync(join(tmpdir(), "studio-old-task-"));
  let store = new ProjectStore(root, { tasksEnabled: true });
  const pid = store.createProject("history").id, session = store.createSession(pid);
  const clip = store.createClip(pid, "empty", []);
  let task = store.tasks.create(pid, { requestId: randomUUID(), title: "old", description: "old", sessionId: session.id, target: { mode: "saved", clipId: clip.id } });
  session.taskId = task.id;
  session.workflowIntent = { taskId: task.id, intentVersion: task.intentVersion, barrierVersion: task.barrierVersion };
  const draft = store.clipDrafts.create(pid, { clipId: clip.id, revision: clip.revision }, "agent", session.id, { taskId: task.id, intentVersion: task.intentVersion });
  task = store.tasks.action(pid, task.id, { expectedRevision: task.revision, action: "resume" });
  store.saveSession(session);
  const taskPath = store.safePath(pid, `.studio/tasks/${task.id}.json`), original = readFileSync(taskPath, "utf8");
  await store.worker.close();
  store = new ProjectStore(root);
  const { hub, runtime } = host(store), old = store.session(session.id);
  try {
    assert.equal(readFileSync(taskPath, "utf8"), original, "no task restart recovery writes");
    assert.deepEqual(store.tasks.listActive(pid), []);
    assert.equal(store.tasks.protectsSession(pid, old.id), false);
    assert.equal(store.clipDrafts.read(pid, draft.documentId).draft.readOnly, true);
    assert.throws(() => store.clipDrafts.write(pid, draft.documentId, { expectedDocumentRevision: draft.documentRevision, text: draft.text }), /只读/);
    assert.equal(captureTaskIntent(store, old), undefined);
    assert.doesNotThrow(() => store.assertHumanClipWrite(pid, clip.id));
    hub.send(old.id, "好，请按已认可方案继续。", [], randomUUID(), undefined, [], undefined, undefined, undefined, task.id, "local");
    await waitFor(() => !!old.turnId);
    assert.equal(old.status, "running");
    assert.equal(old.messages.at(-1)!.taskId, undefined);
    const fresh = text(await hub.tool(old.id, "create_clip_draft", { clipId: clip.id, revision: clip.revision }));
    assert.notEqual(fresh.documentId, draft.documentId);
    assert.equal(fresh.draft.readOnly, undefined, "old session must not claim a newly created ordinary draft");
    assert.equal(fresh.draft.taskIndependent, true);
    await hub.tool(old.id, "write_documents", { documents: [{ documentId: fresh.documentId, expectedDocumentRevision: fresh.documentRevision, text: fresh.text }] });
    assert.equal(store.clipDrafts.read(pid, draft.documentId).draft.readOnly, true);
    const instructions = runtime.calls.find(call => call.method === "thread/start")!.params.developerInstructions;
    assert.equal(instructions, ordinaryAgentInstructions);
    assert.ok(!runtime.calls.find(call => call.method === "turn/start")!.params.input.some((input: any) => input.text?.startsWith("制作任务（")));
    await hub.stop(old.id);
    assert.equal(readFileSync(taskPath, "utf8"), original);
    store.deleteSession(old.id);
    assert.equal(readFileSync(taskPath, "utf8"), original);
  } finally { await hub.close(); await store.worker.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const enabled of [false, true]) test(`MCP inventory matches task mode ${enabled} and declares Markdown UUID format`, () => {
  const output = spawnSync(process.execPath, ["studio/mcp.ts", "http://127.0.0.1:9999", randomUUID()], {
    input: JSON.stringify({ id: 1, method: "tools/list" }) + "\n", encoding: "utf8", windowsHide: true,
    env: { ...process.env, SPRITE_STUDIO_TOOL_TOKEN: "fixture-only", SPRITE_STUDIO_TASKS_ENABLED: enabled ? "1" : "0" },
  });
  assert.equal(output.status, 0, output.stderr);
  const tools = JSON.parse(output.stdout.trim()).result.tools;
  assert.equal(tools.some((tool: any) => tool.name === "workflow_task"), enabled);
  assert.equal(tools.find((tool: any) => tool.name === "create_markdown").inputSchema.properties.requestId.format, "uuid");
  const frameSave = tools.find((tool: any) => tool.name === "save_frame_draft").description;
  assert.match(frameSave, /allow saves directly/);
  assert.doesNotMatch(frameSave, /Default policy asks/);
});

test("native plan updates use current thread/turn, persist, and never fabricate completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "studio-native-plan-"));
  const store = new ProjectStore(root), pid = store.createProject("plan").id, session = store.createSession(pid), { hub } = host(store);
  session.status = "running"; session.threadId = "thread-current"; session.turnId = "turn-current";
  const params = { threadId: session.threadId, turnId: session.turnId, explanation: "接续已有方案", plan: [{ step: "读取方案", status: "completed" }, { step: "更新阶段结果", status: "inProgress" }, { step: "检查文档", status: "pending" }] };
  const notify = (value: any) => (hub as any).notification(session, { method: "turn/plan/updated", params: value });
  try {
    await notify(params); assert.deepEqual(session.plan, params);
    await notify({ ...params, turnId: "wrong-turn", plan: [] }); assert.deepEqual(session.plan, params);
    await notify({ ...params, threadId: "wrong-thread", plan: [] }); assert.deepEqual(session.plan, params);
    await notify({ ...params, plan: [{ step: "invalid", status: "passed" }] }); assert.deepEqual(session.plan, params);
    await (hub as any).notification(session, { method: "turn/completed", params: { threadId: session.threadId, turn: { id: session.turnId, status: "completed" } } });
    assert.equal(session.status, "idle"); assert.deepEqual(session.plan, params);
    await notify({ ...params, plan: [] }); assert.deepEqual(session.plan, params);
    assert.deepEqual(JSON.parse(readFileSync(store.safePath(pid, `.studio/sessions/${session.id}.json`), "utf8")).plan, params);
    session.status = "running"; await notify({ ...params, plan: [] }); assert.deepEqual(session.plan!.plan, []);
  } finally { await hub.close(); await store.worker.close(); rmSync(root, { recursive: true, force: true }); }
});

test("ordinary instructions default to full production using configured tool permissions", () => {
  assert.match(ordinaryAgentInstructions, /完整目标为交付单位/);
  assert.match(ordinaryAgentInstructions, /继续完成待机/);
  assert.match(ordinaryAgentInstructions, /逐项完成所需的生成、切割、编排、检查、修正和保存/);
  assert.match(ordinaryAgentInstructions, /按实际制作需要安排/);
  assert.match(ordinaryAgentInstructions, /allow 直接执行/);
  assert.match(ordinaryAgentInstructions, /ask 调用后等待工具返回用户决定/);
  assert.match(ordinaryAgentInstructions, /优先更新已有文档/);
  assert.match(ordinaryAgentInstructions, /原生 update_plan/);
  assert.doesNotMatch(ordinaryAgentInstructions, /默认最多调用一次|首张生成授权|返回\s*pre-check|确认后.*切割/);
});
