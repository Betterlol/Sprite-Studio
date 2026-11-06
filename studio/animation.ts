import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { StudioError, atomicJson, sha256, type ProjectStore } from "./store.ts";
import {
  clipReferenceSchema,
  frameAdjustmentSchema,
  frameTransformSchema,
  type TransformPreview,
  type ClipSnapshot,
  type ClipReview,
  type FrameChange,
  type ClipAsset,
  type ClipAttachment,
} from "./model.ts";

const content = (clip: ClipAsset) =>
  JSON.stringify({ frames: clip.frames, loop: clip.loop });
type RenderedFrame = {
  path: string;
  image: ClipSnapshot["images"][string];
} & Partial<Pick<TransformPreview, "bounds" | "overflow" | "blocking">>;
const frameBatchSchema = z.object({
  requestId: z.string().uuid(),
  clipId: z.string().uuid(),
  revision: z.string(),
  frames: z
    .array(
      z
        .object({
          frameId: z.string().uuid(),
          transform: frameTransformSchema.optional(),
          durationUs: z.number().int().min(1000).max(60_000_000).optional(),
        })
        .refine((f) => f.transform !== undefined || f.durationUs !== undefined),
    )
    .min(1)
    .max(128),
});
export class AnimationStore {
  store: ProjectStore;
  snapshots = new Map<string, ClipSnapshot>();
  reviews = new Map<string, ClipReview>();
  changes = new Map<string, FrameChange>();
  adjusting = new Map<string, Promise<FrameChange>>();
  rendering = new Map<string, Promise<RenderedFrame>>();
  constructor(store: ProjectStore) {
    this.store = store;
    for (const projectId of store.projects.keys())
      for (const [folder, map] of [
        ["snapshots", this.snapshots],
        ["reviews", this.reviews],
        ["changes", this.changes],
      ] as const) {
        const dir = join(store.dir(projectId), ".studio", "animation", folder);
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir).filter((file) =>
          file.endsWith(".json"),
        )) {
          const item = JSON.parse(readFileSync(join(dir, file), "utf8"));
          if (item.projectId === projectId && file === `${item.id}.json`)
            map.set(item.id, item);
        }
      }
    for (const change of this.changes.values()) {
      const legacy = change as FrameChange & {
        candidateClipId?: string;
        appliedSnapshotId?: string;
      };
      change.legacyClipId ??= legacy.candidateClipId;
      change.afterSnapshotId ??= legacy.appliedSnapshotId;
      delete legacy.candidateClipId;
      delete legacy.appliedSnapshotId;
      if (
        !["pending", "applied", "reverted", "archived"].includes(change.status)
      )
        change.status = "archived";
      if (!store.indexes.get(change.projectId)?.has(change.clipId)) continue;
      const clip = this.clip(change.projectId, change.clipId);
      if (clip.revertedFrameChangeIds?.includes(change.id))
        change.status = "reverted";
      else if (clip.appliedFrameChangeIds?.includes(change.id)) {
        change.status = "applied";
        if (
          !change.afterSnapshotId &&
          change.resultFrames &&
          JSON.stringify(clip.frames) === JSON.stringify(change.resultFrames)
        )
          change.afterSnapshotId = this.capture(change.projectId, clip.id).id;
      } else if (change.status === "pending") change.status = "archived";
    }
  }

  private save(folder: string, item: ClipSnapshot | ClipReview | FrameChange) {
    const dir = join(
      this.store.dir(item.projectId),
      ".studio",
      "animation",
      folder,
    );
    mkdirSync(dir, { recursive: true });
    atomicJson(join(dir, `${item.id}.json`), item);
    this.store.changed(item.projectId);
    return item;
  }
  clip(pid: string, id: string) {
    const clip = this.store.asset(pid, id);
    if (clip.type !== "clip") throw new StudioError("请选择动画资源");
    return clip;
  }
  snapshot(pid: string, id: string) {
    const snapshot = this.snapshots.get(id);
    if (!snapshot || snapshot.projectId !== pid)
      throw new StudioError("动画快照不存在", 404);
    return snapshot;
  }
  capture(pid: string, id: string, expected?: string) {
    const clip = this.clip(pid, id);
    if (expected && clip.revision !== expected)
      throw new StudioError("动画版本已经改变，请重新引用或检查", 409);
    return this.captureClip(pid, clip);
  }
  captureClip(
    pid: string,
    clip: ClipAsset,
    frozenImages?: ClipSnapshot["images"],
    preview = false,
  ) {
    const images: ClipSnapshot["images"] = frozenImages
      ? structuredClone(frozenImages)
      : {};
    for (const frame of frozenImages ? [] : clip.frames) {
      const image = this.store.image(pid, frame.imageId);
      this.store.imagePath(pid, image.id);
      images[image.id] = {
        id: image.id,
        mime: image.mime,
        width: image.width,
        height: image.height,
        contentHash: image.contentHash,
      };
    }
    const cached = [...this.snapshots.values()].find(
      (snapshot) =>
        snapshot.renderMode === (preview ? "preview" : undefined) &&
        snapshot.projectId === pid &&
        snapshot.clip.id === clip.id &&
        snapshot.clip.revision === clip.revision &&
        content(snapshot.clip) === content(clip) &&
        JSON.stringify(snapshot.images) === JSON.stringify(images),
    );
    if (cached) return cached;
    const snapshot: ClipSnapshot = {
      renderMode: preview ? "preview" : undefined,
      id: randomUUID(),
      projectId: pid,
      createdAt: new Date().toISOString(),
      clip: structuredClone(clip),
      images,
    };
    this.snapshots.set(snapshot.id, snapshot);
    this.save("snapshots", snapshot);
    return snapshot;
  }
  imagePath(pid: string, sid: string, frameId: string) {
    const snapshot = this.snapshot(pid, sid),
      frame = snapshot.clip.frames.find((frame) => frame.id === frameId);
    if (!frame) throw new StudioError("帧不在这份动画快照中", 404);
    const image = snapshot.images[frame.imageId]!,
      path = this.store.safePath(pid, `.studio/objects/${image.contentHash}`);
    if (!existsSync(path) || sha256(readFileSync(path)) !== image.contentHash)
      throw new StudioError("快照图片缺失或已经改变", 409);
    return { path, image };
  }
  async renderFrame(
    pid: string,
    sid: string,
    frameId: string,
  ): Promise<RenderedFrame> {
    const snapshot = this.snapshot(pid, sid),
      original = this.imagePath(pid, sid, frameId),
      transform = snapshot.clip.frames.find((f) => f.id === frameId)!.transform;
    if (!transform) return original;
    const preview = snapshot.renderMode === "preview",
      key = sha256(
        JSON.stringify([
          "visible-alpha16-v2",
          pid,
          original.image.contentHash,
          transform,
          preview,
        ]),
      );
    const running = this.rendering.get(key);
    if (running) return running;
    const promise = this.store
      .reading(pid, async () => {
        const folder = this.store.safePath(pid, ".studio/animation/rendered");
        mkdirSync(folder, { recursive: true });
        const path = join(folder, key + ".png"),
          receipt = path + ".json";
        let cached: any;
        try {
          cached = JSON.parse(readFileSync(receipt, "utf8"));
          if (cached.hash !== sha256(readFileSync(path))) cached = undefined;
        } catch {
          cached = undefined;
        }
        if (!cached) {
          const result = await this.store.worker.run("transform", {
            path: original.path,
            outputDir: this.store.stage(pid),
            transform,
            preview,
          });
          copyFileSync(result.files[0], path);
          cached = {
            hash: sha256(readFileSync(path)),
            bounds: result.bounds,
            overflow: result.overflow,
            blocking: result.blocking,
          };
          atomicJson(receipt, cached);
        }
        return {
          path,
          image: { ...original.image, mime: "image/png" },
          bounds: cached.bounds,
          overflow: cached.overflow,
          blocking: cached.blocking,
        };
      })
      .finally(() => this.rendering.delete(key));
    this.rendering.set(key, promise);
    return promise;
  }
  range(snapshot: ClipSnapshot, startFrameId?: string, endFrameId?: string) {
    const frames = snapshot.clip.frames,
      start = startFrameId
        ? frames.findIndex((frame) => frame.id === startFrameId)
        : 0,
      end = endFrameId
        ? frames.findIndex((frame) => frame.id === endFrameId)
        : frames.length - 1;
    if (start < 0 || end < start) throw new StudioError("无效动画帧区间");
    return { start, end };
  }
  reference(pid: string, input: unknown): ClipAttachment {
    const ref = clipReferenceSchema.parse(input),
      snapshot = this.capture(pid, ref.clipId, ref.revision);
    this.range(snapshot, ref.startFrameId, ref.endFrameId);
    return { ...ref, snapshotId: snapshot.id, name: snapshot.clip.name };
  }
  stale(review: ClipReview) {
    const sequenceStale = this.store.reviewSequences?.snapshotStale(review.projectId, review.snapshotId);
    if (sequenceStale !== undefined) return sequenceStale;
    if (review.draftId && this.store.clipDrafts?.has(review.projectId, review.draftId)) {
      try {
        const document = this.store.clipDrafts.read(review.projectId, review.draftId);
        return document.documentRevision !== review.documentRevision || document.draft.status !== "editing" || this.store.clipDrafts.freeze(review.projectId, review.draftId, document.documentRevision).id !== review.snapshotId;
      } catch { return true; }
    }
    try {
      const snapshot = this.snapshot(review.projectId, review.snapshotId);
      const draft = review.draftId
        ? this.store.frameDrafts.get(review.projectId, review.draftId)
        : undefined;
      if (
        draft &&
        (draft.documentRevision !== review.documentRevision ||
          !["editing", "pending"].includes(draft.status))
      )
        return true;
      const revision = draft
        ? this.snapshot(review.projectId, draft.baseSnapshotId).clip.revision
        : review.clipRevision;
      return (
        this.clip(review.projectId, review.clipId).revision !== revision ||
        Object.values(snapshot.images).some(
          (image) =>
            this.store.image(review.projectId, image.id).contentHash !==
            image.contentHash,
        )
      );
    } catch {
      return true;
    }
  }
  listReviews(pid: string) {
    return [...this.reviews.values()]
      .filter((review) => review.projectId === pid)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((review) => ({ ...review, stale: this.stale(review) }));
  }
  listChanges(pid: string) {
    return [...this.changes.values()]
      .filter((change) => change.projectId === pid)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  review(pid: string, id: string) {
    const review = this.reviews.get(id);
    if (!review || review.projectId !== pid)
      throw new StudioError("检查记录不存在", 404);
    return { ...review, stale: this.stale(review) };
  }
  evidence(pid: string, id: string, kind: "contact" | "onion") {
    const review = this.review(pid, id),
      path = this.store.safePath(pid, review.files[kind]);
    if (sha256(readFileSync(path)) !== review.hashes[kind])
      throw new StudioError("检查图已经改变，请重新检查", 409);
    return path;
  }
  async inspect(
    pid: string,
    input: {
      clipId?: string;
      revision?: string;
      snapshotId?: string;
      startFrameId?: string;
      endFrameId?: string;
      draftId?: string;
      documentRevision?: string;
    },
  ) {
    const snapshot = input.snapshotId
      ? this.snapshot(pid, input.snapshotId)
      : this.capture(pid, input.clipId!, input.revision);
    if (!snapshot.clip.frames.length)
      throw new StudioError("动画还没有帧，无法检查");
    const range = this.range(
      snapshot,
      input.startFrameId,
      input.endFrameId ||
        snapshot.clip.frames[
          Math.min(
            snapshot.clip.frames.length - 1,
            (input.startFrameId
              ? snapshot.clip.frames.findIndex(
                  (frame) => frame.id === input.startFrameId,
                )
              : 0) + 15,
          )
        ]?.id,
    );
    if (range.end - range.start + 1 > 16)
      throw new StudioError("每次最多检查 16 帧，请按区间分次检查");
    const frames = snapshot.clip.frames.slice(range.start, range.end + 1);
    const cached = [...this.reviews.values()].find(
      (review) =>
        review.snapshotId === snapshot.id &&
        review.draftId === input.draftId &&
        review.documentRevision === input.documentRevision &&
        review.startFrameId === frames[0]!.id &&
        review.endFrameId === frames.at(-1)!.id,
    );
    if (cached) {
      this.evidence(pid, cached.id, "contact");
      this.evidence(pid, cached.id, "onion");
      return this.review(pid, cached.id);
    }
    const required = new Set<number>();
    for (
      let i = Math.max(0, range.start - 1);
      i <= Math.min(snapshot.clip.frames.length - 1, range.end + 1);
      i++
    )
      required.add(i);
    if (snapshot.clip.loop) {
      required.add(0);
      required.add(snapshot.clip.frames.length - 1);
    }
    const params = await Promise.all(
      snapshot.clip.frames.map(async (frame, index) => ({
        ...frame,
        index,
        ...(required.has(index)
          ? await this.renderFrame(pid, snapshot.id, frame.id)
          : (this.imagePath(pid, snapshot.id, frame.id) as RenderedFrame)),
      })),
    );
    const result = await this.store.worker.run("review", {
      path: params[0]!.path,
      outputDir: this.store.stage(pid),
      frames: params,
      start: range.start,
      end: range.end,
      loop: snapshot.clip.loop,
    });
    const files = {
      contact: relative(this.store.dir(pid), result.contact),
      onion: relative(this.store.dir(pid), result.onion),
    };
    const review: ClipReview = {
      warnings: params.flatMap((f, index) =>
        f.bounds && f.overflow && Object.values(f.overflow).some(Boolean)
          ? [
              {
                frameId: f.id,
                frameNumber: index + 1,
                bounds: f.bounds,
                overflow: f.overflow,
                blocking: !!f.blocking,
              },
            ]
          : [],
      ),
      draftId: input.draftId,
      documentRevision: input.documentRevision,
      id: randomUUID(),
      projectId: pid,
      snapshotId: snapshot.id,
      clipId: snapshot.clip.id,
      clipRevision: snapshot.clip.revision,
      createdAt: new Date().toISOString(),
      startFrameId: frames[0]!.id,
      endFrameId: frames.at(-1)!.id,
      frames: result.frames,
      pairs: result.pairs,
      files,
      hashes: {
        contact: sha256(readFileSync(result.contact)),
        onion: sha256(readFileSync(result.onion)),
      },
    };
    this.reviews.set(review.id, review);
    this.save("reviews", review);
    return this.review(pid, review.id);
  }
  change(pid: string, id: string) {
    const change = this.changes.get(id);
    if (!change || change.projectId !== pid)
      throw new StudioError("修改记录不存在", 404);
    return change;
  }
  adjust(
    pid: string,
    input: unknown,
    source: "agent" | "human" = "human",
  ): Promise<FrameChange> {
    const spec = frameAdjustmentSchema.parse(input);
    return this.adjustFrames(
      pid,
      {
        requestId: spec.requestId,
        clipId: spec.clipId,
        revision: spec.revision,
        frames: [
          {
            frameId: spec.frameId,
            transform: spec.transform,
            durationUs: spec.durationUs,
          },
        ],
      },
      source,
    );
  }
  adjustFrames(
    pid: string,
    input: unknown,
    source: "agent" | "human" = "human",
    beforeCommit?: () => void,
  ): Promise<FrameChange> {
    const spec = frameBatchSchema.parse(input),
      running = this.adjusting.get(spec.requestId);
    if (running) return running.then((change) => this.change(pid, change.id));
    const existing = this.changes.get(spec.requestId);
    if (
      existing &&
      (existing.status !== "pending" ||
        this.clip(pid, spec.clipId).appliedFrameChangeIds?.includes(
          existing.id,
        ))
    )
      return Promise.resolve(this.change(pid, spec.requestId));
    const promise = this.store
      .reading(pid, () => this.applyAdjustment(pid, spec, source, beforeCommit))
      .finally(() => this.adjusting.delete(spec.requestId));
    this.adjusting.set(spec.requestId, promise);
    return promise;
  }
  private async applyAdjustment(
    pid: string,
    spec: z.infer<typeof frameBatchSchema>,
    source: "agent" | "human",
    beforeCommit?: () => void,
  ) {
    const before = this.capture(pid, spec.clipId, spec.revision),
      byId = new Map(spec.frames.map((f) => [f.frameId, f]));
    if (
      byId.size !== spec.frames.length ||
      spec.frames.some(
        (f) => !before.clip.frames.some((old) => old.id === f.frameId),
      )
    )
      throw new StudioError("无效或重复的帧实例");
    const frames = before.clip.frames.map((frame) => {
      const edit = byId.get(frame.id);
      return edit
        ? {
            ...frame,
            transform: edit.transform ?? frame.transform,
            durationUs: edit.durationUs ?? frame.durationUs,
          }
        : frame;
    });
    const preview = this.captureClip(
      pid,
      {
        ...before.clip,
        revision: sha256(JSON.stringify([before.id, frames])),
        frames,
      },
      before.images,
    );
    for (const edit of spec.frames)
      await this.renderFrame(pid, preview.id, edit.frameId);
    const clip = this.clip(pid, spec.clipId);
    if (clip.revision !== spec.revision)
      throw new StudioError("动画已修改，请基于当前版本重试", 409);
    if (
      JSON.stringify(this.capture(pid, clip.id).images) !==
      JSON.stringify(before.images)
    )
      throw new StudioError("底图在预览期间发生变化，请重新检查", 409);
    beforeCommit?.();
    const change: FrameChange = {
      id: spec.requestId,
      projectId: pid,
      clipId: clip.id,
      frameId: spec.frames[0]!.frameId,
      frameIds: spec.frames.map((f) => f.frameId),
      baseSnapshotId: before.id,
      source,
      status: "pending",
      transform:
        spec.frames.length === 1 ? spec.frames[0]!.transform : undefined,
      durationUs:
        spec.frames.length === 1 ? spec.frames[0]!.durationUs : undefined,
      resultFrames: frames,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.changes.set(change.id, change);
    this.saveChange(change);
    const updated = this.store.updateClip(
      pid,
      clip.id,
      { revision: spec.revision, frames, loop: clip.loop },
      undefined,
      { id: change.id, action: "apply" },
    );
    change.afterSnapshotId = this.capture(pid, updated.id, updated.revision).id;
    change.status = "applied";
    this.saveChange(change);
    return change;
  }
  private saveChange(change: FrameChange) {
    change.updatedAt = new Date().toISOString();
    this.save("changes", change);
  }
  compare(pid: string, id: string) {
    const change = this.change(pid, id),
      before = this.snapshot(pid, change.baseSnapshotId);
    const after = change.afterSnapshotId
      ? this.snapshot(pid, change.afterSnapshotId)
      : change.legacyClipId &&
          this.store.indexes.get(pid)?.has(change.legacyClipId)
        ? this.capture(pid, change.legacyClipId)
        : null;
    if (!after) throw new StudioError("这条历史记录没有完整的修改后快照", 409);
    return { before, after };
  }
  revert(pid: string, id: string, expected: string) {
    const change = this.change(pid, id),
      clip = this.clip(pid, change.clipId);
    if (clip.revertedFrameChangeIds?.includes(id)) {
      change.status = "reverted";
      this.saveChange(change);
      return clip;
    }
    if (!clip.appliedFrameChangeIds?.includes(id) || !change.afterSnapshotId)
      throw new StudioError("这次修改尚未完成");
    this.capture(pid, clip.id, expected);
    if (
      clip.revision !== expected ||
      content(clip) !== content(this.snapshot(pid, change.afterSnapshotId).clip)
    )
      throw new StudioError(
        "动画有后续修改，不能撤回覆盖，请先处理后续修改",
        409,
      );
    const before = this.snapshot(pid, change.baseSnapshotId);
    for (const frame of before.clip.frames) {
      this.imagePath(pid, before.id, frame.id);
      this.store.imagePath(pid, frame.imageId);
      if (
        this.store.image(pid, frame.imageId).contentHash !==
        before.images[frame.imageId]!.contentHash
      )
        throw new StudioError(
          "历史图片已被重新切割，不能用当前图片替代旧像素进行撤回；历史快照仍可查看",
          409,
        );
    }
    const updated = this.store.updateClip(
      pid,
      clip.id,
      {
        revision: clip.revision,
        frames: before.clip.frames,
        loop: before.clip.loop,
      },
      undefined,
      { id, action: "revert" },
    );
    change.status = "reverted";
    this.saveChange(change);
    return updated;
  }
}
