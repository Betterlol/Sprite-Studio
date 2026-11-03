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
  proposing = new Map<string, Promise<FrameChange>>();
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
      if (!store.indexes.get(change.projectId)?.has(change.clipId)) continue;
      const clip = this.clip(change.projectId, change.clipId);
      if (clip.revertedFrameChangeIds?.includes(change.id))
        change.status = "reverted";
      else if (clip.appliedFrameChangeIds?.includes(change.id))
        change.status = "applied";
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
      throw new StudioError("修改候选不存在", 404);
    return change;
  }
  propose(
    pid: string,
    input: unknown,
    source: "agent" | "human" = "human",
  ): Promise<FrameChange> {
    const spec = frameAdjustmentSchema.parse(input),
      existing = this.changes.get(spec.requestId);
    if (existing) return Promise.resolve(this.change(pid, spec.requestId));
    const running = this.proposing.get(spec.requestId);
    if (running) return running.then((change) => this.change(pid, change.id));
    const promise = this.buildChange(pid, spec, source).finally(() =>
      this.proposing.delete(spec.requestId),
    );
    this.proposing.set(spec.requestId, promise);
    return promise;
  }
  private async buildChange(
    pid: string,
    spec: ReturnType<typeof frameAdjustmentSchema.parse>,
    source: "agent" | "human",
  ) {
    const snapshot = this.capture(pid, spec.clipId, spec.revision),
      frame = snapshot.clip.frames.find((frame) => frame.id === spec.frameId);
    if (!frame) throw new StudioError("帧不在目标动画中");
    let imageId = frame.imageId;
    if (spec.transform) {
      const image = this.store.image(pid, imageId),
        adjusted = await this.store.transform(
          pid,
          image.id,
          image.revision,
          spec.transform,
        );
      imageId = adjusted.id;
    }
    if (this.clip(pid, spec.clipId).revision !== spec.revision)
      throw new StudioError("动画已修改，候选图片保留，请基于新版本重试", 409);
    const candidate = this.store.createClip(
      pid,
      `${snapshot.clip.name} · 单帧修正`,
      snapshot.clip.frames.map((current) =>
        current.id === spec.frameId
          ? {
              ...current,
              imageId,
              durationUs: spec.durationUs ?? current.durationUs,
            }
          : current,
      ),
      { assetId: spec.clipId, revision: spec.revision },
      snapshot.clip.loop,
    );
    const change: FrameChange = {
      id: spec.requestId,
      projectId: pid,
      clipId: spec.clipId,
      frameId: spec.frameId,
      baseSnapshotId: snapshot.id,
      candidateClipId: candidate.id,
      source,
      status: "draft",
      transform: spec.transform,
      durationUs: spec.durationUs,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.changes.set(change.id, change);
    this.save("changes", change);
    return change;
  }
  private saveChange(change: FrameChange) {
    change.updatedAt = new Date().toISOString();
    this.save("changes", change);
  }
  compare(pid: string, id: string, expectedCandidate?: string) {
    const change = this.change(pid, id),
      before = this.snapshot(pid, change.baseSnapshotId),
      after =
        change.appliedSnapshotId &&
        (change.status === "applied" || change.status === "reverted")
          ? this.snapshot(pid, change.appliedSnapshotId)
          : this.capture(pid, change.candidateClipId, expectedCandidate);
    return { before, after };
  }
  apply(pid: string, id: string, expectedCandidate: string) {
    const change = this.change(pid, id),
      clip = this.clip(pid, change.clipId);
    if (
      clip.revertedFrameChangeIds?.includes(id) ||
      change.status === "discarded"
    )
      throw new StudioError("这次修改已撤回或放弃，请创建新候选", 409);
    if (clip.appliedFrameChangeIds?.includes(id)) {
      change.status = "applied";
      this.saveChange(change);
      return clip;
    }
    const base = this.snapshot(pid, change.baseSnapshotId);
    if (clip.revision !== base.clip.revision)
      throw new StudioError(
        "原动画已修改，不能覆盖，请基于当前版本重新准备候选",
        409,
      );
    this.capture(pid, clip.id, base.clip.revision);
    const after = this.capture(pid, change.candidateClipId, expectedCandidate);
    change.appliedSnapshotId = after.id;
    this.saveChange(change);
    const updated = this.store.updateClip(
      pid,
      clip.id,
      {
        revision: clip.revision,
        frames: after.clip.frames,
        loop: after.clip.loop,
      },
      undefined,
      { id, action: "apply" },
    );
    change.status = "applied";
    this.saveChange(change);
    return updated;
  }
  revert(pid: string, id: string, expected: string) {
    const change = this.change(pid, id),
      clip = this.clip(pid, change.clipId);
    if (clip.revertedFrameChangeIds?.includes(id)) {
      change.status = "reverted";
      this.saveChange(change);
      return clip;
    }
    if (!clip.appliedFrameChangeIds?.includes(id) || !change.appliedSnapshotId)
      throw new StudioError("这次修改尚未采纳");
    this.capture(pid, clip.id, expected);
    if (
      clip.revision !== expected ||
      content(clip) !==
        content(this.snapshot(pid, change.appliedSnapshotId).clip)
    )
      throw new StudioError(
        "采纳后动画有新修改，不能撤回覆盖，请先处理后续修改",
        409,
      );
    const before = this.snapshot(pid, change.baseSnapshotId);
    for (const frame of before.clip.frames) {
      this.imagePath(pid, before.id, frame.id);
      this.store.imagePath(pid, frame.imageId);
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
  discard(pid: string, id: string) {
    const change = this.change(pid, id);
    if (change.status !== "draft")
      throw new StudioError("只能放弃未采纳的候选", 409);
    change.status = "discarded";
    this.saveChange(change);
    return change;
  }
}
