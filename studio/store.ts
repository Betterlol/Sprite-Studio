import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve, relative, extname, sep } from "node:path";
import { EventEmitter } from "node:events";
import { ImagingWorker } from "./worker.ts";
import {
  sliceSchema,
  transformSchema,
  clipSchema,
  type Project,
  type Asset,
  type ImageAsset,
  type ClipAsset,
  type AssetRole,
  type Session,
} from "./model.ts";

export class StudioError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}
export const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export function atomicJson(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  renameSync(temp, path);
}
const revision = (value: any) => {
  const { revision: _, ...body } = value;
  return sha256(JSON.stringify(body));
};
const now = () => new Date().toISOString();
const cleanName = (value: string) =>
  value
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .trim()
    .slice(0, 100) || "未命名";

export class ProjectStore extends EventEmitter {
  root: string;
  worker: ImagingWorker;
  projects = new Map<string, Project>();
  indexes = new Map<string, Map<string, Asset>>();
  sessions = new Map<string, Session>();
  constructor(root: string) {
    super();
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
    this.worker = new ImagingWorker(this.root);
    for (const name of readdirSync(this.root)) {
      const dir = join(this.root, name);
      if (!existsSync(join(dir, "project.json"))) continue;
      const project = JSON.parse(
        readFileSync(join(dir, "project.json"), "utf8"),
      ) as Project;
      if (project.version !== 1 || project.id !== name) continue;
      this.projects.set(project.id, project);
      this.loadAssets(project.id);
      const sessionDir = join(dir, ".studio", "sessions");
      if (existsSync(sessionDir))
        for (const file of readdirSync(sessionDir).filter((file) =>
          file.endsWith(".json"),
        )) {
          const session = JSON.parse(
            readFileSync(join(sessionDir, file), "utf8"),
          ) as Session;
          if (session.status === "running" || session.status === "starting") {
            session.status = "interrupted";
            session.error =
              "工作台已重新启动，上次任务没有自动重试。请查看成果后再继续。";
            for (const message of session.messages)
              if (message.status === "streaming")
                message.status = "interrupted";
          }
          session.prompt = undefined;
          this.sessions.set(session.id, session);
        }
    }
  }
  project(id: string) {
    const project = this.projects.get(id);
    if (!project) throw new StudioError("工程不存在", 404);
    return project;
  }
  dir(id: string) {
    this.project(id);
    return join(this.root, id);
  }
  safePath(projectId: string, file: string) {
    const root = this.dir(projectId);
    const path = resolve(root, file);
    if (
      !path.startsWith(root + sep) ||
      (existsSync(path) && realpathSync(path) !== path)
    )
      throw new StudioError("无效资源路径");
    return path;
  }
  createProject(name: string) {
    const project: Project = {
      id: randomUUID(),
      name: cleanName(name),
      createdAt: now(),
      version: 1,
    };
    const dir = join(this.root, project.id);
    for (const folder of [
      "Assets",
      ".studio/objects",
      ".studio/staging",
      ".studio/sessions",
      ".studio/history",
      "Exports",
    ])
      mkdirSync(join(dir, folder), { recursive: true });
    atomicJson(join(dir, "project.json"), project);
    this.projects.set(project.id, project);
    this.indexes.set(project.id, new Map());
    this.changed(project.id);
    return project;
  }
  private loadAssets(id: string) {
    const assets = new Map<string, Asset>();
    for (const file of readdirSync(join(this.dir(id), "Assets")).filter(
      (file) => file.endsWith(".meta.json"),
    )) {
      const asset = JSON.parse(
        readFileSync(join(this.dir(id), "Assets", file), "utf8"),
      ) as Asset;
      if (asset.type === "clip") {
        const body = JSON.parse(
          readFileSync(
            join(this.dir(id), "Assets", `${asset.id}.clip.json`),
            "utf8",
          ),
        );
        Object.assign(asset, body);
      }
      assets.set(asset.id, asset);
    }
    this.indexes.set(id, assets);
  }
  assets(projectId: string) {
    this.project(projectId);
    return [...this.indexes.get(projectId)!.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
  asset(projectId: string, id: string): Asset {
    const asset = this.indexes.get(projectId)?.get(id);
    if (!asset) throw new StudioError("资源不存在", 404);
    return asset;
  }
  image(projectId: string, id: string) {
    const asset = this.asset(projectId, id);
    if (asset.type !== "image") throw new StudioError("请选择图片资源");
    return asset;
  }
  imagePath(projectId: string, id: string, expectedRevision?: string) {
    const asset = this.image(projectId, id);
    if (expectedRevision && asset.revision !== expectedRevision)
      throw new StudioError("图片版本已经改变，请刷新后再试", 409);
    const path = this.safePath(projectId, asset.file);
    if (sha256(readFileSync(path)) !== asset.contentHash)
      throw new StudioError("图片已被外部修改，请重新导入以保留版本", 409);
    return path;
  }
  stage(projectId: string) {
    const path = join(this.dir(projectId), ".studio", "staging", randomUUID());
    mkdirSync(path);
    return path;
  }
  private saveAsset(projectId: string, asset: Asset) {
    asset.revision = revision(asset);
    if (asset.type === "clip")
      atomicJson(join(this.dir(projectId), "Assets", `${asset.id}.clip.json`), {
        frames: asset.frames,
        loop: asset.loop,
        origin: asset.origin,
      });
    const metadata =
      asset.type === "clip"
        ? (({ frames, loop, origin, ...meta }) => meta)(asset)
        : asset;
    atomicJson(
      join(this.dir(projectId), "Assets", `${asset.id}.meta.json`),
      metadata,
    );
    this.indexes.get(projectId)!.set(asset.id, asset);
    this.changed(projectId);
    return asset;
  }
  async importImage(
    projectId: string,
    filename: string,
    bytes: Buffer,
    role: AssetRole = "reference",
    origin?: ImageAsset["origin"],
  ) {
    if (bytes.length > 25 * 1024 * 1024)
      throw new StudioError("单张图片不能超过 25 MB");
    const extension = extname(filename).toLowerCase();
    const mime: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    };
    if (!mime[extension]) throw new StudioError("支持 PNG、JPEG、WebP 和 GIF");
    const stage = this.stage(projectId);
    const temp = join(stage, "input" + extension);
    writeFileSync(temp, bytes);
    const info = await this.worker.run("inspect", { path: temp });
    const id = randomUUID();
    const file = `Assets/${id}${extension}`;
    const contentHash = sha256(bytes);
    const object = join(this.dir(projectId), ".studio", "objects", contentHash);
    if (!existsSync(object)) writeFileSync(object, bytes, { flag: "wx" });
    writeFileSync(this.safePath(projectId, file), bytes, { flag: "wx" });
    return this.saveAsset(projectId, {
      id,
      name: cleanName(filename),
      type: "image",
      role,
      revision: "",
      createdAt: now(),
      file,
      contentHash,
      mime: mime[extension]!,
      ...info,
      origin,
    } as ImageAsset) as ImageAsset;
  }
  adopt(projectId: string, id: string, expected: string) {
    const old = this.image(projectId, id);
    if (old.revision !== expected)
      throw new StudioError("资源已改变，请刷新后再采纳", 409);
    atomicJson(
      join(
        this.dir(projectId),
        ".studio",
        "history",
        `${old.id}-${old.revision}.json`,
      ),
      old,
    );
    return this.saveAsset(projectId, { ...old, role: "source" });
  }
  async transform(
    projectId: string,
    id: string,
    expected: string,
    input: unknown,
  ) {
    const source = this.image(projectId, id);
    const path = this.imagePath(projectId, id, expected);
    const spec = transformSchema.parse(input);
    const outputDir = this.stage(projectId);
    const result = await this.worker.run("transform", {
      path,
      outputDir,
      transform: spec,
    });
    this.imagePath(projectId, id, expected);
    return this.importImage(
      projectId,
      `${source.name.replace(/\.[^.]+$/, "")}-调整.png`,
      readFileSync(result.files[0]),
      "candidate",
      { kind: "transform", assetId: id, revision: expected, operation: spec },
    );
  }
  async slice(projectId: string, id: string, expected: string, input: unknown) {
    const source = this.image(projectId, id);
    const path = this.imagePath(projectId, id, expected);
    const spec = sliceSchema.parse(input);
    const result = await this.worker.run("slice", {
      path,
      outputDir: this.stage(projectId),
      ...spec,
    });
    this.imagePath(projectId, id, expected);
    const images: ImageAsset[] = [];
    for (const [i, file] of (result.files as string[]).entries())
      images.push(
        await this.importImage(
          projectId,
          `${source.name.replace(/\.[^.]+$/, "")}-${String(i + 1).padStart(2, "0")}.png`,
          readFileSync(file),
          "candidate",
          {
            kind: "slice",
            assetId: id,
            revision: expected,
            operation: { columns: spec.columns, rows: spec.rows, index: i },
          },
        ),
      );
    const clip: ClipAsset = {
      id: randomUUID(),
      name: spec.name || `${source.name.replace(/\.[^.]+$/, "")} · 动画`,
      type: "clip",
      revision: "",
      createdAt: now(),
      loop: true,
      origin: { assetId: id, revision: expected },
      frames: images.map((image, i) => ({
        id: randomUUID(),
        imageId: image.id,
        durationUs:
          Math.round(((i + 1) * 1_000_000) / spec.fps) -
          Math.round((i * 1_000_000) / spec.fps),
      })),
    };
    return this.saveAsset(projectId, clip) as ClipAsset;
  }
  updateClip(projectId: string, id: string, input: unknown) {
    const old = this.asset(projectId, id);
    if (old.type !== "clip") throw new StudioError("请选择动画资源");
    const spec = clipSchema.parse(input);
    if (spec.revision !== old.revision)
      throw new StudioError("动画已被其他操作修改，请刷新后再保存", 409);
    if (
      new Set(spec.frames.map((frame) => frame.id)).size !== spec.frames.length
    )
      throw new StudioError("帧实例身份不能重复");
    const images = spec.frames.map((frame) =>
      this.image(projectId, frame.imageId),
    );
    if (images.some((image) => image.frameCount !== 1))
      throw new StudioError("动画帧需要使用静态图片");
    if (
      new Set(images.map((image) => `${image.width}x${image.height}`)).size !==
      1
    )
      throw new StudioError("同一动画内的帧需要相同画布");
    atomicJson(
      join(
        this.dir(projectId),
        ".studio",
        "history",
        `${old.id}-${old.revision}.json`,
      ),
      old,
    );
    return this.saveAsset(projectId, {
      ...old,
      frames: spec.frames,
      loop: spec.loop,
    }) as ClipAsset;
  }
  async exportClip(projectId: string, id: string) {
    const clip = this.asset(projectId, id);
    if (clip.type !== "clip") throw new StudioError("请选择动画资源");
    const frames = clip.frames.map((frame) => ({
      ...frame,
      path: this.imagePath(projectId, frame.imageId),
    }));
    const result = await this.worker.run("export", {
      path: frames[0]!.path,
      outputDir: this.stage(projectId),
      frames,
      loop: clip.loop,
    });
    return {
      path: result.files[0] as string,
      filename: cleanName(clip.name) + ".webp",
    };
  }
  createSession(projectId: string) {
    this.project(projectId);
    const session: Session = {
      id: randomUUID(),
      projectId,
      title: "新对话",
      status: "idle",
      messages: [],
      activities: [],
      createdAt: now(),
      updatedAt: now(),
    };
    this.sessions.set(session.id, session);
    this.saveSession(session);
    return session;
  }
  session(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new StudioError("对话不存在", 404);
    return session;
  }
  saveSession(session: Session) {
    session.updatedAt = now();
    atomicJson(
      join(
        this.dir(session.projectId),
        ".studio",
        "sessions",
        `${session.id}.json`,
      ),
      session,
    );
    this.emit("session", session);
  }
  changed(projectId: string) {
    this.emit("assets", { projectId });
  }
  state(projectId: string) {
    return {
      project: this.project(projectId),
      assets: this.assets(projectId),
      sessions: [...this.sessions.values()]
        .filter((session) => session.projectId === projectId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }
}
