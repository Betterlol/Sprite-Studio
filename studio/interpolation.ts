import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StudioError, atomicJson, type ProjectStore } from "./store.ts";
import {
  interpolationSchema,
  interpolationLayoutSchema,
  interpolationGrid,
  type Interpolation,
  type FrameReference,
  type ClipAsset,
} from "./model.ts";

export class InterpolationStore {
  store: ProjectStore;
  jobs = new Map<string, Interpolation>();
  preparing = new Map<
    string,
    { key: string; promise: Promise<Interpolation> }
  >();
  constructor(store: ProjectStore) {
    this.store = store;
    for (const projectId of store.projects.keys()) {
      const dir = join(store.dir(projectId), ".studio", "interpolations");
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter((file) =>
        file.endsWith(".json"),
      )) {
        const job = JSON.parse(
          readFileSync(join(dir, file), "utf8"),
        ) as Interpolation;
        if (job.projectId !== projectId || file !== `${job.id}.json`) continue;
        const clip = store.asset(projectId, job.clipId) as ClipAsset;
        if (clip.appliedInterpolationIds?.includes(job.id))
          job.status = "applied";
        else if (job.status === "running") {
          job.status = "interrupted";
          job.error = "服务已重启，补帧没有自动重试；已收到的候选仍会保留。";
        }
        this.jobs.set(job.id, job);
      }
    }
  }
  list(projectId: string) {
    return [...this.jobs.values()]
      .filter((job) => job.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(projectId: string, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.projectId !== projectId)
      throw new StudioError("补帧任务不存在", 404);
    return job;
  }
  save(job: Interpolation) {
    job.updatedAt = new Date().toISOString();
    const dir = join(
      this.store.dir(job.projectId),
      ".studio",
      "interpolations",
    );
    mkdirSync(dir, { recursive: true });
    atomicJson(join(dir, `${job.id}.json`), job);
    this.jobs.set(job.id, job);
    this.store.changed(job.projectId);
    return job;
  }
  private clip(job: Interpolation) {
    const clip = this.store.asset(job.projectId, job.clipId);
    if (clip.type !== "clip" || clip.revision !== job.clipRevision)
      throw new StudioError("原动画已修改，请根据当前动画重新发起补帧", 409);
    for (const ref of [job.start, job.end])
      this.store.imagePath(job.projectId, ref.imageId, ref.revision);
    return clip;
  }
  create(projectId: string, input: unknown) {
    const spec = interpolationSchema.parse(input);
    const existing = this.jobs.get(spec.requestId);
    if (existing) return this.get(projectId, spec.requestId);
    const clip = this.store.asset(projectId, spec.clipId);
    if (clip.type !== "clip" || clip.revision !== spec.revision)
      throw new StudioError("动画已改变，请刷新后再发起补帧", 409);
    const startIndex = clip.frames.findIndex(
        (frame) => frame.id === spec.startFrameId,
      ),
      endIndex = clip.frames.findIndex((frame) => frame.id === spec.endFrameId);
    if (startIndex < 0 || endIndex <= startIndex)
      throw new StudioError("尾帧必须位于首帧之后");
    if (clip.frames.length - (endIndex - startIndex - 1) + spec.count > 128)
      throw new StudioError("补帧后的动画不能超过 128 帧");
    const ref = (index: number): FrameReference => {
      const frame = clip.frames[index]!;
      const image = this.store.image(projectId, frame.imageId);
      this.store.imagePath(projectId, image.id);
      if (image.frameCount !== 1) throw new StudioError("参考帧需要静态图片");
      return {
        frameId: frame.id,
        imageId: image.id,
        revision: image.revision,
        contentHash: image.contentHash,
      };
    };
    const start = ref(startIndex),
      end = ref(endIndex);
    const first = this.store.image(projectId, start.imageId),
      last = this.store.image(projectId, end.imageId);
    if (first.width !== last.width || first.height !== last.height)
      throw new StudioError("首尾帧画布需要一致");
    const session = this.store.createSession(projectId);
    session.interpolationId = spec.requestId;
    this.store.saveSession(session);
    return this.save({
      id: spec.requestId,
      projectId,
      sessionId: session.id,
      clipId: clip.id,
      clipRevision: clip.revision,
      start,
      end,
      count: spec.count,
      fps: spec.fps,
      description: spec.description,
      ...interpolationGrid(spec.count),
      width: first.width,
      height: first.height,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  receive(
    projectId: string,
    id: string,
    sheetId: string,
    item: { id: string; inputImages?: { sha256: string }[] },
  ) {
    const job = this.get(projectId, id);
    if (job.sheetId) return job;
    job.sheetId = sheetId;
    job.generationItemId = item.id;
    job.referenceHashes = item.inputImages?.map((image) => image.sha256) || [];
    job.referencesVerified = [job.start, job.end].every((ref) =>
      job.referenceHashes!.includes(ref.contentHash),
    );
    job.status = "candidate";
    if (!job.referencesVerified)
      job.error =
        "生成事件没有确认两张首尾参考均被传入，请核对候选；不会自动重试。";
    return this.save(job);
  }
  prepare(
    projectId: string,
    id: string,
    input: unknown,
  ): Promise<Interpolation> {
    const job = this.get(projectId, id),
      spec = interpolationLayoutSchema.parse(input),
      key = JSON.stringify(spec);
    if (job.status === "applied")
      throw new StudioError("这个补帧结果已经加入动画", 409);
    if (!job.sheetId) throw new StudioError("尚未收到生成图集");
    if (
      spec.columns * spec.rows !==
      job.count + (spec.includesEndpoints ? 2 : 0)
    )
      throw new StudioError("网格数量必须与补帧数及首尾设置一致");
    this.clip(job);
    if (job.prepared && JSON.stringify(job.prepared.spec) === key) {
      const preview = this.store.asset(projectId, job.prepared.clipId);
      if (preview.revision === job.prepared.clipRevision)
        return Promise.resolve(job);
    }
    const running = this.preparing.get(id);
    if (running) {
      if (running.key !== key)
        throw new StudioError("这个候选正在处理，请稍后再试", 409);
      return running.promise;
    }
    const promise = this.buildPreview(job, spec).finally(() =>
      this.preparing.delete(id),
    );
    this.preparing.set(id, { key, promise });
    return promise;
  }
  private async buildPreview(
    job: Interpolation,
    spec: ReturnType<typeof interpolationLayoutSchema.parse>,
  ) {
    const pid = job.projectId,
      sheet = this.store.image(pid, job.sheetId!);
    const result = await this.store.worker.run("inbetween", {
      path: this.store.imagePath(pid, sheet.id, sheet.revision),
      outputDir: this.store.stage(pid),
      ...spec,
      width: job.width,
      height: job.height,
    });
    this.clip(job);
    this.store.imagePath(pid, sheet.id, sheet.revision);
    const frames = [];
    for (const [index, file] of (result.files as string[]).entries()) {
      const image = await this.store.importImage(
        pid,
        `补帧-${index + 1}.png`,
        readFileSync(file),
        "candidate",
        {
          kind: "interpolation_frame",
          assetId: sheet.id,
          interpolationId: job.id,
          operation: {
            ...spec,
            index,
            fit: "contain",
            width: job.width,
            height: job.height,
          },
        },
      );
      frames.push({
        id: randomUUID(),
        imageId: image.id,
        durationUs:
          Math.round(((index + 1) * 1_000_000) / spec.fps) -
          Math.round((index * 1_000_000) / spec.fps),
      });
    }
    const clip = this.clip(job);
    const start = clip.frames.findIndex(
        (frame) => frame.id === job.start.frameId,
      ),
      end = clip.frames.findIndex((frame) => frame.id === job.end.frameId);
    const preview = this.store.createClip(
      pid,
      `${clip.name} · 补帧预览`,
      [
        ...clip.frames.slice(0, start + 1),
        ...frames,
        ...clip.frames.slice(end),
      ],
      { assetId: clip.id, revision: clip.revision },
      clip.loop,
    );
    job.prepared = { clipId: preview.id, clipRevision: preview.revision, spec };
    job.status = "preview";
    return this.save(job);
  }
  apply(projectId: string, id: string, expectedPreviewRevision?: string) {
    const job = this.get(projectId, id),
      current = this.store.asset(projectId, job.clipId) as ClipAsset;
    if (current.appliedInterpolationIds?.includes(id)) {
      job.status = "applied";
      this.save(job);
      return current;
    }
    if (this.preparing.has(id))
      throw new StudioError("请等待预览处理完成", 409);
    const clip = this.clip(job);
    if (!job.prepared) throw new StudioError("请先切割并预览候选");
    const preview = this.store.asset(projectId, job.prepared.clipId);
    if (
      preview.type !== "clip" ||
      preview.revision !==
        (expectedPreviewRevision || job.prepared.clipRevision)
    )
      throw new StudioError("预览动画已修改，请重新切割候选后确认", 409);
    const start = clip.frames.findIndex(
        (frame) => frame.id === job.start.frameId,
      ),
      end = clip.frames.findIndex((frame) => frame.id === job.end.frameId);
    const equal = (a: any, b: any) =>
      a?.id === b?.id &&
      a?.imageId === b?.imageId &&
      a?.durationUs === b?.durationUs;
    if (
      preview.frames.length !==
        clip.frames.length - (end - start - 1) + job.count ||
      clip.frames
        .slice(0, start + 1)
        .some((frame, index) => !equal(frame, preview.frames[index])) ||
      clip.frames
        .slice(end)
        .some(
          (frame, index) =>
            !equal(frame, preview.frames[start + 1 + job.count + index]),
        )
    )
      throw new StudioError(
        "补帧预览必须保留原首尾和区间外帧，只能修改中间候选",
        409,
      );
    for (const frame of preview.frames)
      this.store.imagePath(projectId, frame.imageId);
    const updated = this.store.updateClip(
      projectId,
      clip.id,
      { revision: job.clipRevision, frames: preview.frames, loop: clip.loop },
      id,
    );
    job.status = "applied";
    this.save(job);
    return updated;
  }
}

export function interpolationPrompt(job: Interpolation) {
  return `请为动画补帧，实际使用本条消息的两张图片作为首尾参考。第一张是首帧（assetId=${job.start.imageId}），第二张是尾帧（assetId=${job.end.imageId}），两张都必须通过 referenced_image_paths 等图像生成参考参数实际传给内置 image_gen。\n动作要求：${job.description}\n仅调用一次内置 image_gen，失败不重试，不使用 slice_sheet 或 adjust_image。生成一张透明背景 spritesheet，共 ${job.count + 2} 格，严格 ${job.columns} 列 ${job.rows} 行，等大无间距网格，按从左到右、从上到下排序：第一格复现首帧，最后一格复现尾帧，中间 ${job.count} 格为连续过渡。每格画布比例 ${job.width}:${job.height}，角色大小、朝向和基准一致，不画网格线、文字、序号、边框。网页将去掉生成的首尾格，保留原始首尾帧，再由用户预览和确认加入动画。生成完成后停止，不自行切割、重试或修改动画，不宣称动态验收通过。`;
}
