import { z } from "zod";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extname } from "node:path";
import { entryName } from "./library.ts";
import { bytes, categoryPath } from "./documents.ts";
import { publishFiles } from "./file-operations.ts";
import {
  assetRevision,
  sha256,
  StudioError,
  type ProjectStore,
} from "./store.ts";
import type { ImageAsset } from "./model.ts";

export type GeneratedImage = {
  id: string;
  generationId: string;
  sessionId: string;
  projectId: string;
  path: string;
  contentHash: string;
  width: number;
  height: number;
  createdAt: string;
  inputImages: { sha256: string }[];
  interpolationId?: string;
  assetIds: string[];
};
export type GeneratedImageInfo = Omit<GeneratedImage, "path">;
export class GeneratedImages {
  store: ProjectStore;
  constructor(store: ProjectStore) {
    this.store = store;
  }
  list(pid: string, sessionId?: string): GeneratedImageInfo[] {
    const dir = this.store.safePath(pid, ".studio/generated");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map(
        (file) =>
          JSON.parse(
            readFileSync(
              this.store.safePath(pid, `.studio/generated/${file}`),
              "utf8",
            ),
          ) as GeneratedImage,
      )
      .filter((item) => !sessionId || item.sessionId === sessionId)
      .map(({ path, ...item }) => item)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  record(pid: string, id: string): GeneratedImage {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new StudioError("无效生成图片ID");
    const path = this.store.safePath(pid, `.studio/generated/${id}.json`);
    if (!existsSync(path)) throw new StudioError("生成图片不存在", 404);
    const record = JSON.parse(readFileSync(path, "utf8")) as GeneratedImage;
    if (record.id !== id || record.projectId !== pid || (this.store.sessions.has(record.sessionId) && this.store.session(record.sessionId).projectId !== pid)) throw new StudioError("生成图片不属于该工程或会话", 404);
    return record;
  }
  imagePath(pid: string, id: string) {
    const item = this.record(pid, id),
      path = this.store.safePath(pid, item.path);
    if (sha256(readFileSync(path)) !== item.contentHash)
      throw new StudioError("生成图片已变化");
    return path;
  }
  async capture(
    pid: string,
    sessionId: string,
    item: { id: string; savedPath: string; inputImages?: { sha256: string }[] },
    interpolationId?: string,
  ) {
    const old = this.list(pid, sessionId).find(
      (image) => image.generationId === item.id,
    );
    if (old) return old;
    // Only the trusted App Server completion event supplies this path. Model
    // tools accept opaque generated IDs, never filesystem paths. Copy bytes into
    // the project before inspection, as the previous generation importer did.
    const data = readFileSync(item.savedPath);
    if (data.length > 25 * 1024 * 1024)
      throw new StudioError("生成图片超过25MB");
    if (
      !data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new StudioError("生成结果需要PNG格式");
    const snapshot = join(this.store.stage(pid), "generated.png");
    writeFileSync(snapshot, data, { flag: "wx" });
    const info = await this.store.worker.run("inspect", { path: snapshot });
    if (info.frameCount !== 1) throw new StudioError("生成结果需要静态图片");
    const id = randomUUID(),
      record: GeneratedImage = {
        id,
        generationId: item.id,
        sessionId,
        projectId: pid,
        path: `.studio/generated/${id}.png`,
        contentHash: sha256(data),
        width: info.width,
        height: info.height,
        createdAt: new Date().toISOString(),
        inputImages: (item.inputImages || []).map((image) => ({
          sha256: image.sha256,
        })),
        interpolationId,
        assetIds: [],
      };
    publishFiles(
      this.store,
      pid,
      [
        { path: record.path, bytes: data },
        { path: `.studio/generated/${id}.json`, bytes: bytes(record) },
      ],
      { kind: "capture-generated", id },
    );
    const { path, ...publicItem } = record;
    return publicItem;
  }
  save(
    pid: string,
    input: {
      generatedId: string;
      type: "reference" | "resource";
      name: string;
      folder?: string;
      requestId: string;
    },
  ) {
    z.string().uuid().parse(input.requestId);
    z.enum(["reference", "resource"]).parse(input.type);
    const item = this.record(pid, input.generatedId),
      folder = categoryPath(
        this.store,
        pid,
        input.type === "reference" ? "参考图" : "原图素材",
        input.folder,
      );
    entryName(input.name);
    const name = extname(input.name) ? input.name : input.name + ".png";
    entryName(name);
    if (extname(name).toLowerCase() !== ".png")
      throw new StudioError("生成图片请保存为PNG，文件名可省略扩展名");
    const requestPath = `.studio/image-requests/${input.requestId}.json`,
      intent = sha256(JSON.stringify({ ...input, folder, name })),
      request = this.store.safePath(pid, requestPath);
    if (existsSync(request)) {
      const old = JSON.parse(readFileSync(request, "utf8"));
      if (old.intent !== intent)
        throw new StudioError(
          "VERSION_CONFLICT：同一保存请求不能更换参数",
          409,
        );
      return this.store.image(pid, old.id);
    }
    const file = `Assets/${folder}/${name}`;
    if (
      existsSync(this.store.safePath(pid, file)) ||
      existsSync(this.store.safePath(pid, file + ".meta.json"))
    )
      throw new StudioError(
        "目标位置已有同名文件，请改名；不会自动覆盖或拼接后缀",
        409,
      );
    const data = readFileSync(this.imagePath(pid, item.id)),
      asset: ImageAsset = {
        id: randomUUID(),
        type: "image",
        kind: input.type === "reference" ? "reference" : "image",
        name,
        folder,
        file,
        revision: "",
        createdAt: new Date().toISOString(),
        width: item.width,
        height: item.height,
        frameCount: 1,
        mime: "image/png",
        contentHash: item.contentHash,
        origin: {
          kind: "generation",
          runId: item.generationId,
          interpolationId: item.interpolationId,
        },
      };
    asset.revision = assetRevision(asset);
    publishFiles(
      this.store,
      pid,
      [
        { path: file, bytes: data },
        { path: file + ".meta.json", bytes: bytes(asset) },
        { path: `.studio/objects/${asset.contentHash}`, bytes: data },
        {
          path: `.studio/generated/${item.id}.json`,
          bytes: bytes({ ...item, assetIds: [...item.assetIds, asset.id] }),
        },
        { path: requestPath, bytes: bytes({ intent, id: asset.id }) },
      ],
      { kind: "save-generated", id: asset.id },
    );
    return this.store.image(pid, asset.id);
  }
}
