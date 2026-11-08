import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import Fastify from "fastify";
import { z } from "zod";
import { ProjectStore } from "./store.ts";
import { AgentHub } from "./agent.ts";
import { registerProjectRoutes } from "./project-routes.ts";

/** The real hub would bootstrap a runtime; deletion only touches its session registries. */
function hub(store: ProjectStore) {
  return Object.assign(Object.create(AgentHub.prototype), {
    store,
    clients: new Map(),
    tokens: new Map(),
    timers: new Map(),
    imports: new Map(),
    prompts: new Map(),
    frameSaves: new Map(),
    toolWaits: new Map(),
    toolTails: new Map(),
    toolEpochs: new Map(),
    promptTails: new Map(),
    staleTurns: new Map(),
    clientGenerationModes: new Map(),
    generationIntents: new Map(),
    transitioning: new Set(),
  }) as AgentHub;
}

async function fixture(options: { tasksEnabled?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "studio-project-delete-"));
  const store = new ProjectStore(join(root, "projects"), options);
  const agent = hub(store);
  const app = Fastify();
  app.setErrorHandler((error: any, request, reply) => {
    reply
      .code(error.statusCode || 400)
      .send({
        error:
          error instanceof z.ZodError
            ? error.issues.map((issue) => issue.message).join("；")
            : error.message,
      });
  });
  registerProjectRoutes(app, store, agent);
  return {
    root,
    store,
    app,
    close: async () => {
      await app.close();
      await store.worker.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const remove = (app: any, id: string, payload?: unknown) =>
  app.inject({
    method: "DELETE",
    url: `/api/projects/${id}`,
    ...(payload === undefined ? {} : { payload }),
  });

/** Ends the helper process and never lets a missing exit event hang the suite. */
function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5000);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

test("deletion removes exactly the confirmed project and leaves its neighbour usable", async () => {
  const f = await fixture();
  try {
    const keep = f.store.createProject("保留工程");
    const gone = f.store.createProject("删除工程");
    const keptDocument = f.store.markdown.create(keep.id, {
      name: "设定.md",
      text: "# 保留\n",
      requestId: randomUUID(),
    });
    const goneDocument = f.store.markdown.create(gone.id, {
      name: "设定.md",
      text: "# 将被删除\n",
      requestId: randomUUID(),
    });
    const keptSession = f.store.createSession(keep.id);
    const goneSession = f.store.createSession(gone.id);
    const goneDir = f.store.dir(gone.id);
    const keptDir = f.store.dir(keep.id);

    const response = await remove(f.app, gone.id, { name: "删除工程" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      deleted: true,
      projectId: gone.id,
      name: "删除工程",
      cleanupPending: false,
    });

    assert.equal(existsSync(goneDir), false);
    assert.equal(existsSync(keptDir), true);
    assert.equal(f.store.projects.has(gone.id), false);
    assert.equal(f.store.indexes.has(gone.id), false);
    assert.equal(f.store.metadataPaths.has(gone.id), false);
    assert.equal(f.store.resourceReaders.has(gone.id), false);
    assert.equal(f.store.sessions.has(goneSession.id), false);
    assert.throws(() => f.store.project(gone.id), /工程不存在/);

    // The neighbouring project keeps its files, resources, conversations and state.
    assert.equal(f.store.sessions.has(keptSession.id), true);
    assert.equal(
      readFileSync(f.store.safePath(keep.id, keptDocument.asset.file), "utf8"),
      "# 保留\n",
    );
    assert.deepEqual(
      f.store.assets(keep.id).map((asset) => asset.id),
      [keptDocument.asset.id],
    );
    assert.equal(f.store.state(keep.id).project.id, keep.id);
    const listed = await f.app.inject({ method: "GET", url: "/api/projects" });
    assert.deepEqual(
      listed.json().map((project: any) => project.id),
      [keep.id],
    );

    // A restart only finds the neighbour; the deleted document is not resurrected.
    const reopened = new ProjectStore(f.store.root);
    try {
      assert.deepEqual([...reopened.projects.keys()], [keep.id]);
      assert.deepEqual(
        reopened.assets(keep.id).map((asset) => asset.id),
        [keptDocument.asset.id],
      );
      assert.equal(reopened.markdown.read(keep.id, keptDocument.asset.id).text, "# 保留\n");
      assert.equal(reopened.sessions.has(goneSession.id), false);
      assert.equal(reopened.sessions.has(keptSession.id), true);
    } finally {
      await reopened.worker.close();
    }
  } finally {
    await f.close();
  }
});

test("a wrong or missing name, an unknown project or the last project deletes nothing", async () => {
  const f = await fixture();
  try {
    const only = f.store.createProject("唯一工程");
    const dir = f.store.dir(only.id);
    const wrong = await remove(f.app, only.id, { name: "唯一工程·改名" });
    assert.equal(wrong.statusCode, 409);
    assert.match(wrong.json().error, /名称/);
    const missing = await remove(f.app, only.id);
    assert.equal(missing.statusCode, 400);
    const unknown = await remove(f.app, randomUUID(), { name: "唯一工程" });
    assert.equal(unknown.statusCode, 404);
    const last = await remove(f.app, only.id, { name: "唯一工程" });
    assert.equal(last.statusCode, 409);
    assert.match(last.json().error, /至少保留一个工程/);
    assert.ok(existsSync(dir));
    assert.equal(f.store.projects.size, 1);

    // With a second project the same request is accepted, so the refusal was only the count.
    f.store.createProject("第二个工程");
    assert.equal((await remove(f.app, only.id, { name: "唯一工程" })).statusCode, 200);
    assert.equal(existsSync(dir), false);
  } finally {
    await f.close();
  }
});

test("a running conversation or an unfinished task blocks deletion until it stops", async () => {
  const f = await fixture({ tasksEnabled: true });
  try {
    const keep = f.store.createProject("保留工程");
    const target = f.store.createProject("忙碌工程");
    const session = f.store.createSession(target.id);
    session.status = "running";
    const busy = await remove(f.app, target.id, { name: "忙碌工程" });
    assert.equal(busy.statusCode, 409);
    assert.match(busy.json().error, /正在运行/);
    assert.ok(existsSync(f.store.dir(target.id)));

    session.status = "idle";
    // A real task needs generated media; the guard reads this one query, so stub it.
    const listActive = f.store.tasks.listActive;
    f.store.tasks.listActive = (id: string) =>
      id === target.id ? [{ status: "running" } as any] : listActive.call(f.store.tasks, id);
    const taskBound = await remove(f.app, target.id, { name: "忙碌工程" });
    assert.equal(taskBound.statusCode, 409);
    assert.match(taskBound.json().error, /制作任务/);
    assert.ok(existsSync(f.store.dir(target.id)));

    f.store.tasks.listActive = listActive;
    assert.equal((await remove(f.app, target.id, { name: "忙碌工程" })).statusCode, 200);
    assert.equal(f.store.sessions.has(session.id), false);
    assert.equal(f.store.projects.has(keep.id), true);
  } finally {
    await f.close();
  }
});

test("cached snapshots, reviews, drafts and jobs of the deleted project are dropped", async () => {
  const f = await fixture();
  try {
    const keep = f.store.createProject("保留工程");
    const gone = f.store.createProject("删除工程");
    const seeded = (projectId: string) => ({
      id: randomUUID(),
      projectId,
      createdAt: new Date().toISOString(),
    });
    const goneSnapshot = seeded(gone.id);
    const keptSnapshot = seeded(keep.id);
    f.store.animation.snapshots.set(goneSnapshot.id, goneSnapshot as any);
    f.store.animation.snapshots.set(keptSnapshot.id, keptSnapshot as any);
    const goneReview = seeded(gone.id);
    f.store.animation.reviews.set(goneReview.id, goneReview as any);
    const goneChange = seeded(gone.id);
    f.store.animation.changes.set(goneChange.id, goneChange as any);
    const goneJob = seeded(gone.id);
    f.store.interpolations.jobs.set(goneJob.id, goneJob as any);
    const goneDraft = randomUUID();
    f.store.frameDrafts.records.set(goneDraft, gone.id);

    assert.equal((await remove(f.app, gone.id, { name: "删除工程" })).statusCode, 200);

    assert.equal(f.store.animation.snapshots.has(goneSnapshot.id), false);
    assert.equal(f.store.animation.snapshots.has(keptSnapshot.id), true);
    assert.equal(f.store.animation.reviews.has(goneReview.id), false);
    assert.equal(f.store.animation.changes.has(goneChange.id), false);
    assert.equal(f.store.interpolations.jobs.has(goneJob.id), false);
    assert.equal(f.store.frameDrafts.records.has(goneDraft), false);
  } finally {
    await f.close();
  }
});

test("a project whose directory a live process pins is deleted anyway and swept on start", async () => {
  const root = mkdtempSync(join(tmpdir(), "studio-project-delete-locked-"));
  const projects = join(root, "projects");
  const store = new ProjectStore(projects);
  const ready = join(root, "child-ready");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    store.createProject("保留工程");
    const gone = store.createProject("被占用工程");
    const dir = store.dir(gone.id);

    // Windows refuses to remove (or rename) a directory that a process uses as its
    // working directory. This is exactly the reported EPERM, reproduced on purpose.
    child = spawn(
      process.execPath,
      [
        "-e",
        `process.chdir(${JSON.stringify(dir)});` +
          `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready");` +
          `setInterval(() => {}, 1000);`,
      ],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 200 && !existsSync(ready); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(ready), "child process must hold the project directory");

    const { project, cleanupPending } = store.deleteProject(gone.id, "被占用工程");
    assert.equal(project.name, "被占用工程");
    assert.equal(cleanupPending, true, "the pinned directory cannot be erased yet");
    // The project is gone from the workbench immediately, and the marker keeps it
    // out of the list even though bytes are still on disk.
    assert.equal(store.projects.has(gone.id), false);
    assert.throws(() => store.project(gone.id), /工程不存在/);
    assert.ok(existsSync(`${dir}.deleting`), "deletion marker stays until the erase finishes");

    // Release the working directory: the erase is only possible afterwards.
    await stop(child);
    child = undefined;

    const reopened = new ProjectStore(projects);
    try {
      assert.deepEqual(
        [...reopened.projects.values()].map((item) => item.name),
        ["保留工程"],
      );
      assert.equal(existsSync(dir), false, "restart finishes the erase");
      assert.equal(existsSync(`${dir}.deleting`), false);
    } finally {
      await reopened.worker.close();
    }
  } finally {
    if (child) await stop(child);
    await store.worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a marker left by an interrupted deletion hides and then sweeps the project", async () => {
  const root = mkdtempSync(join(tmpdir(), "studio-project-delete-sweep-"));
  const projects = join(root, "projects");
  let store: ProjectStore | undefined;
  try {
    store = new ProjectStore(projects);
    const keep = store.createProject("保留工程");
    await store.worker.close();
    store = undefined;

    // A crash between writing the marker and erasing the files leaves both behind.
    const interrupted = randomUUID();
    const dir = join(projects, interrupted);
    mkdirSync(join(dir, ".studio"), { recursive: true });
    writeFileSync(
      join(dir, "project.json"),
      JSON.stringify({
        id: interrupted,
        name: "中断删除",
        createdAt: new Date().toISOString(),
        version: 1,
      }),
    );
    writeFileSync(
      join(projects, `${interrupted}.deleting`),
      JSON.stringify({ projectId: interrupted, name: "中断删除" }),
    );

    const reopened = new ProjectStore(projects);
    try {
      assert.deepEqual([...reopened.projects.keys()], [keep.id]);
      assert.deepEqual(
        [...reopened.projects.values()].map((project) => project.name),
        ["保留工程"],
      );
      assert.equal(existsSync(dir), false);
      assert.equal(existsSync(`${dir}.deleting`), false);
    } finally {
      await reopened.worker.close();
    }
  } finally {
    if (store) await store.worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
