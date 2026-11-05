import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { StudioError, atomicJson, sha256, type ProjectStore } from "./store.ts";
import {
  clipReferenceSchema,
  frameAdjustmentSchema,
  type ClipSnapshot,
  type ClipReview,
  type FrameChange,
  type ClipAsset,
  type ClipAttachment,
} from "./model.ts";

const content = (clip: ClipAsset) =>
  JSON.stringify({ frames: clip.frames, loop: clip.loop });
export class AnimationStore {
  store: ProjectStore;
  snapshots = new Map<string, ClipSnapshot>();
  reviews = new Map<string, ClipReview>();
  changes = new Map<string, FrameChange>();
  adjusting = new Map<string, Promise<FrameChange>>();
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
    const images: ClipSnapshot["images"] = {};
    for (const frame of clip.frames) {
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
        snapshot.projectId === pid &&
        snapshot.clip.id === id &&
        snapshot.clip.revision === clip.revision &&
        JSON.stringify(snapshot.images) === JSON.stringify(images),
    );
    if (cached) return cached;
    const snapshot: ClipSnapshot = {
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
    try {
      const snapshot = this.snapshot(review.projectId, review.snapshotId);
      return (
        this.clip(review.projectId, review.clipId).revision !==
          review.clipRevision ||
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
        review.startFrameId === frames[0]!.id &&
        review.endFrameId === frames.at(-1)!.id,
    );
    if (cached) {
      this.evidence(pid, cached.id, "contact");
      this.evidence(pid, cached.id, "onion");
      return this.review(pid, cached.id);
    }
    const params = snapshot.clip.frames.map((frame, index) => ({
      ...frame,
      index,
      path: this.imagePath(pid, snapshot.id, frame.id).path,
    }));
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
    const spec = frameAdjustmentSchema.parse(input),
      existing = this.changes.get(spec.requestId);
    if (existing) return Promise.resolve(this.change(pid, spec.requestId));
    const running = this.adjusting.get(spec.requestId);
    if (running) return running.then((change) => this.change(pid, change.id));
    const promise = this.store
      .reading(pid, () => this.applyAdjustment(pid, spec, source))
      .finally(() => this.adjusting.delete(spec.requestId));
    this.adjusting.set(spec.requestId, promise);
    return promise;
  }
  private async applyAdjustment(
    pid: string,
    spec: ReturnType<typeof frameAdjustmentSchema.parse>,
    source: "agent" | "human",
  ) {
    const before = this.capture(pid, spec.clipId, spec.revision),
      frame = before.clip.frames.find((frame) => frame.id === spec.frameId);
    if (!frame) throw new StudioError("帧不在目标动画中");
    let imageId = frame.imageId;
    if (spec.transform) {
      const image = this.store.image(pid, imageId);
      imageId = (
        await this.store.transform(
          pid,
          image.id,
          image.revision,
          spec.transform,
        )
      ).id;
    }
    const clip = this.clip(pid, spec.clipId);
    if (clip.revision !== spec.revision)
      throw new StudioError("动画已修改，请基于当前版本重试", 409);
    const frames = clip.frames.map((current) =>
      current.id === spec.frameId
        ? {
            ...current,
            imageId,
            durationUs: spec.durationUs ?? current.durationUs,
          }
        : current,
    );
    const change: FrameChange = {
      id: spec.requestId,
      projectId: pid,
      clipId: clip.id,
      frameId: frame.id,
      baseSnapshotId: before.id,
      source,
      status: "pending",
      transform: spec.transform,
      durationUs: spec.durationUs,
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
