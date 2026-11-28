import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { StudioError, atomicJson, type ProjectStore } from "./store.ts";
import type { ClipAsset, ClipSnapshot } from "./model.ts";
import { writeZip, type ZipEntry } from "./zip.ts";
import {
  clipExportFormats,
  exportFormats,
  packingFormats,
  type ExportFormat,
  type ExportJob,
  type ExportListing,
  type ExportRecord,
} from "./export-formats.ts";

const spec = z
  .object({
    format: z.enum(exportFormats).default("all"),
    clipIds: z.array(z.string().uuid()).max(128).default([]),
    reviewSequenceId: z.string().uuid().optional(),
    columns: z.number().int().min(1).max(32).optional(),
  })
  .strict();
export type ExportSpec = z.infer<typeof spec>;

/** Names become ZIP entries and file names, so they stay free of path syntax. */
const fileStem = (value: string) =>
  value
    .replace(/[\\/:*?"<>|%\x00-\x1f]/g, "_")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 60) || "动画";

const isFormat = (value: unknown): value is ExportFormat =>
  typeof value === "string" &&
  (exportFormats as readonly string[]).includes(value);

type StagedFrame = { path: string; durationUs: number };
type Layout = "clip" | "review";
type PackedFiles = {
  width: number;
  height: number;
  count: number;
  durationMs: number;
  files: string[];
};

/**
 * One-click export: renders the saved animations of a project into PNG frames,
 * atlases and preview animations, then packs them into a ZIP next to the project.
 * The work is deliberately not transactional with the project: it only reads
 * snapshots and writes under `.studio/exports` and `Exports`.
 */
export class ProjectExports {
  readonly store: ProjectStore;
  jobs = new Map<string, ExportJob>();
  private tasks = new Map<string, Promise<void>>();
  constructor(store: ProjectStore) {
    this.store = store;
    // A previous process never finishes its staging directory, so nothing there
    // is still owned by a live job.
    for (const projectId of store.projects.keys()) {
      const path = join(store.dir(projectId), ".studio", "exports");
      if (!existsSync(path)) continue;
      for (const name of readdirSync(path)) {
        try {
          rmSync(join(path, name), { recursive: true, force: true });
        } catch {
          // A locked leftover stays hidden; it is never read as an export.
        }
      }
    }
  }
  purgeProject(pid: string) {
    for (const [id, job] of [...this.jobs])
      if (job.projectId === pid) this.jobs.delete(id);
  }
  private exportsDir(pid: string) {
    const path = this.store.safePath(pid, "Exports");
    mkdirSync(path, { recursive: true });
    return path;
  }
  private receipt(path: string): any {
    try {
      return JSON.parse(readFileSync(path + ".json", "utf8"));
    } catch {
      return undefined;
    }
  }
  list(pid: string): ExportListing {
    this.store.project(pid);
    const dir = this.exportsDir(pid);
    const records: ExportRecord[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.toLowerCase().endsWith(".zip")) continue;
      const path = join(dir, file);
      try {
        const stats = statSync(path);
        const info = this.receipt(path);
        records.push({
          filename: file,
          format: isFormat(info?.format) ? info.format : undefined,
          bytes: stats.size,
          createdAt:
            typeof info?.createdAt === "string"
              ? info.createdAt
              : stats.mtime.toISOString(),
        });
      } catch {
        // The file disappeared between listing and reading.
      }
    }
    return {
      records: records.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      ),
      jobs: [...this.jobs.values()]
        .filter((job) => job.projectId === pid)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 20),
    };
  }
  job(pid: string, id: string) {
    this.store.project(pid);
    const job = this.jobs.get(id);
    if (!job || job.projectId !== pid)
      throw new StudioError("导出任务不存在", 404);
    return job;
  }
  file(pid: string, filename: string) {
    if (
      filename.length > 200 ||
      !/^[^\\/:*?"<>|%\x00-\x1f]+\.zip$/i.test(filename)
    )
      throw new StudioError("导出文件不存在", 404);
    const path = this.store.safePath(pid, `Exports/${filename}`);
    if (!existsSync(path)) throw new StudioError("导出文件不存在", 404);
    return path;
  }
  cancel(pid: string, id: string) {
    const job = this.job(pid, id);
    if (job.status === "running") {
      job.cancelled = true;
      job.phase = "正在取消…";
    }
    return job;
  }
  create(pid: string, input: unknown): ExportJob {
    this.store.project(pid);
    const parsed = spec.parse(input);
    if (
      [...this.jobs.values()].some(
        (job) => job.projectId === pid && job.status === "running",
      )
    )
      throw new StudioError("这个工程已有导出正在进行，请等待完成或取消", 409);
    const clips = this.clips(pid, parsed);
    if (parsed.format === "review") this.review(pid, parsed.reviewSequenceId);
    const total =
      parsed.format === "project"
        ? 1
        : parsed.format === "review"
          ? 2
          : clips.length + 1;
    const job: ExportJob = {
      id: randomUUID(),
      projectId: pid,
      format: parsed.format,
      status: "running",
      phase: "准备导出",
      completed: 0,
      total,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.trim(pid);
    const task = this.store.reading(pid, () =>
      this.run(pid, job, parsed, clips),
    );
    this.tasks.set(job.id, task);
    const settle = () => {
      this.tasks.delete(job.id);
    };
    void task.then(settle, settle);
    return job;
  }
  private trim(pid: string) {
    const finished = [...this.jobs.values()]
      .filter((job) => job.projectId === pid && job.status !== "running")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const job of finished.slice(0, Math.max(0, finished.length - 20)))
      this.jobs.delete(job.id);
  }
  private clips(pid: string, parsed: ExportSpec): ClipAsset[] {
    if (!clipExportFormats.includes(parsed.format)) return [];
    const clips = this.store
      .assets(pid)
      .filter((asset): asset is ClipAsset => asset.type === "clip");
    if (!clips.length && !parsed.clipIds.length)
      throw new StudioError("工程里还没有动画，无法导出动作资源");
    const byId = new Map(clips.map((clip) => [clip.id, clip]));
    const chosen: ClipAsset[] = parsed.clipIds.length
      ? [...new Set(parsed.clipIds)].map((id) => {
          const clip = byId.get(id);
          if (!clip)
            throw new StudioError("所选动画不存在或已被删除，请刷新后重试", 404);
          return clip;
        })
      : clips;
    for (const clip of chosen)
      if (!clip.frames.length)
        throw new StudioError(`动画“${clip.name}”还没有帧，无法导出`);
    return chosen;
  }
  private review(pid: string, id?: string) {
    if (!id) throw new StudioError("请选择要导出的 Review 序列");
    const definition = this.store.reviewSequences.get(pid, id);
    if (definition.archived)
      throw new StudioError("Review 已归档，请先恢复再导出", 409);
    if (definition.unresolved.length)
      throw new StudioError(
        `Review 片段引用已失效：${definition.unresolved
          .map((item) => item.reason)
          .join("；")}`,
        409,
      );
    return definition;
  }
  private assertActive(job: ExportJob) {
    if (job.cancelled) throw new StudioError("导出已取消", 409);
  }
  private filename(pid: string, format: ExportFormat) {
    const stamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[-:]/g, "")
      .replace("T", "-");
    const base = `${fileStem(this.store.project(pid).name).slice(0, 30)}-${format}-${stamp}`;
    const dir = this.exportsDir(pid);
    for (let index = 1; ; index++) {
      const name = `${base}${index > 1 ? `-${index}` : ""}.zip`;
      if (!existsSync(join(dir, name))) return name;
    }
  }
  private uniqueName(used: Set<string>, value: string) {
    const base = fileStem(value);
    for (let index = 1; ; index++) {
      const name = `${base}${index > 1 ? ` (${index})` : ""}`;
      if (!used.has(name.toLowerCase())) {
        used.add(name.toLowerCase());
        return name;
      }
    }
  }
  private async run(
    pid: string,
    job: ExportJob,
    parsed: ExportSpec,
    clips: ClipAsset[],
  ) {
    let staging = "";
    try {
      staging = this.store.safePath(pid, `.studio/exports/${job.id}`);
      mkdirSync(staging, { recursive: true });
      const entries: ZipEntry[] = [];
      const manifest: Record<string, any> = {
        schema: "sprite-studio-export-v1",
        project: { id: pid, name: this.store.project(pid).name },
        format: job.format,
        createdAt: job.createdAt,
        clips: [],
      };
      if (parsed.format === "project")
        await this.stageProject(pid, job, staging, entries);
      else if (parsed.format === "review")
        await this.stageReview(pid, job, parsed, staging, entries, manifest);
      else
        await this.stageClips(pid, job, parsed, clips, staging, entries, manifest);
      this.assertActive(job);
      const manifestPath = join(staging, "export.json");
      atomicJson(manifestPath, manifest);
      entries.push({ name: "export.json", source: manifestPath });
      job.phase = "打包 ZIP";
      job.completed = Math.max(0, job.total - 1);
      const filename = this.filename(pid, job.format);
      const written = writeZip(
        join(this.exportsDir(pid), filename),
        entries,
      );
      job.filename = filename;
      job.bytes = written.bytes;
      job.completed = job.total;
      atomicJson(join(this.exportsDir(pid), filename + ".json"), {
        schema: "sprite-studio-export-v1",
        projectId: pid,
        format: job.format,
        filename,
        bytes: job.bytes,
        entries: written.entries,
        createdAt: job.createdAt,
        finishedAt: new Date().toISOString(),
      });
      job.status = "completed";
    } catch (error) {
      job.status = job.cancelled ? "cancelled" : "failed";
      job.error = job.cancelled ? "导出已取消" : (error as Error).message;
    } finally {
      job.finishedAt = new Date().toISOString();
      job.phase =
        job.status === "completed"
          ? "导出完成"
          : job.status === "cancelled"
            ? "已取消"
            : "导出失败";
      if (staging)
        try {
          rmSync(staging, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 50,
          });
        } catch {
          // The next start clears an unlucky leftover staging directory.
        }
    }
  }
  private async frames(pid: string, snapshot: ClipSnapshot) {
    const frames: StagedFrame[] = [];
    for (const frame of snapshot.clip.frames) {
      const rendered = await this.store.animation.renderFrame(
        pid,
        snapshot.id,
        frame.id,
      );
      frames.push({
        path: rendered.path,
        durationUs: frame.durationUs,
      });
    }
    return frames;
  }
  /** Runs the image worker once and maps its short staged paths to ZIP entries. */
  private async pack(
    pid: string,
    staging: string,
    snapshot: ClipSnapshot,
    options: {
      name: string;
      loop: boolean;
      fps: number;
      formats: ExportFormat[];
      layout: Layout;
      columns?: number;
    },
    entries: ZipEntry[],
  ): Promise<PackedFiles> {
    const frames = await this.frames(pid, snapshot);
    const result = await this.store.worker.run(
      "export_clip",
      {
        outputDir: staging,
        name: options.name,
        formats: options.formats,
        frames,
        loop: options.loop,
        fps: options.fps,
        columns: options.columns,
      },
      { timeoutMs: 5 * 60_000 },
    );
    const files: string[] = [];
    const add = (name: string, relative: string) => {
      entries.push({ name, source: join(staging, relative) });
      files.push(name);
    };
    const framesAt = result.files?.frames as string[] | undefined;
    for (const [index, relative] of (framesAt || []).entries())
      add(
        options.layout === "review"
          ? `review/${options.name}_${String(index).padStart(2, "0")}.png`
          : `frames/${options.name}/${options.name}_${String(index).padStart(2, "0")}.png`,
        relative,
      );
    const atlas = result.files?.atlas as
      | { png: string; json: string }
      | undefined;
    if (atlas) {
      add(`atlas/${options.name}.png`, atlas.png);
      add(`atlas/${options.name}.json`, atlas.json);
    }
    const webp = result.files?.webp as
      | { file: string; json: string }
      | undefined;
    if (webp) {
      add(
        options.layout === "review"
          ? `review/${options.name}.webp`
          : `webp/${options.name}.webp`,
        webp.file,
      );
      add(
        options.layout === "review"
          ? `review/${options.name}.animation.json`
          : `webp/${options.name}.animation.json`,
        webp.json,
      );
    }
    const gif = result.files?.gif as
      | { file: string; json: string }
      | undefined;
    if (gif) {
      add(
        options.layout === "review"
          ? `review/${options.name}.gif`
          : `gif/${options.name}.gif`,
        gif.file,
      );
      // A review archive keeps one playback record; both copies are identical.
      if (options.layout !== "review")
        add(`gif/${options.name}.animation.json`, gif.json);
    }
    return {
      width: result.width as number,
      height: result.height as number,
      count: result.count as number,
      durationMs: result.durationMs as number,
      files,
    };
  }
  private async stageClips(
    pid: string,
    job: ExportJob,
    parsed: ExportSpec,
    clips: ClipAsset[],
    staging: string,
    entries: ZipEntry[],
    manifest: Record<string, any>,
  ) {
    const used = new Set<string>();
    for (const [index, clip] of clips.entries()) {
      this.assertActive(job);
      job.phase = `导出动画 ${clip.name}`;
      const name = this.uniqueName(used, clip.name);
      const formats: ExportFormat[] =
        parsed.format === "all" ? [...packingFormats] : [parsed.format];
      const packed = await this.pack(
        pid,
        join(staging, String(index)),
        this.store.animation.capture(pid, clip.id),
        {
          name,
          loop: clip.loop,
          fps: clip.initialFps ?? 12,
          formats,
          layout: "clip",
          columns: parsed.columns,
        },
        entries,
      );
      manifest.clips.push({
        id: clip.id,
        name: clip.name,
        folder: clip.folder ?? "",
        loop: clip.loop,
        fps: clip.initialFps ?? 12,
        ...packed,
      });
      job.completed = index + 1;
    }
  }
  private async stageReview(
    pid: string,
    job: ExportJob,
    parsed: ExportSpec,
    staging: string,
    entries: ZipEntry[],
    manifest: Record<string, any>,
  ) {
    const definition = this.review(pid, parsed.reviewSequenceId);
    job.phase = `导出 Review ${definition.name}`;
    const snapshot = this.sequenceSnapshot(pid, definition.id);
    const packed = await this.pack(
      pid,
      join(staging, "0"),
      snapshot,
      {
        name: fileStem(definition.name),
        loop: snapshot.clip.loop,
        fps: 12,
        formats: ["webp", "gif"],
        layout: "review",
      },
      entries,
    );
    manifest.clips.push({
      reviewSequenceId: definition.id,
      reviewRevision: definition.revision,
      snapshotId: snapshot.id,
      name: definition.name,
      loop: snapshot.clip.loop,
      ...packed,
    });
    job.completed = 1;
  }
  private sequenceSnapshot(pid: string, id: string) {
    const reusable = this.store.reviewSequences
      .listSnapshots(pid, id)
      .find((snapshot) => !snapshot.stale);
    const sequence = reusable ?? this.store.reviewSequences.capture(pid, id);
    return this.store.animation.snapshot(pid, sequence.snapshotId);
  }
  private async stageProject(
    pid: string,
    job: ExportJob,
    staging: string,
    entries: ZipEntry[],
  ) {
    const files = this.assetFiles(pid);
    job.total = files.length + 2;
    for (const [index, file] of files.entries()) {
      this.assertActive(job);
      job.phase = `复制资源 ${index + 1}/${files.length}`;
      const target = join(staging, ...file.entry.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file.path, target);
      entries.push({ name: file.entry, source: target });
      job.completed = index + 1;
    }
    this.assertActive(job);
    const projectPath = join(staging, "project.json");
    atomicJson(projectPath, this.store.project(pid));
    entries.push({ name: "project.json", source: projectPath });
    job.completed = files.length + 1;
  }
  private assetFiles(pid: string) {
    const files: { path: string; entry: string }[] = [];
    const visit = (folder: string) => {
      const path = this.store.safePath(pid, folder);
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
          throw new StudioError("资源目录包含链接，请移除链接后再导出");
        const child = `${folder}/${entry.name}`;
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile())
          files.push({ path: this.store.safePath(pid, child), entry: child });
      }
    };
    visit("Assets");
    return files;
  }
}
