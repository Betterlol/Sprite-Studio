import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "./store.ts";
import { AgentHub } from "./agent.ts";
import { agentModels } from "./model.ts";

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(check());
}
function fixture() {
  const store = new ProjectStore(mkdtempSync(join(tmpdir(), "studio-model-")));
  const pid = store.createProject("模型切换验证").id,
    session = store.createSession(pid);
  const calls: any[] = [];
  session.threadId = "existing-thread";
  const client = {
    request: async (method: string, params: unknown) => {
      assert.equal(method, "turn/start");
      calls.push(params);
      return { turn: { id: `turn-${calls.length}` } };
    },
  };
  // Reuse a cached fake client; never initialize Codex or send a real model turn.
  const hub: AgentHub = Object.assign(Object.create(AgentHub.prototype), {
    store,
    clients: new Map([[session.id, client]]),
    timers: new Map(),
  });
  return { store, pid, session, hub, calls };
}

test("each requested model reaches the next turn on the same cached conversation and persists", async () => {
  const { store, session, hub, calls } = fixture();
  try {
    for (const model of agentModels) {
      session.status = "idle";
      hub.send(
        session.id,
        "继续调整",
        [],
        crypto.randomUUID(),
        undefined,
        [],
        undefined,
        model,
      );
      await waitFor(
        () =>
          session.turnId === `turn-${calls.length}` &&
          calls.length === agentModels.indexOf(model) + 1,
      );
      assert.equal(calls.at(-1).model, model);
      assert.equal(calls.at(-1).threadId, "existing-thread");
      assert.equal(session.model, model);
    }
    assert.equal(session.messages.length, 3);
    assert.equal(hub.clients.size, 1);
    const reloaded = new ProjectStore(store.root);
    try {
      assert.equal(reloaded.session(session.id).model, "gpt-6.1-terra");
    } finally {
      await reloaded.worker.close();
    }
    // An older client omitting the new field keeps the conversation's last model.
    session.status = "idle";
    hub.send(session.id, "继续", [], crypto.randomUUID());
    await waitFor(() => calls.length === 4 && session.turnId === "turn-4");
    assert.equal(calls[3].model, "gpt-6.1-terra");
  } finally {
    await store.worker.close();
  }
});

test("invalid and busy model changes preserve existing state; old sessions default to sol", async () => {
  const { store, session, hub, calls } = fixture();
  try {
    assert.throws(() =>
      hub.send(
        session.id,
        "不要发送",
        [],
        crypto.randomUUID(),
        undefined,
        [],
        undefined,
        "unknown-model",
      ),
    );
    assert.equal(session.messages.length, 0);
    assert.equal(session.model, undefined);
    hub.send(session.id, "首条消息", [], crypto.randomUUID());
    await waitFor(() => session.turnId === "turn-1");
    assert.equal(calls[0].model, "gpt-6.1-sol");
    assert.throws(
      () =>
        hub.send(
          session.id,
          "运行中切换",
          [],
          crypto.randomUUID(),
          undefined,
          [],
          undefined,
          "gpt-6.1-luna",
        ),
      /任务正在进行/,
    );
    assert.equal(session.model, "gpt-6.1-sol");
    assert.equal(session.messages.length, 1);
    assert.equal(calls.length, 1);
  } finally {
    await store.worker.close();
  }
});

test("interpolation forwards the selected model to its new conversation", async () => {
  const { store, pid, hub } = fixture();
  try {
    let sent: any[] | undefined;
    const job = {
      id: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      start: { imageId: "start" },
      end: { imageId: "end" },
      count: 2,
      description: "过渡",
      columns: 2,
      rows: 2,
    };
    hub.send = ((...args: any[]) => {
      sent = args;
      return {} as any;
    }) as any;
    store.interpolations = { jobs: new Map(), create: () => job } as any;
    hub.startInterpolation(pid, {
      requestId: job.id,
      clipId: crypto.randomUUID(),
      revision: "rev",
      startFrameId: crypto.randomUUID(),
      endFrameId: crypto.randomUUID(),
      count: 2,
      fps: 12,
      description: "过渡",
      model: "gpt-6.1-luna",
    });
    assert.equal(sent?.[7], "gpt-6.1-luna");
    assert.equal(sent?.[0], job.sessionId);
    assert.throws(() => hub.startInterpolation(pid, { model: "unknown" }));
  } finally {
    await store.worker.close();
  }
});
