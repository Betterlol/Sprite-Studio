import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { entryName } from "./library.ts";
import { publishFiles } from "./file-operations.ts";
import {
  assetRevision,
  sha256,
  StudioError,
  type ProjectStore,
} from "./store.ts";
import {
  frameTransformSchema,
  type ClipAsset,
  type ResourceCategory,
} from "./model.ts";

export const clipDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("clip"),
    initialFps: z.number().min(1).max(60),
    loop: z.boolean(),
    frames: z
      .array(
        z
          .object({
            id: z.string().uuid().optional(),
            imageId: z.string().uuid(),
            durationUs: z.number().int().min(1000).max(60000000),
            transform: frameTransformSchema.optional(),
          })
          .strict(),
      )
      .max(128),
  })
  .strict();
export const bytes = (value: unknown) =>
  Buffer.from(JSON.stringify(value, null, 2) + "\n");
export const clipBody = (asset: ClipAsset) => ({
  frames: asset.frames,
  loop: asset.loop,
  initialFps: asset.initialFps || 12,
  revision: asset.revision,
  origin: asset.origin,
  appliedInterpolationIds: asset.appliedInterpolationIds,
  appliedFrameChangeIds: asset.appliedFrameChangeIds,
  revertedFrameChangeIds: asset.revertedFrameChangeIds,
});
export function categoryPath(
  store: ProjectStore,
  pid: string,
  category: ResourceCategory,
  path = "",
) {
  const relative = path === "." ? "" : path;
  if (relative) relative.split("/").forEach(entryName);
  const folder = category + (relative ? "/" + relative : "");
  store.safePath(pid, `Assets/${folder}`);
  return folder;
}
export class ProjectDocuments {
  store: ProjectStore;
  constructor(store: ProjectStore) {
    this.store = store;
  }
  read(pid: string, id: string): any {
    if (this.store.clipDrafts?.has(pid, id)) return this.store.clipDrafts.read(pid, id);
    if (this.store.frameDrafts.has(id))
      return this.store.frameDrafts.read(pid, id);
    const asset = this.store.asset(pid, id);
    if (asset.type !== "clip") return this.store.sheets.read(pid, id);
    const path = asset.file! + ".config.json",
      full = this.store.safePath(pid, path),
      exists = existsSync(full);
    const text = exists
      ? readFileSync(full, "utf8")
      : bytes({
          schemaVersion: 1,
          type: "clip",
          initialFps: asset.initialFps || 12,
          loop: asset.loop,
          frames: asset.frames,
        }).toString();
    return {
      documentId: id,
      path,
      text,
      documentRevision: sha256(
        exists ? text : readFileSync(this.store.safePath(pid, asset.file!)),
      ),
      definitionRevision: asset.revision,
      exists,
      type: "clip",
    };
  }
  parse(pid: string, id: string, text: string) {
    if (this.store.clipDrafts?.has(pid, id)) return this.store.clipDrafts.validateText(pid, id, text);
    if (this.store.frameDrafts.has(id)) {
      this.store.frameDrafts.get(pid, id);
      return this.store.frameDrafts.parse(text);
    }
    if (this.store.asset(pid, id).type !== "clip")
      return this.store.sheets.parse(pid, id, text);
    if (Buffer.byteLength(text) > 256 * 1024)
      throw new StudioError("INVALID_DOCUMENT：配置超过256KB");
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new StudioError("INVALID_DOCUMENT：无效JSON");
    }
    const checked = clipDocumentSchema.safeParse(raw);
    if (!checked.success)
      throw new StudioError(
        "INVALID_DOCUMENT：" +
          checked.error.issues
            .map((i) => `/${i.path.join("/")} ${i.message}`)
            .join("；"),
      );
    const value = checked.data,
      ids = value.frames.flatMap((f) => (f.id ? [f.id] : []));
    if (new Set(ids).size !== ids.length)
      throw new StudioError("帧实例身份不能重复");
    const images = value.frames.map((f) => this.store.image(pid, f.imageId));
    if (
      images.some((image) => image.frameCount !== 1) ||
      new Set(images.map((image) => `${image.width}x${image.height}`)).size > 1
    )
      throw new StudioError("动画帧需要相同画布的静态图片");
    return value;
  }
  write(
    pid: string,
    documents: {
      documentId: string;
      expectedDocumentRevision: string;
      text: string;
    }[],
  ) {
    if (
      !documents.length ||
      documents.length > 16 ||
      new Set(documents.map((d) => d.documentId)).size !== documents.length
    )
      throw new StudioError("每次提交1至16份不同配置");
    const stagedOwners = new Map<string, string>();
    for (const input of documents) {
      if (!this.store.clipDrafts?.has(pid, input.documentId)) continue;
      const document = this.store.clipDrafts.read(pid, input.documentId), value = this.store.clipDrafts.validateText(pid, input.documentId, input.text);
      for (const frame of value.frames) {
        if (stagedOwners.has(frame.id) && stagedOwners.get(frame.id) !== document.draft.clipId) throw new StudioError("同一批配置不能把帧实例分配给不同动画");
        stagedOwners.set(frame.id, document.draft.clipId);
      }
    }
    const writes = documents.flatMap((input) => {
      if (this.store.clipDrafts?.has(pid, input.documentId)) return [this.store.clipDrafts.prepare(pid, input)];
      if (this.store.frameDrafts.has(input.documentId))
        return [this.store.frameDrafts.prepare(pid, input)];
      const asset = this.store.asset(pid, input.documentId);
      if (asset.type !== "clip") return [this.store.sheets.prepare(pid, input)];
      this.store.assertClipMutation(pid, asset.id);
      const current = this.read(pid, asset.id);
      if (current.documentRevision !== input.expectedDocumentRevision)
        throw new StudioError(
          "VERSION_CONFLICT：动画配置已变化，请重新读取",
          409,
        );
      const config = this.parse(pid, asset.id, input.text) as z.infer<
        typeof clipDocumentSchema
      >;
      const frames = config.frames.map((frame) => ({
          ...frame,
          id: frame.id || randomUUID(),
        })),
        next: ClipAsset = {
          ...asset,
          frames,
          loop: config.loop,
          initialFps: config.initialFps,
        };
      next.revision = assetRevision(next);
      return [
        { path: current.path, bytes: bytes({ ...config, frames }) },
        { path: asset.file!, bytes: bytes(clipBody(next)) },
        { path: this.store.metaPath(pid, asset.id), bytes: bytes(next) },
        {
          path: `.studio/history/${asset.id}-${asset.revision}.json`,
          bytes: bytes(asset),
        },
      ];
    });
    publishFiles(this.store, pid, writes, {
      kind: "write-documents",
      documentIds: documents.map((d) => d.documentId),
    });
    this.store.clipDrafts?.invalidateIndex(pid);
    return documents.map((d) => this.read(pid, d.documentId));
  }
  createClip(
    pid: string,
    input: { name: string; fps: number; folder?: string; requestId: string },
    provenance?: { sessionId: string; taskId: string; intentVersion: number; barrierVersion: number },
  ) {
    z.string().uuid().parse(input.requestId);
    z.number().min(1).max(60).parse(input.fps);
    entryName(input.name);
    const folder = categoryPath(this.store, pid, "动画", input.folder),
      receiptPath = `.studio/clip-requests/${input.requestId}.json`,
      receipt = this.store.safePath(pid, receiptPath),
      intent = sha256(JSON.stringify({ ...input, folder }));
    if (existsSync(receipt)) {
      const old = JSON.parse(readFileSync(receipt, "utf8"));
      if (old.intent !== intent)
        throw new StudioError(
          "VERSION_CONFLICT：同一创建请求不能更换参数",
          409,
        );
      return this.store.asset(pid, old.id) as ClipAsset;
    }
    mkdirSync(this.store.safePath(pid, `Assets/${folder}`), {
      recursive: true,
    });
    const location = this.store.library.uniqueName(
        pid,
        folder,
        input.name,
        false,
      ),
      asset: ClipAsset = {
        id: randomUUID(),
        type: "clip",
        ...location,
        folder,
        frames: [],
        loop: true,
        initialFps: input.fps,
        createdAt: new Date().toISOString(),
        revision: "",
      };
    asset.revision = assetRevision(asset);
    publishFiles(
      this.store,
      pid,
      [
        { path: asset.file!, bytes: bytes(clipBody(asset)) },
        { path: asset.file! + ".meta.json", bytes: bytes(asset) },
        {
          path: asset.file! + ".config.json",
          bytes: bytes({
            schemaVersion: 1,
            type: "clip",
            initialFps: input.fps,
            loop: true,
            frames: [],
          }),
        },
        { path: receiptPath, bytes: bytes({ id: asset.id, intent, provenance }) },
      ],
      { kind: "create-clip", id: asset.id },
    );
    return this.store.asset(pid, asset.id) as ClipAsset;
  }
}
