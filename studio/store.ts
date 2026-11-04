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
  lstatSync,
} from "node:fs";
import { join, resolve, relative, extname, sep } from "node:path";
import { EventEmitter } from "node:events";
import { ImagingWorker } from "./worker.ts";
import { InterpolationStore } from "./interpolation.ts";
import { AnimationStore } from "./animation.ts";
import { ResourceLibrary, assetFolder } from "./library.ts";
import {
  sliceSchema,
  transformSchema,
  clipSchema,
  type Project,
  type Asset,
  type ImageAsset,
  type ClipAsset,
  type ImageKind,
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
  const { revision: _, name, folder, file, ...body } = value;
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
  interpolations: InterpolationStore;
  animation: AnimationStore;
  library: ResourceLibrary;
  metadataPaths = new Map<string, Map<string, string>>();
  resourceReaders = new Map<string, number>();
  constructor(root: string) {
    super();
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
    this.worker = new ImagingWorker(this.root);
    this.library = new ResourceLibrary(this);
    for (const name of readdirSync(this.root)) {
      const dir = join(this.root, name);
      if (!existsSync(join(dir, "project.json"))) continue;
      const project = JSON.parse(
        readFileSync(join(dir, "project.json"), "utf8"),
      ) as Project;
      if (project.version !== 1 || project.id !== name) continue;
      this.projects.set(project.id, project);
      this.library.recover(project.id);
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
    this.interpolations = new InterpolationStore(this);
    this.animation = new AnimationStore(this);
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
    let parent = path;
    while (parent !== root) {
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
        throw new StudioError("资源路径不能经过链接");
      parent = resolve(parent, "..");
    }
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
    this.metadataPaths.set(project.id, new Map());
    this.changed(project.id);
    return project;
  }
  loadAssets(id: string) {
    const assets = new Map<string, Asset>();
    const metadata = new Map<string, string>();
    for (const folder of this.library.folders(id)) {
      const base = `Assets${folder ? "/" + folder : ""}`;
      for (const file of readdirSync(this.safePath(id, base)).filter((file) =>
        file.endsWith(".meta.json"),
      )) {
        const asset = JSON.parse(
          readFileSync(this.safePath(id, `${base}/${file}`), "utf8"),
        ) as Asset;
        if (asset.type === "image") {
          const legacy = asset as ImageAsset & { role?: string };
          legacy.kind ??= legacy.role === "reference" ? "reference" : "image";
          delete legacy.role;
        }
        asset.folder = folder;
        if (asset.type === "clip")
          asset.file ||= `${base}/${asset.id}.clip.json`;
        if (assets.has(asset.id))
          throw new StudioError(
            "同一资源身份出现在多个位置，请保留文件并处理冲突",
          );
        metadata.set(asset.id, `${base}/${file}`);
        if (asset.type === "clip") {
          const body = JSON.parse(
            readFileSync(this.safePath(id, asset.file!), "utf8"),
          );
          Object.assign(asset, body);
        }
        assets.set(asset.id, asset);
      }
    }
    this.indexes.set(id, assets);
    this.metadataPaths.set(id, metadata);
  }
  metaPath(pid: string, id: string) {
    const path = this.metadataPaths.get(pid)?.get(id);
    if (!path) throw new StudioError("资源元数据不存在", 404);
    return path;
  }
  async reading<T>(pid: string, task: () => Promise<T>): Promise<T> {
    this.resourceReaders.set(pid, (this.resourceReaders.get(pid) || 0) + 1);
    try {
      return await task();
    } finally {
      this.resourceReaders.set(pid, this.resourceReaders.get(pid)! - 1);
    }
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
    if (!asset.file) {
      const folder =
        asset.folder ??
        (asset.origin?.assetId
          ? assetFolder(this.asset(projectId, asset.origin.assetId))
          : "");
      Object.assign(
        asset,
        this.library.uniqueName(
          projectId,
          folder,
          cleanName(asset.name),
          asset.type === "image",
        ),
        { folder },
      );
    }
    asset.revision = revision(asset);
    if (asset.type === "clip")
      atomicJson(this.safePath(projectId, asset.file!), {
        frames: asset.frames,
        revision: asset.revision,
        loop: asset.loop,
        origin: asset.origin,
        appliedInterpolationIds: asset.appliedInterpolationIds,
        appliedFrameChangeIds: asset.appliedFrameChangeIds,
        revertedFrameChangeIds: asset.revertedFrameChangeIds,
      });
    const metadata =
      asset.type === "clip"
        ? (({
            frames,
            loop,
            origin,
            appliedInterpolationIds,
            appliedFrameChangeIds,
            revertedFrameChangeIds,
            ...meta
          }) => meta)(asset)
        : asset;
    const metaPath =
      this.metadataPaths.get(projectId)?.get(asset.id) ||
      `${asset.file}.meta.json`;
    atomicJson(this.safePath(projectId, metaPath), metadata);
    this.metadataPaths.get(projectId)!.set(asset.id, metaPath);
    this.indexes.get(projectId)!.set(asset.id, asset);
    this.changed(projectId);
    return asset;
  }
  async importImage(
    projectId: string,
    filename: string,
    bytes: Buffer,
    kind: ImageKind = "reference",
    origin?: ImageAsset["origin"],
    folder?: string,
  ) {
    return this.reading(projectId, async () => {
      folder ??= origin?.assetId
        ? assetFolder(this.asset(projectId, origin.assetId))
        : "";
      this.library.folder(projectId, folder);
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
      if (!mime[extension])
        throw new StudioError("支持 PNG、JPEG、WebP 和 GIF");
      const stage = this.stage(projectId);
      const temp = join(stage, "input" + extension);
      writeFileSync(temp, bytes);
      const info = await this.worker.run("inspect", { path: temp });
      const id = randomUUID();
      const location = this.library.uniqueName(
        projectId,
        folder,
        cleanName(filename.slice(0, -extension.length)).slice(0, 80) +
          extension,
        true,
      );
      const file = location.file;
      const contentHash = sha256(bytes);
      const object = join(
        this.dir(projectId),
        ".studio",
        "objects",
        contentHash,
      );
      if (!existsSync(object)) writeFileSync(object, bytes, { flag: "wx" });
      writeFileSync(this.safePath(projectId, file), bytes, { flag: "wx" });
      return this.saveAsset(projectId, {
        id,
        name: location.name,
        folder,
        type: "image",
        kind,
        revision: "",
        createdAt: now(),
        file,
        contentHash,
        mime: mime[extension]!,
        ...info,
        origin,
      } as ImageAsset) as ImageAsset;
    });
  }
  async transform(
    projectId: string,
    id: string,
    expected: string,
    input: unknown,
  ) {
    return this.reading(projectId, async () => {
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
        "image",
        { kind: "transform", assetId: id, revision: expected, operation: spec },
      );
    });
  }
  async slice(projectId: string, id: string, expected: string, input: unknown) {
    return this.reading(projectId, async () => {
      const source = this.image(projectId, id);
      const path = this.imagePath(projectId, id, expected);
      const spec = sliceSchema.parse(input);
      const result = await this.worker.run("slice", {
        path,
        outputDir: this.stage(projectId),
        ...spec,
      });
      this.imagePath(projectId, id, expected);
      const folder = this.library.outputFolder(
        projectId,
        assetFolder(source),
        `${source.name.replace(/\.[^.]+$/, "")} · 切片`,
      );
      const images: ImageAsset[] = [];
      for (const [i, file] of (result.files as string[]).entries())
        images.push(
          await this.importImage(
            projectId,
            `${source.name.replace(/\.[^.]+$/, "")}-${String(i + 1).padStart(2, "0")}.png`,
            readFileSync(file),
            "image",
            {
              kind: "slice",
              assetId: id,
              revision: expected,
              operation: { columns: spec.columns, rows: spec.rows, index: i },
            },
            folder,
          ),
        );
      const clip: ClipAsset = {
        id: randomUUID(),
        name: spec.name || `${source.name.replace(/\.[^.]+$/, "")} · 动画`,
        type: "clip",
        folder,
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
    });
  }
  createClip(
    projectId: string,
    name: string,
    frames: ClipAsset["frames"],
    origin?: ClipAsset["origin"],
    loop = true,
    folder?: string,
  ) {
    clipSchema.parse({ revision: "", frames, loop });
    const images = frames.map((frame) => this.image(projectId, frame.imageId));
    if (
      images.some((image) => image.frameCount !== 1) ||
      new Set(images.map((image) => `${image.width}x${image.height}`)).size !==
        1
    )
      throw new StudioError("动画帧需要相同画布的静态图片");
    return this.saveAsset(projectId, {
      id: randomUUID(),
      name: cleanName(name),
      type: "clip",
      revision: "",
      createdAt: now(),
      frames,
      loop,
      origin,
      folder:
        folder ??
        (origin?.assetId
          ? assetFolder(this.asset(projectId, origin.assetId))
          : assetFolder(images[0]!)),
    }) as ClipAsset;
  }
  updateClip(
    projectId: string,
    id: string,
    input: unknown,
    interpolationId?: string,
    frameChange?: { id: string; action: "apply" | "revert" },
  ) {
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
      appliedInterpolationIds: interpolationId
        ? [...(old.appliedInterpolationIds || []), interpolationId]
        : old.appliedInterpolationIds,
      appliedFrameChangeIds:
        frameChange?.action === "apply"
          ? [...(old.appliedFrameChangeIds || []), frameChange.id]
          : old.appliedFrameChangeIds,
      revertedFrameChangeIds:
        frameChange?.action === "revert"
          ? [...(old.revertedFrameChangeIds || []), frameChange.id]
          : old.revertedFrameChangeIds,
    }) as ClipAsset;
  }
  async exportClip(projectId: string, id: string) {
    return this.reading(projectId, async () => {
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
    });
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
      folders: this.library.folders(projectId),
      libraryRevision: this.library.revision(projectId),
      trash: this.library.trash(projectId),
      interpolations: this.interpolations.list(projectId),
      reviews: this.animation.listReviews(projectId),
      frameChanges: this.animation.listChanges(projectId),
      sessions: [...this.sessions.values()]
        .filter((session) => session.projectId === projectId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }
}
