import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import Fastify from "fastify";
import { ProjectStore } from "./store.ts";
import { MAX_MARKDOWN_BYTES } from "./markdown.ts";
import { AgentHub } from "./agent.ts";
import { registerWorkflowRoutes } from "./workflow-routes.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "studio-markdown-"));
  const store = new ProjectStore(join(root, "projects"));
  const pid = store.createProject("普通Markdown").id;
  const create = (name = "设定.md", text = "# 小旅者\n\n保持原作外形。\n") => store.markdown.create(pid, { name, text, requestId: randomUUID() });
  const close = async () => { await store.worker.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, store, pid, create, close };
}
const result = (value: any) => JSON.parse(value.content[0].text);
function host(store: ProjectStore) {
  return Object.assign(Object.create(AgentHub.prototype), {
    store, endpoint: "http://127.0.0.1:9999", clients: new Map(), tokens: new Map(), timers: new Map(), imports: new Map(), prompts: new Map(), frameSaves: new Map(), toolWaits: new Map(), toolTails: new Map(), toolEpochs: new Map(), promptTails: new Map(), staleTurns: new Map(), clientGenerationModes: new Map(), generationIntents: new Map(), transitioning: new Set(), disabled: [], status: { connected: true }, bootstrapPromise: Promise.resolve(), stopped: false,
  }) as AgentHub;
}
async function waitFor(check: () => unknown) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), "expected asynchronous state");
}

test("Markdown creates real UTF-8 files, saves with CAS and survives restart without task linkage", async () => {
  const f = fixture();
  try {
    const original = f.create();
    assert.equal(original.asset.folder, "文档");
    assert.equal(readFileSync(f.store.safePath(f.pid, original.asset.file), "utf8"), original.text);
    const next = f.store.markdown.write(f.pid, original.asset.id, { expectedRevision: original.asset.revision, text: "# 修订\n\n允许动作卖萌。" });
    assert.notEqual(next.asset.revision, original.asset.revision);
    assert.throws(() => f.store.markdown.write(f.pid, original.asset.id, { expectedRevision: original.asset.revision, text: "覆盖新稿" }), /版本/);
    assert.equal(f.store.markdown.read(f.pid, original.asset.id).text, next.text);
    assert.equal(f.store.tasks.list(f.pid).length, 0);
    const reopened = new ProjectStore(f.store.root);
    try { assert.deepEqual(reopened.markdown.read(f.pid, original.asset.id), next); }
    finally { await reopened.worker.close(); }
  } finally { await f.close(); }
});

test("Markdown import validates extension, UTF-8, size and conflicts without overwriting", async () => {
  const f = fixture();
  try {
    const doc = f.store.markdown.import(f.pid, "设计.MD", Buffer.from("﻿# 设计\n中文"));
    assert.equal(doc.text, "# 设计\n中文");
    assert.throws(() => f.store.markdown.import(f.pid, "设计.MD", Buffer.from("overwrite")), /存在/);
    assert.throws(() => f.store.markdown.import(f.pid, "图.png", Buffer.from("text")), /\.md/);
    assert.throws(() => f.store.markdown.import(f.pid, "坏.md", Buffer.from([0xc0, 0xaf])), /UTF-8/);
    assert.throws(() => f.create("大.md", "x".repeat(MAX_MARKDOWN_BYTES + 1)), /256KB/);
    assert.throws(() => f.create("空字符.md", "a\0b"), /空字符/);
    assert.throws(() => f.create("../escape.md"), /名称/);
    const other = f.store.createProject("其他工程").id;
    assert.throws(() => f.store.markdown.read(other, doc.asset.id), /不存在/);
    assert.equal(f.store.markdown.read(f.pid, doc.asset.id).text, doc.text);
    assert.equal(f.store.assets(f.pid).length, 1);
  } finally { await f.close(); }
});

test("Markdown create request is idempotent, supports empty files, and rejects path and symlink escape", async t => {
  const f = fixture();
  try {
    const spec = { name: "空文档", text: "", requestId: randomUUID() };
    const first = f.store.markdown.create(f.pid, spec);
    assert.equal(first.asset.name, "空文档.md");
    assert.deepEqual(f.store.markdown.create(f.pid, spec), first);
    assert.throws(() => f.store.markdown.create(f.pid, { ...spec, text: "不同" }), /不同内容/);
    assert.throws(() => f.store.markdown.create(f.pid, { ...spec, requestId: randomUUID(), folder: "../其他" }), /目录|路径|链接/);
    const link = join(f.store.dir(f.pid), "Assets", "文档", "链接");
    try { symlinkSync(f.root, link, "junction"); }
    catch (error) { t.diagnostic("OS refused temporary link creation: " + (error as Error).message); return; }
    try { assert.throws(() => f.store.markdown.create(f.pid, { name: "逃逸.md", text: "", requestId: randomUUID(), folder: "链接" }), /链接|路径/); }
    finally { unlinkSync(link); }
  } finally { await f.close(); }
});

test("Markdown library rename, move and trash restore preserve identity and content without leases", async () => {
  const f = fixture();
  try {
    const doc = f.create(), selection = { assetIds: [doc.asset.id], folders: [] };
    f.store.library.createFolder(f.pid, "文档", "草案", f.store.library.revision(f.pid));
    f.store.library.relocate(f.pid, selection, "文档/草案", f.store.library.revision(f.pid), "新名.md");
    assert.equal(f.store.markdown.read(f.pid, doc.asset.id).text, doc.text);
    assert.equal(f.store.asset(f.pid, doc.asset.id).name, "新名.md");
    assert.throws(() => f.store.library.relocate(f.pid, selection, "文档/草案", f.store.library.revision(f.pid), "伪装.png"), /扩展名/);
    assert.throws(() => f.store.library.relocate(f.pid, selection, "参考图", f.store.library.revision(f.pid)), /分类/);
    assert.deepEqual(f.store.library.planDelete(f.pid, selection).blockers, []);
    const trash = f.store.library.delete(f.pid, selection, f.store.library.revision(f.pid));
    assert.throws(() => f.store.markdown.read(f.pid, doc.asset.id), /不存在/);
    assert.deepEqual(f.store.library.restore(f.pid, trash.id, f.store.library.revision(f.pid)), [doc.asset.id]);
    assert.equal(f.store.markdown.read(f.pid, doc.asset.id).text, doc.text);
    assert.equal(f.store.markdown.read(f.pid, doc.asset.id).asset.revision, doc.asset.revision);
  } finally { await f.close(); }
});

test("existing projects only gain the missing document directory, and external edits cannot be overwritten", async () => {
  const f = fixture();
  try {
    const projectBytes = readFileSync(join(f.store.dir(f.pid), "project.json"));
    rmdirSync(join(f.store.dir(f.pid), "Assets", "文档"));
    const reopened = new ProjectStore(f.store.root);
    try {
      assert.ok(existsSync(join(f.store.dir(f.pid), "Assets", "文档")));
      assert.deepEqual(readFileSync(join(f.store.dir(f.pid), "project.json")), projectBytes);
    } finally { await reopened.worker.close(); }
    const doc = f.create();
    writeFileSync(f.store.safePath(f.pid, doc.asset.file), "外部新文字");
    assert.throws(() => f.store.markdown.write(f.pid, doc.asset.id, { text: "覆盖", expectedRevision: doc.asset.revision }), /外部修改/);
    assert.equal(readFileSync(f.store.safePath(f.pid, doc.asset.file), "utf8"), "外部新文字");
    assert.throws(() => f.store.documents.read(f.pid, doc.asset.id), /read_markdown/);
    assert.throws(() => f.store.documents.write(f.pid, [{ documentId: doc.asset.id, expectedDocumentRevision: doc.asset.revision, text: "{}" }]), /write_markdown/);
    assert.throws(() => f.store.image(f.pid, doc.asset.id), /图片/);
    assert.throws(() => f.store.animation.clip(f.pid, doc.asset.id), /动画/);
  } finally { await f.close(); }
});

test("Agent Markdown tools use the existing permissions and exact revision saves, not adoption or tasks", async () => {
  const f = fixture(), hub = host(f.store), session = f.store.createSession(f.pid);
  try {
    const created = result(await hub.tool(session.id, "create_markdown", { name: "计划.md", text: "只规划", requestId: randomUUID() }));
    const listed = result(await hub.tool(session.id, "list_assets", {}));
    assert.equal(listed.find((asset: any) => asset.id === created.asset.id).type, "markdown");
    assert.equal(result(await hub.tool(session.id, "read_markdown", { assetId: created.asset.id })).text, "只规划");
    const saved = result(await hub.tool(session.id, "write_markdown", { assetId: created.asset.id, expectedRevision: created.asset.revision, text: "实际规划" }));
    assert.equal(saved.text, "实际规划");
    await assert.rejects(hub.tool(session.id, "write_markdown", { assetId: created.asset.id, expectedRevision: created.asset.revision, text: "旧稿" }), /版本/);
    f.store.permissions.write({ write_markdown: "deny" });
    const denied = await hub.tool(session.id, "write_markdown", { assetId: created.asset.id, expectedRevision: saved.asset.revision, text: "无权限" });
    assert.equal(denied.isError, true);
    assert.equal(f.store.markdown.read(f.pid, created.asset.id).text, "实际规划");
    f.store.permissions.write({ create_markdown: "ask" });
    const pending = hub.tool(session.id, "create_markdown", { name: "不创建.md", text: "no", requestId: randomUUID() });
    await waitFor(() => session.toolApproval);
    hub.resolveToolApproval(session.id, session.toolApproval!.id, false, "不要新建");
    assert.equal((await pending).isError, true);
    assert.equal(f.store.assets(f.pid).length, 1);
    assert.equal(f.store.tasks.list(f.pid).length, 0);
  } finally { await hub.close(); await f.close(); }
});

class StubRuntime extends EventEmitter {
  calls: { method: string; input: any }[] = [];
  async initialize() {}
  async request(method: string, input: any) {
    this.calls.push({ method, input });
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "markdown-stub" } };
    if (method === "turn/start") return { turn: { id: randomUUID() } };
    if (method === "mcpServerStatus/list") return { data: [] };
    return {};
  }
  async close() {}
}

test("ordinary HTTP chat sends real document text with image input; stale refs reject before session mutation; history survives deletion", async () => {
  const f = fixture(), hub = host(f.store), runtime = new StubRuntime(), app = Fastify();
  (hub as any).createRuntime = () => runtime;
  app.setErrorHandler((error: any, _request, reply) => reply.code(error.statusCode || 400).send({ error: error.message }));
  registerWorkflowRoutes(app, f.store, hub);
  try {
    const png = join(f.root, "reference.png");
    const made = spawnSync(process.env.SPRITE_STUDIO_PYTHON || "python", ["-I", "-c", "from PIL import Image; import sys; Image.new('RGBA',(16,16),'red').save(sys.argv[1])", png], { windowsHide: true });
    assert.equal(made.status, 0, made.stderr.toString());
    const image = await f.store.importImage(f.pid, "reference.png", readFileSync(png), "reference");
    const doc = f.create(), session = f.store.createSession(f.pid), before = JSON.stringify(session);
    const body = { text: "只理解设定并规划，不生图", assetIds: [image.id], markdownReferences: [{ id: doc.asset.id, revision: "stale" }], requestId: randomUUID() };
    const rejected = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: body });
    assert.equal(rejected.statusCode, 409); assert.equal(JSON.stringify(session), before);
    const valid = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { ...body, markdownReferences: [{ id: doc.asset.id, revision: doc.asset.revision }] } });
    assert.equal(valid.statusCode, 202, valid.body);
    f.store.markdown.write(f.pid, doc.asset.id, { expectedRevision: doc.asset.revision, text: "发送后的新正文" });
    await waitFor(() => runtime.calls.some(call => call.method === "turn/start"));
    const inputs = runtime.calls.find(call => call.method === "turn/start")!.input.input;
    assert.ok(inputs.some((input: any) => input.type === "text" && input.text.includes("保持原作外形")));
    assert.ok(!inputs.some((input: any) => input.type === "text" && input.text.includes("发送后的新正文")));
    assert.ok(inputs.some((input: any) => input.type === "localImage"));
    assert.equal(session.taskId, undefined); assert.equal(f.store.tasks.list(f.pid).length, 0);
    await hub.stop(session.id);
    const entry = f.store.library.delete(f.pid, { assetIds: [doc.asset.id], folders: [] }, f.store.library.revision(f.pid));
    assert.equal(entry.assets[0]!.id, doc.asset.id);
    assert.equal(session.messages[0]!.markdownReferences![0]!.text, doc.text);
  } finally { await hub.close(); await app.close(); await f.close(); }
});
