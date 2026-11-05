import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { ProjectStore, atomicJson } from "./store.ts";
import { AgentHub } from "./agent.ts";
import { permissionTools, ToolPermissions } from "./tool-permissions.ts";

function resultText(result: Awaited<ReturnType<AgentHub["tool"]>>) {
  const item = result.content[0]!;
  assert.ok("text" in item);
  return item.text;
}
function fixture() {
  const store = new ProjectStore(
    mkdtempSync(join(tmpdir(), "studio-permission-")),
  );
  const pid = store.createProject("审批测试").id;
  const session = store.createSession(pid);
  // Host unit tests only: no App Server, model turn or generation request.
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
  assert.ok(check(), "expected pending approval or request");
}

test("only image saving asks by default; all tool policies persist and validate together", async () => {
  const { store } = fixture();
  try {
    const policies = store.permissions.read();
    assert.deepEqual(
      Object.entries(policies)
        .filter(([, p]) => p === "ask")
        .map(([n]) => n),
      ["save_image"],
    );
    assert.equal(Object.keys(policies).length, permissionTools.length);
    assert.equal(store.frameDrafts.policy(), "allow");
    store.permissions.write({ create_clip: "ask", slice_sheet: "deny" });
    const reloaded = new ToolPermissions(store.root).read();
    assert.equal(reloaded.create_clip, "ask");
    assert.equal(reloaded.slice_sheet, "deny");
    assert.equal(reloaded.save_image, "ask");
    assert.throws(() => store.permissions.write({ create_clip: "invalid" }));
    assert.throws(() => store.permissions.write({ unknown_tool: "allow" }));
    assert.equal(store.permissions.read().create_clip, "ask");
    atomicJson(store.permissions.path, { save_frame_draft: "deny" });
    assert.equal(store.permissions.read().save_frame_draft, "deny");
    assert.equal(store.permissions.read().save_image, "ask");
  } finally {
    await store.worker.close();
  }
});

test("approval holds execution and subsequent tools; denial returns guidance and acceptance uses frozen arguments", async () => {
  const { store, pid, session, hub } = fixture();
  try {
    store.permissions.write({ create_clip: "ask" });
    const args = {
      name: "原定动画",
      fps: 12,
      folder: ".",
      requestId: crypto.randomUUID(),
    };
    let settled = false,
      followingDone = false;
    const action = hub.tool(session.id, "create_clip", args).then((r) => {
      settled = true;
      return r;
    });
    const following = hub.tool(session.id, "list_assets", {}).then((r) => {
      followingDone = true;
      return r;
    });
    args.name = "未经审批修改";
    await waitFor(() => session.toolApproval);
    const id = session.toolApproval!.id;
    assert.equal(session.toolApproval!.arguments.name, "原定动画");
    assert.equal(store.assets(pid).length, 0);
    assert.equal(settled, false);
    assert.equal(followingDone, false);
    const other = store.createSession(pid);
    assert.throws(() => hub.resolveToolApproval(other.id, id, true), /已结束/);
    // Editing policy while reviewing does not silently accept the pending request.
    store.permissions.write({ create_clip: "allow" });
    assert.equal(settled, false);
    hub.resolveToolApproval(session.id, id, false, "先改名称为走路");
    const denied = await action;
    await following;
    assert.ok("isError" in denied && denied.isError);
    assert.match(resultText(denied), /先改名称/);
    assert.equal(store.assets(pid).length, 0);
    store.permissions.write({ create_clip: "ask" });
    const accepted = hub.tool(session.id, "create_clip", {
      ...args,
      name: "走路",
    });
    await waitFor(() => session.toolApproval);
    hub.resolveToolApproval(session.id, session.toolApproval!.id, true);
    const result = await accepted;
    assert.equal(JSON.parse(resultText(result)).name, "走路");
    assert.equal(store.assets(pid).length, 1);
    assert.throws(
      () => hub.resolveToolApproval(session.id, id, true),
      /已结束/,
    );
    store.permissions.write({ create_clip: "deny" });
    const blocked = await hub.tool(session.id, "create_clip", {
      ...args,
      requestId: crypto.randomUUID(),
    });
    assert.ok("isError" in blocked && blocked.isError);
    assert.equal(store.assets(pid).length, 1);
  } finally {
    hub.cancelTools(session, "结束");
    await store.worker.close();
  }
});

test("default image approval previews exact intent, denial writes nothing, Accept saves exactly once", async () => {
  const { store, pid, session, hub } = fixture();
  try {
    const path = join(store.root, "generated-fixture.png");
    const made = spawnSync(
      process.env.SPRITE_STUDIO_PYTHON || "python",
      [
        "-c",
        "from PIL import Image; import sys; Image.new('RGBA',(32,32),'red').save(sys.argv[1])",
        path,
      ],
      { windowsHide: true },
    );
    assert.equal(made.status, 0);
    const generated = await store.generated.capture(pid, session.id, {
      id: "local-fixture",
      savedPath: path,
    });
    const args = {
      generatedId: generated.id,
      type: "reference",
      name: "角色",
      folder: ".",
      requestId: crypto.randomUUID(),
    };
    const waiting = hub.tool(session.id, "save_image", args);
    await waitFor(() => session.toolApproval);
    assert.equal(session.toolApproval!.tool, "save_image");
    assert.deepEqual(session.toolApproval!.arguments, args);
    assert.equal(store.assets(pid).length, 0);
    hub.resolveToolApproval(
      session.id,
      session.toolApproval!.id,
      false,
      "先不保存",
    );
    const result = await waiting;
    assert.match(resultText(result), /先不保存/);
    assert.equal(store.assets(pid).length, 0);
    const accepted = hub.tool(session.id, "save_image", args);
    await waitFor(() => session.toolApproval);
    hub.resolveToolApproval(session.id, session.toolApproval!.id, true);
    const image = JSON.parse(resultText(await accepted));
    assert.equal(image.file, "Assets/参考图/角色.png");
    assert.equal(store.assets(pid).length, 1);
    assert.deepEqual(
      readFileSync(store.imagePath(pid, image.id)),
      readFileSync(path),
    );
    // A retry still asks, but reuses the same save receipt rather than adding a resource.
    const retry = hub.tool(session.id, "save_image", args);
    await waitFor(() => session.toolApproval);
    hub.resolveToolApproval(session.id, session.toolApproval!.id, true);
    await retry;
    assert.equal(store.assets(pid).length, 1);
  } finally {
    hub.cancelTools(session, "结束");
    await store.worker.close();
  }
});

test("stopping interrupts runtime before releasing approval and cancels queued actions", async () => {
  const { store, pid, session, hub } = fixture();
  try {
    store.permissions.write({ create_clip: "ask" });
    session.status = "running";
    session.turnId = "mock-turn";
    let interrupt!: () => void,
      didInterrupt = false;
    hub.clients.set(session.id, {
      request: () => {
        didInterrupt = true;
        return new Promise<void>((r) => {
          interrupt = r;
        });
      },
    } as any);
    const first = hub.tool(session.id, "create_clip", {
      name: "不要创建",
      requestId: crypto.randomUUID(),
    });
    const queued = hub.tool(session.id, "create_clip", {
      name: "也不要创建",
      requestId: crypto.randomUUID(),
    });
    const queueRejected = assert.rejects(queued, /任务已取消/);
    await waitFor(() => session.toolApproval);
    const stopping = hub.stop(session.id);
    await waitFor(() => didInterrupt);
    assert.ok(
      session.toolApproval,
      "request stays blocked until model interrupt is acknowledged",
    );
    interrupt();
    await stopping;
    await first;
    await queueRejected;
    assert.equal(session.status, "interrupted");
    assert.equal(session.toolApproval, undefined);
    assert.equal(store.assets(pid).length, 0);
    const reloaded = new ProjectStore(store.root);
    try {
      assert.equal(reloaded.session(session.id).toolApproval, undefined);
    } finally {
      await reloaded.worker.close();
    }
  } finally {
    hub.cancelTools(session, "结束");
    await store.worker.close();
  }
});

test("MCP transport keeps a tool call pending until the host supplies the approval result", async () => {
  let release!: () => void;
  const server = createServer((request, response) => {
    request.resume();
    release = () => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ content: [{ type: "text", text: "approved" }] }),
      );
    };
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  const child = spawn(
    process.execPath,
    ["studio/mcp.ts", `http://127.0.0.1:${port}`, crypto.randomUUID()],
    {
      env: { ...process.env, SPRITE_STUDIO_TOOL_TOKEN: "test-only" },
      windowsHide: true,
    },
  );
  const received: any[] = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => received.push(JSON.parse(line)));
  try {
    child.stdin.write(
      JSON.stringify({
        id: 1,
        method: "tools/call",
        params: { name: "save_image", arguments: {} },
      }) + "\n",
    );
    await waitFor(() => release);
    assert.equal(received.length, 0);
    child.stdin.write(JSON.stringify({ id: 2, method: "ping" }) + "\n");
    await waitFor(() => received.some((r) => r.id === 2));
    assert.equal(
      received.some((r) => r.id === 1),
      false,
    );
    release();
    await waitFor(() => received.some((r) => r.id === 1));
    assert.equal(
      received.find((r) => r.id === 1).result.content[0].text,
      "approved",
    );
  } finally {
    child.kill();
    lines.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
