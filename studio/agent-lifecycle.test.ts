import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectStore } from "./store.ts";
import { AgentHub } from "./agent.ts";
import { AppServer } from "./runtime/app-server.ts";

function fixture() {
  const store = new ProjectStore(
    mkdtempSync(join(tmpdir(), "studio-lifecycle-")),
  );
  const pid = store.createProject("审批恢复验证").id,
    session = store.createSession(pid);
  session.status = "running";
  session.threadId = "thread-current";
  session.turnId = "turn-current";
  const hub: AgentHub = Object.assign(Object.create(AgentHub.prototype), {
    store,
    imports: new Map(),
    timers: new Map(),
    frameSaves: new Map(),
    clients: new Map(),
    prompts: new Map(),
  });
  return { store, pid, session, hub };
}
async function waitFor(check: () => unknown) {
  for (let i = 0; i < 100 && !check(); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "expected pending request");
}

test("runtime callbacks use the real user-input method and protocol-shaped replies without waiting for an in-flight tool", async () => {
  const { store, session, hub } = fixture();
  const server = new AppServer(process.cwd(), [], [], {
    executable: process.execPath,
    prefix: [resolve("probes/fixtures/fake-app-server.ts")],
  });
  server.serverRequest = (request) =>
    (hub as any).requestInput(session, request);
  try {
    await server.initialize();
    hub.toolTails = new Map([[session.id, new Promise<void>(() => {})]]);
    const time = await server.request("callback", {
      method: "currentTime/read",
    });
    assert.ok(Math.abs(time.result.currentTimeAt - Date.now() / 1000) < 2);
    const waiting = server.request("callback", {
      method: "item/tool/requestUserInput",
      params: {
        threadId: session.threadId,
        turnId: session.turnId,
        questions: [
          { id: "q", question: "请选择方向", options: [{ label: "向右" }] },
        ],
      },
    });
    await waitFor(() => session.prompt);
    assert.deepEqual(session.prompt!.questions[0]!.options, ["向右"]);
    hub.answer(session.id, session.prompt!.id, { q: "向右" });
    assert.deepEqual((await waiting).result, {
      answers: { q: { answers: ["向右"] } },
    });
    assert.equal(session.status, "running");
    assert.equal(session.prompt, undefined);
    for (const [method, expected] of [
      [
        "mcpServer/elicitation/request",
        { action: "decline", content: null, _meta: null },
      ],
      ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
      ["item/fileChange/requestApproval", { decision: "decline" }],
    ] as const) {
      const response = await server.request("callback", { method });
      assert.deepEqual(response.result, expected);
      assert.equal(
        session.prompt,
        undefined,
        "unsupported native authorization must not become a fake save form",
      );
    }
    const errors: any[] = [];
    server.on("requestError", (e) => errors.push(e));
    const unsupported = await server.request("callback", {
      method: "unknown/request",
    });
    assert.equal(unsupported.error.code, -32601);
    assert.match(unsupported.error.message, /unknown\/request/);
    assert.equal(errors[0].method, "unknown/request");
    assert.equal(
      await server.request("echo", { value: "still connected" }),
      "still connected",
    );
  } finally {
    await server.close();
    await store.worker.close();
  }
});

test("Approve and Deny resume the same blocked tool without interrupting the conversation", async () => {
  const { store, pid, session, hub } = fixture();
  const runtimeCalls: string[] = [];
  hub.clients.set(session.id, {
    request: async (name: string) => {
      runtimeCalls.push(name);
      return {};
    },
  } as any);
  try {
    store.permissions.write({ create_clip: "ask" });
    const denied = hub.tool(session.id, "create_clip", {
      name: "先不创建",
      requestId: crypto.randomUUID(),
    });
    await waitFor(() => session.toolApproval);
    hub.resolveToolApproval(
      session.id,
      session.toolApproval!.id,
      false,
      "先换名称",
    );
    assert.match(JSON.stringify((await denied).content), /先换名称/);
    assert.equal(store.assets(pid).length, 0);
    assert.equal(session.status, "running");
    const approved = hub.tool(session.id, "create_clip", {
      name: "正式动画",
      requestId: crypto.randomUUID(),
    });
    await waitFor(() => session.toolApproval);
    hub.resolveToolApproval(session.id, session.toolApproval!.id, true);
    await approved;
    assert.equal(store.assets(pid).length, 1);
    assert.equal(session.status, "running");
    assert.equal(session.turnId, "turn-current");
    assert.deepEqual(runtimeCalls, []);
    assert.equal(session.toolApproval, undefined);
    assert.ok(session.diagnostics!.some((d) => /已拒绝/.test(d.message)));
    assert.ok(session.diagnostics!.some((d) => /已允许/.test(d.message)));
  } finally {
    hub.cancelTools(session, "结束");
    await store.worker.close();
  }
});

test("late completion from another turn cannot cancel current approval; premature completion is explicit", async () => {
  const { store, session, hub } = fixture();
  try {
    store.permissions.write({ create_clip: "ask" });
    const waiting = hub.tool(session.id, "create_clip", {
      name: "不应执行",
      requestId: crypto.randomUUID(),
    });
    await waitFor(() => session.toolApproval);
    const approvalId = session.toolApproval!.id;
    await (hub as any).notification(session, {
      method: "turn/completed",
      params: {
        threadId: session.threadId,
        turn: { id: "old-turn", status: "interrupted" },
      },
    });
    assert.equal(session.toolApproval!.id, approvalId);
    assert.equal(session.status, "running");
    await (hub as any).notification(session, {
      method: "turn/completed",
      params: {
        threadId: session.threadId,
        turn: { id: session.turnId, status: "completed" },
      },
    });
    await waiting;
    assert.equal(session.status, "interrupted");
    assert.match(session.error!, /等待用户决定/);
    assert.equal(session.toolApproval, undefined);
  } finally {
    hub.cancelTools(session, "结束");
    await store.worker.close();
  }
});

test("runtime retries, tool failures and missing terminal errors remain diagnosable", async () => {
  const { store, session, hub } = fixture();
  try {
    await (hub as any).notification(session, {
      method: "error",
      params: {
        threadId: session.threadId,
        turnId: session.turnId,
        willRetry: true,
        error: { message: "网络暂时断开" },
      },
    });
    assert.equal(session.status, "running");
    assert.equal(session.error, undefined);
    await (hub as any).notification(session, {
      method: "item/completed",
      params: {
        threadId: session.threadId,
        turnId: session.turnId,
        item: {
          id: "tool-failed",
          type: "mcpToolCall",
          tool: "slice_sheet",
          status: "failed",
          error: { message: "配置版本冲突" },
        },
      },
    });
    assert.equal(session.activities[0]!.detail, "配置版本冲突");
    await (hub as any).notification(session, {
      method: "turn/completed",
      params: {
        threadId: session.threadId,
        turn: { id: session.turnId, status: "failed", error: null },
      },
    });
    assert.equal(session.status, "failed");
    assert.match(session.error!, /未返回详细错误/);
    assert.ok(session.diagnostics!.some((d) => /网络暂时断开/.test(d.message)));
    assert.ok(session.diagnostics!.some((d) => /配置版本冲突/.test(d.message)));
    const reloaded = new ProjectStore(store.root);
    try {
      assert.ok(reloaded.session(session.id).diagnostics!.length >= 3);
    } finally {
      await reloaded.worker.close();
    }
  } finally {
    await store.worker.close();
  }
});

test("stopping releases active and queued questions instead of leaving callbacks orphaned", async () => {
  const { store, session, hub } = fixture();
  try {
    const question = {
      method: "item/tool/requestUserInput",
      params: {
        threadId: session.threadId,
        turnId: session.turnId,
        questions: [{ id: "q", question: "方向", options: null }],
      },
    };
    const first = (hub as any).requestInput(session, question),
      second = (hub as any).requestInput(session, question);
    await waitFor(() => session.prompt);
    await hub.stop(session.id);
    assert.deepEqual(await first, { answers: {} });
    assert.deepEqual(await second, { answers: {} });
    assert.equal(hub.prompts.size, 0);
    assert.equal(session.prompt, undefined);
    assert.equal(session.status, "interrupted");
    assert.match(session.error!, /任务已停止/);
  } finally {
    await store.worker.close();
  }
});

test("a late stop acknowledgement and import cleanup cannot overwrite a newer round", async () => {
  const { store, session, hub } = fixture();
  try {
    let acknowledge!: () => void;
    hub.clients.set(session.id, {
      request: () =>
        new Promise<void>((r) => {
          acknowledge = r;
        }),
    } as any);
    const stopping = hub.stop(session.id);
    session.turnId = "new-turn";
    session.status = "running";
    session.messages.push({
      id: "new-message",
      role: "user",
      text: "继续",
      assetIds: [],
      createdAt: new Date().toISOString(),
    });
    acknowledge();
    await stopping;
    assert.equal(session.status, "running");
    assert.equal(session.turnId, "new-turn");
    let finishImport!: () => void;
    hub.imports.set(session.id, [
      new Promise<void>((r) => {
        finishImport = r;
      }),
    ]);
    const completing = (hub as any).notification(session, {
      method: "turn/completed",
      params: {
        threadId: session.threadId,
        turn: { id: "new-turn", status: "completed" },
      },
    });
    session.turnId = undefined;
    session.status = "starting";
    session.messages.push({
      id: "next-message",
      role: "user",
      text: "再继续",
      assetIds: [],
      createdAt: new Date().toISOString(),
    });
    finishImport();
    await completing;
    assert.equal(session.status, "starting");
    assert.equal(session.error, undefined);
  } finally {
    await store.worker.close();
  }
});

test("nonblocking questions do not turn normal completion into an interruption, and host errors stay visible", async () => {
  const { store, session, hub } = fixture();
  try {
    const question = (hub as any).requestInput(session, {
      id: "optional",
      method: "item/tool/requestUserInput",
      params: {
        isBlocking: false,
        questions: [{ id: "q", question: "可选反馈", options: null }],
      },
    });
    await waitFor(() => session.prompt);
    session.error = "接收生成图片失败：模拟像素读入错误";
    await (hub as any).notification(session, {
      method: "turn/completed",
      params: {
        threadId: session.threadId,
        turn: { id: session.turnId, status: "completed" },
      },
    });
    await question;
    assert.equal(session.status, "idle");
    assert.match(session.error!, /像素读入错误/);
  } finally {
    await store.worker.close();
  }
});
