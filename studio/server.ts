import { permissionTools } from "./tool-permissions.ts";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { z } from "zod";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  createReadStream,
  realpathSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { ProjectStore, StudioError } from "./store.ts";
import { AgentHub } from "./agent.ts";
import { registerWorkflowRoutes } from "./workflow-routes.ts";
import { freezeEditingContext } from "./workflow-context.ts";
import { imageKindSchema } from "./model.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const dataRoot = resolve(
  process.env.SPRITE_STUDIO_DATA_DIR || join(repo, ".local", "studio"),
);
mkdirSync(dataRoot, { recursive: true });
const lockPath = join(dataRoot, "runtime.lock");
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  let alive = false;
  try {
    process.kill(lock.pid, 0);
    alive = true;
  } catch (error: any) {
    if (error.code !== "ESRCH") alive = true;
  }
  if (alive) throw new Error("这个工作台数据目录已被另一个进程打开");
  unlinkSync(lockPath);
}
writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { flag: "wx" });
const port = Number(process.env.PORT || 8766);
const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
const store = new ProjectStore(join(dataRoot, "projects"));
if (!store.projects.size) store.createProject("我的精灵工程");
const agent = new AgentHub(store, `http://127.0.0.1:${port}`);
const pid = (request: any) => z.string().uuid().parse(request.params.projectId);
const aid = (request: any) => z.string().uuid().parse(request.params.assetId);
await app.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});
app.addHook("onRequest", async (request, reply) => {
  const origin = request.headers.origin;
  if (
    origin &&
    origin !== `http://${request.headers.host}` &&
    origin !== "http://127.0.0.1:5173" &&
    origin !== "http://localhost:5173"
  )
    return reply.code(403).send({ error: "不接受来自其他网站的操作" });
});
app.setErrorHandler((error: any, request, reply) => {
  const message =
    error instanceof z.ZodError
      ? error.issues.map((issue) => issue.message).join("；")
      : error.message;
  reply.code(error.statusCode || 400).send({ error: message || "操作失败" });
});

registerWorkflowRoutes(app, store, agent);
const librarySelection = z.object({
  assetIds: z.array(z.string().uuid()).max(500).default([]),
  folders: z.array(z.string()).max(100).default([]),
});
app.post("/api/projects/:projectId/folders", async (request) => {
  const input = z
    .object({
      parent: z.string(),
      name: z.string(),
      libraryRevision: z.string(),
    })
    .parse(request.body);
  return {
    folder: store.library.createFolder(
      pid(request),
      input.parent,
      input.name,
      input.libraryRevision,
    ),
  };
});
app.post("/api/projects/:projectId/library/move", async (request) => {
  const input = z
    .object({
      selection: librarySelection,
      target: z.string(),
      name: z.string().optional(),
      libraryRevision: z.string(),
    })
    .parse(request.body);
  return store.library.relocate(
    pid(request),
    input.selection,
    input.target,
    input.libraryRevision,
    input.name,
  );
});
app.post("/api/projects/:projectId/library/delete-plan", async (request) =>
  store.library.planDelete(pid(request), librarySelection.parse(request.body)),
);
app.post("/api/projects/:projectId/library/delete", async (request) => {
  const input = z
    .object({ selection: librarySelection, libraryRevision: z.string() })
    .parse(request.body);
  return store.library.delete(
    pid(request),
    input.selection,
    input.libraryRevision,
  );
});
app.post("/api/projects/:projectId/library/restore", async (request) => {
  const input = z
    .object({ id: z.string().uuid(), libraryRevision: z.string() })
    .parse(request.body);
  return {
    assetIds: store.library.restore(
      pid(request),
      input.id,
      input.libraryRevision,
    ),
  };
});

app.get("/api/status", async () => ({ ...agent.status, ready: true }));
app.post("/api/connect", async () => {
  await agent.bootstrapPromise;
  agent.bootstrapPromise = agent.bootstrap();
  await agent.bootstrapPromise;
  return agent.status;
});
app.get("/api/projects", async () => [...store.projects.values()]);
app.post("/api/projects", async (request) => {
  const input = z
    .object({ name: z.string().trim().min(1).max(100) })
    .parse(request.body);
  return store.createProject(input.name);
});
app.get("/api/projects/:projectId", async (request) =>
  store.state(pid(request)),
);
app.get("/api/projects/:projectId/schemas/sheet-recipe", async () =>
  store.sheets.schema(),
);
app.get("/api/projects/:projectId/documents/:assetId", async (request) =>
  store.documents.read(pid(request), aid(request)),
);
app.post("/api/projects/:projectId/documents", async (request) => {
  const input = z
    .object({
      documents: z
        .array(
          z.object({
            documentId: z.string().uuid(),
            expectedDocumentRevision: z.string(),
            text: z.string(),
          }),
        )
        .min(1)
        .max(16),
    })
    .parse(request.body);
  return store.documents.write(pid(request), input.documents);
});
app.post(
  "/api/projects/:projectId/assets/:assetId/slice-config",
  async (request) => {
    const input = z
      .object({
        expectedDefinitionRevision: z.string(),
        requestId: z.string().uuid(),
      })
      .strict()
      .parse(request.body);
    return store.sheets.execute(
      pid(request),
      aid(request),
      input.expectedDefinitionRevision,
      input.requestId,
    );
  },
);
app.post("/api/projects/:projectId/import", async (request) => {
  const projectId = pid(request);
  store.project(projectId);
  const query = z
    .object({
      kind: imageKindSchema.default("reference"),
      folder: z.string().default(""),
    })
    .parse(request.query);
  const part = await request.file();
  if (!part) throw new StudioError("请选择图片");
  const buffer = await part.toBuffer();
  return store.importImage(
    projectId,
    part.filename,
    buffer,
    query.kind,
    undefined,
    query.folder,
  );
});
app.get("/api/projects/:projectId/images/:assetId", async (request, reply) => {
  const projectId = pid(request),
    imageId = aid(request);
  const asset = store.image(projectId, imageId);
  const query = z.object({ v: z.string().optional() }).parse(request.query);
  const path = store.imagePath(projectId, imageId, query.v);
  reply
    .type(asset.mime)
    .header(
      "Cache-Control",
      query.v ? "private, max-age=31536000, immutable" : "no-cache",
    );
  return reply.send(createReadStream(path));
});

app.post(
  "/api/projects/:projectId/assets/:assetId/transform",
  async (request) => {
    const input = z
      .object({ revision: z.string(), transform: z.unknown() })
      .parse(request.body);
    return store.transform(
      pid(request),
      aid(request),
      input.revision,
      input.transform,
    );
  },
);
app.post(
  "/api/projects/:projectId/assets/:assetId/transform-preview",
  async (request) => {
    const spec = z
      .object({ revision: z.string(), transform: z.unknown() })
      .parse(request.body);
    return store.previewTransform(
      pid(request),
      aid(request),
      spec.revision,
      spec.transform,
    );
  },
);
app.get(
  "/api/projects/:projectId/transform-previews/:previewId/image",
  async (request: any, reply) =>
    reply
      .type("image/png")
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .send(
        createReadStream(
          store.transformPreviewPath(pid(request), request.params.previewId),
        ),
      ),
);
app.post("/api/projects/:projectId/assets/:assetId/slice", async (request) => {
  const input = z
    .object({ revision: z.string(), spec: z.unknown() })
    .parse(request.body);
  return store.slice(pid(request), aid(request), input.revision, input.spec);
});
app.patch("/api/projects/:projectId/clips/:assetId", async (request) =>
  store.updateClip(pid(request), aid(request), request.body),
);
app.post("/api/projects/:projectId/reviews", async (request) => {
  const spec = z
    .object({
      snapshotId: z.string().uuid().optional(),
      draftId: z.string().uuid().optional(),
      documentRevision: z.string().optional(),
      clipId: z.string().uuid().optional(),
      revision: z.string().optional(),
      startFrameId: z.string().uuid().optional(),
      endFrameId: z.string().uuid().optional(),
    })
    .refine((input) => !!input.draftId || !!input.snapshotId || !!input.clipId)
    .parse(request.body);
  const context = freezeEditingContext(store, pid(request), { ...spec, mode: spec.draftId ? "draft" : "saved" });
  return store.animation.inspect(pid(request), { ...spec, snapshotId: context.snapshotId });
});
app.get(
  "/api/projects/:projectId/reviews/:reviewId/:kind",
  async (request: any, reply) => {
    const kind = z.enum(["contact", "onion"]).parse(request.params.kind),
      path = store.animation.evidence(
        pid(request),
        z.string().uuid().parse(request.params.reviewId),
        kind,
      );
    return reply
      .type("image/png")
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .send(createReadStream(path));
  },
);
app.get(
  "/api/projects/:projectId/snapshots/:snapshotId/images/:frameId",
  async (request: any, reply) => {
    const { path, image } = await store.animation.renderFrame(
      pid(request),
      z.string().uuid().parse(request.params.snapshotId),
      z.string().uuid().parse(request.params.frameId),
    );
    return reply
      .type(image.mime)
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .send(createReadStream(path));
  },
);
app.get(
  "/api/projects/:projectId/clips/:assetId/frames/:frameId/image",
  async (request: any, reply) => {
    const query = z.object({ v: z.string() }).parse(request.query);
    const snapshot = store.animation.capture(
      pid(request),
      aid(request),
      query.v,
    );
    const rendered = await store.animation.renderFrame(
      pid(request),
      snapshot.id,
      z.string().uuid().parse(request.params.frameId),
    );
    return reply
      .type(rendered.image.mime)
      .header("Cache-Control", "no-cache")
      .send(createReadStream(rendered.path));
  },
);
app.post("/api/projects/:projectId/frame-drafts", async (request) =>
  store.frameDrafts.create(pid(request), request.body as any, "human"),
);
app.post(
  "/api/projects/:projectId/frame-drafts/:draftId/preview",
  async (request: any) => {
    const spec = z.object({ documentRevision: z.string() }).parse(request.body);
    return store.frameDrafts.preview(
      pid(request),
      z.string().uuid().parse(request.params.draftId),
      spec.documentRevision,
    );
  },
);
app.post(
  "/api/projects/:projectId/frame-drafts/:draftId/save",
  async (request: any) => {
    const spec = z.object({ documentRevision: z.string() }).parse(request.body);
    const id = z.string().uuid().parse(request.params.draftId);
    if (store.frameDrafts.get(pid(request), id).status === "pending")
      throw new StudioError("请在审批卡片中处理这个保存请求", 409);
    return store.frameDrafts.save(pid(request), id, spec.documentRevision);
  },
);
app.post(
  "/api/projects/:projectId/frame-drafts/:draftId/discard",
  async (request: any) => {
    const spec = z.object({ documentRevision: z.string() }).parse(request.body);
    return store.frameDrafts.discard(
      pid(request),
      z.string().uuid().parse(request.params.draftId),
      spec.documentRevision,
    );
  },
);
app.get("/api/tool-permissions", async () => ({
  policies: store.permissions.read(),
  tools: permissionTools,
}));
app.put("/api/tool-permissions", async (request) => ({
  policies: store.permissions.write(request.body),
  tools: permissionTools,
}));
app.post("/api/sessions/:sessionId/tool-approval", async (request: any) => {
  const spec = z
    .object({
      approvalId: z.string().uuid(),
      accept: z.boolean(),
      reason: z.string().max(2000).default(""),
    })
    .strict()
    .parse(request.body);
  return agent.resolveToolApproval(
    request.params.sessionId,
    spec.approvalId,
    spec.accept,
    spec.reason,
  );
});
app.post("/api/sessions/:sessionId/frame-save", async (request: any) => {
  const spec = z
    .object({
      approvalId: z.string().uuid(),
      accept: z.boolean(),
      reason: z.string().max(2000).default(""),
    })
    .parse(request.body);
  return agent.resolveFrameSave(
    request.params.sessionId,
    spec.approvalId,
    spec.accept,
    spec.reason,
  );
});
app.post(
  "/api/projects/:projectId/frame-changes/:changeId/compare",
  async (request: any) =>
    store.animation.compare(
      pid(request),
      z.string().uuid().parse(request.params.changeId),
    ),
);
app.post(
  "/api/projects/:projectId/frame-changes/:changeId/revert",
  async (request: any) => {
    const input = z.object({ revision: z.string() }).parse(request.body);
    return store.animation.revert(
      pid(request),
      z.string().uuid().parse(request.params.changeId),
      input.revision,
    );
  },
);

app.post("/api/projects/:projectId/clips", async (request) => {
  const spec = z
    .object({
      name: z.string().trim().min(1).max(100),
      fps: z.number().min(1).max(60).default(12),
      folder: z.string().default(""),
      requestId: z.string().uuid(),
    })
    .parse(request.body);
  return store.documents.createClip(pid(request), spec);
});
app.get(
  "/api/projects/:projectId/generated/:generatedId/image",
  async (request: any, reply) =>
    reply
      .type("image/png")
      .send(
        createReadStream(
          store.generated.imagePath(
            pid(request),
            z.string().uuid().parse(request.params.generatedId),
          ),
        ),
      ),
);
app.post("/api/projects/:projectId/generated/save", async (request) => {
  const spec = z
    .object({
      generatedId: z.string().uuid(),
      type: z.enum(["reference", "resource"]),
      name: z.string(),
      folder: z.string().default(""),
      requestId: z.string().uuid(),
    })
    .strict()
    .parse(request.body);
  const asset = store.generated.save(pid(request), spec),
    generated = store.generated.record(pid(request), spec.generatedId);
  if (generated.interpolationId && spec.type === "resource")
    store.interpolations.receive(
      pid(request),
      generated.interpolationId,
      asset.id,
      { id: generated.generationId, inputImages: generated.inputImages },
    );
  return asset;
});
app.post("/api/projects/:projectId/interpolations", async (request, reply) =>
  reply.code(202).send(agent.startInterpolation(pid(request), request.body)),
);
app.post(
  "/api/projects/:projectId/interpolations/:interpolationId/insert",
  async (request: any) =>
    store.interpolations.insert(
      pid(request),
      z.string().uuid().parse(request.params.interpolationId),
      request.body,
    ),
);
app.get(
  "/api/projects/:projectId/clips/:assetId/export",
  async (request, reply) => {
    const exported = await store.exportClip(pid(request), aid(request));
    return reply
      .type("image/webp")
      .header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
      )
      .send(createReadStream(exported.path));
  },
);

app.post("/api/projects/:projectId/sessions", async (request) =>
  store.createSession(pid(request)),
);
app.delete("/api/sessions/:sessionId", async (request: any) => {
  await agent.deleteSession(request.params.sessionId);
  return { deleted: true };
});
app.get("/api/sessions/:sessionId", async (request: any) =>
  store.session(request.params.sessionId),
);
app.post("/api/sessions/:sessionId/stop", async (request: any) => {
  await agent.stop(request.params.sessionId);
  return store.session(request.params.sessionId);
});
app.post("/api/sessions/:sessionId/answer", async (request: any) => {
  const input = z
    .object({ promptId: z.string(), answers: z.record(z.string(), z.string()) })
    .parse(request.body);
  agent.answer(request.params.sessionId, input.promptId, input.answers);
  return store.session(request.params.sessionId);
});
app.post("/internal/tools/:sessionId", async (request: any) => {
  const expected = agent.tokens.get(request.params.sessionId);
  const actual = request.headers.authorization?.replace(/^Bearer /, "");
  if (
    !expected ||
    typeof actual !== "string" ||
    actual.length !== expected.length ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  )
    throw new StudioError("无效工具会话", 403);
  const input = z
    .object({
      name: z.string(),
      arguments: z.record(z.string(), z.unknown()).default({}),
    })
    .parse(request.body);
  if (
    !["starting", "running"].includes(
      store.session(request.params.sessionId).status,
    )
  )
    throw new StudioError("当前回合已结束，拒绝执行迟到的工具请求", 409);
  return agent.tool(request.params.sessionId, input.name, input.arguments);
});

app.get("/api/events", (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (type: string, data: unknown) => {
    if (!reply.raw.destroyed)
      reply.raw.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };
  const onAssets = (data: unknown) => send("assets", data);
  const onSession = (data: unknown) => send("session", data);
  const onStatus = (data: unknown) => send("status", data);
  store.on("assets", onAssets);
  store.on("session", onSession);
  store.on("status", onStatus);
  send("connected", { status: agent.status });
  const interval = setInterval(() => {
    if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
  }, 20_000);
  reply.raw.on("close", () => {
    clearInterval(interval);
    store.off("assets", onAssets);
    store.off("session", onSession);
    store.off("status", onStatus);
  });
});
const dist = join(repo, "dist");
if (existsSync(dist))
  await app.register(staticFiles, { root: dist, prefix: "/" });
else
  app.get("/", async (request, reply) =>
    reply.type("text/plain").send("请先运行 npm run build，再启动工作台。"),
  );

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await agent.close();
  store.worker.close();
  if (
    existsSync(lockPath) &&
    JSON.parse(readFileSync(lockPath, "utf8")).pid === process.pid
  )
    unlinkSync(lockPath);
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("exit", () => {
  if (existsSync(lockPath)) {
    try {
      if (JSON.parse(readFileSync(lockPath, "utf8")).pid === process.pid)
        unlinkSync(lockPath);
    } catch {}
  }
});
await app.listen({ host: "127.0.0.1", port });
console.log(`Sprite Studio: http://127.0.0.1:${port}`);
