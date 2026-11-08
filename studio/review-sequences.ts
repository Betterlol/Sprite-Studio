import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { StudioError, atomicJson, sha256, type ProjectStore } from "./store.ts";
import { reviewSegmentSchema, type ReviewSequenceDefinition, type ReviewSequenceSnapshot } from "./workflow-model.ts";
import type { ClipAsset, ClipFrame, ClipReview, ClipSnapshot } from "./model.ts";

const definitionBody = z.object({
  name: z.string().trim().min(1).max(200),
  loop: z.boolean(),
  segments: z.array(reviewSegmentSchema.extend({
    repeat: z.number().int().min(1).max(1024).default(1),
    speed: z.number().min(0.1).max(10).default(1),
  })).min(1).max(1024),
}).strict();
const createSchema = definitionBody.extend({ requestId: z.string().uuid() });
const updateSchema = definitionBody.extend({ expectedRevision: z.string() });
const semanticHash = (definition: ReviewSequenceDefinition) => sha256(JSON.stringify({
  loop: definition.loop, segments: definition.segments,
}));

type DefinitionRecord = { definition: ReviewSequenceDefinition; requestHash: string };
export type ReviewSequenceView = ReviewSequenceDefinition & {
  unresolved: { segmentId: string; reason: string }[];
};
export type SequenceSnapshot = ReviewSequenceSnapshot & {
  definitionHash: string;
  frameSources: {
    frameId: string; segmentId: string; clipId: string; sourceFrameId: string; repeatIndex: number;
  }[];
};
export type SequenceCoverage = {
  totalFrames: number;
  frameIds: string[];
  ranges: { reviewId: string; start: number; end: number; frameIds: string[] }[];
  pairs: { from: number; to: number; loopBoundary: boolean }[];
  boundaries: { from: number; to: number; kind: "segment" | "repeat" | "loop"; covered: boolean }[];
  complete: boolean;
};
export type SequenceInspection = ClipReview & {
  sequence: SequenceSnapshot & { coverage: SequenceCoverage; reviews: ClipReview[] };
};

/** Definitions reference stable instances; snapshots use AnimationStore's immutable pixels and evidence. */
export class ReviewSequences {
  readonly store: ProjectStore;
  private definitions = new Map<string, DefinitionRecord>();
  private snapshots = new Map<string, SequenceSnapshot>();

  constructor(store: ProjectStore) {
    this.store = store;
    for (const pid of store.projects.keys()) {
      for (const [folder, target] of [["definitions", this.definitions], ["snapshots", this.snapshots]] as const) {
        const dir = join(store.dir(pid), ".studio", "review-sequences", folder);
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir).filter(f => f.endsWith(".json"))) {
          const value = JSON.parse(readFileSync(join(dir, file), "utf8"));
          const item = folder === "definitions" ? value.definition : value;
          if (item?.projectId === pid && file === `${item.id}.json`)
            (target as Map<string, any>).set(item.id, value);
        }
      }
    }
  }

  /** Drop cached definitions and snapshots of a project whose directory was just removed. */
  purgeProject(pid: string) {
    for (const [id, record] of [...this.definitions])
      if (record.definition.projectId === pid) this.definitions.delete(id);
    for (const [id, snapshot] of [...this.snapshots])
      if (snapshot.projectId === pid) this.snapshots.delete(id);
  }

  private path(pid: string, folder: string, id: string) {
    z.string().uuid().parse(id);
    return join(this.store.dir(pid), ".studio", "review-sequences", folder, `${id}.json`);
  }
  private record(pid: string, id: string) {
    const path = this.path(pid, "definitions", id);
    if (existsSync(path)) {
      const record: DefinitionRecord = JSON.parse(readFileSync(path, "utf8"));
      if (record.definition.projectId === pid && record.definition.id === id)
        this.definitions.set(id, record);
    }
    const record = this.definitions.get(id);
    if (!record || record.definition.projectId !== pid)
      throw new StudioError("Review 序列不存在", 404);
    return record;
  }
  private save(pid: string, folder: string, id: string, item: unknown) {
    const path = this.path(pid, folder, id);
    mkdirSync(join(path, ".."), { recursive: true });
    atomicJson(path, item);
    this.store.changed(pid);
  }
  private range(pid: string, segment: ReviewSequenceDefinition["segments"][number]) {
    const clip = this.store.animation.clip(pid, segment.clipId);
    const start = segment.startFrameId ? clip.frames.findIndex(f => f.id === segment.startFrameId) : 0;
    const end = segment.endFrameId ? clip.frames.findIndex(f => f.id === segment.endFrameId) : clip.frames.length - 1;
    if (start < 0 || end < start || !clip.frames.length)
      throw new StudioError(`片段 ${segment.id} 的边界实例已删除或区间无效（unresolved）`, 409);
    return { clip, frames: clip.frames.slice(start, end + 1) };
  }
  private unresolved(definition: ReviewSequenceDefinition) {
    return definition.segments.flatMap(segment => {
      try { this.range(definition.projectId, segment); return []; }
      catch (error) { return [{ segmentId: segment.id, reason: (error as Error).message }]; }
    });
  }
  list(pid: string): ReviewSequenceView[] {
    this.store.dir(pid);
    const dir = join(this.store.dir(pid), ".studio", "review-sequences", "definitions");
    if (existsSync(dir)) for (const file of readdirSync(dir).filter(f => f.endsWith(".json"))) {
      const record: DefinitionRecord = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (record.definition?.projectId === pid && file === `${record.definition.id}.json`)
        this.definitions.set(record.definition.id, record);
    }
    return [...this.definitions.values()].filter(r => r.definition.projectId === pid)
      .map(r => this.get(pid, r.definition.id));
  }
  get(pid: string, id: string): ReviewSequenceView {
    const definition = this.record(pid, id).definition;
    return { ...structuredClone(definition), unresolved: this.unresolved(definition) };
  }
  private validate(pid: string, definition: ReviewSequenceDefinition) {
    if (new Set(definition.segments.map(s => s.id)).size !== definition.segments.length)
      throw new StudioError("片段身份不能重复");
    let count = 0, duration = 0;
    let canvas: string | undefined;
    for (const segment of definition.segments) {
      const { frames } = this.range(pid, segment);
      count += frames.length * segment.repeat;
      duration += frames.reduce((sum, f) => sum + f.durationUs, 0) * segment.repeat / segment.speed;
      if (count > 1024 || !Number.isFinite(duration) || Math.round(duration) > 600_000_000)
        throw new StudioError("Review 序列展开最多 1024 帧、10 分钟");
      for (const frame of frames) {
        const image = this.store.image(pid, frame.imageId);
        this.store.imagePath(pid, image.id);
        const size = `${image.width}x${image.height}`;
        if (canvas && canvas !== size)
          throw new StudioError(`Review 片段画布不一致：${canvas} 与 ${size}，不会逐帧 fit`);
        canvas = size;
      }
    }
  }
  create(pid: string, input: unknown): ReviewSequenceView {
    this.store.dir(pid);
    const spec = createSchema.parse(input), requestHash = sha256(JSON.stringify(spec));
    const existingPath = this.path(pid, "definitions", spec.requestId);
    if (this.definitions.has(spec.requestId) || existsSync(existingPath)) {
      const record = this.record(pid, spec.requestId);
      if (record.requestHash !== requestHash) throw new StudioError("相同 requestId 的序列参数不能改变", 409);
      return this.get(pid, spec.requestId);
    }
    const { requestId, ...body } = spec;
    const definition: ReviewSequenceDefinition = { ...body, id: requestId, projectId: pid, revision: randomUUID() };
    this.validate(pid, definition);
    const record = { definition, requestHash };
    this.save(pid, "definitions", definition.id, record);
    this.definitions.set(definition.id, record);
    return this.get(pid, definition.id);
  }
  update(pid: string, id: string, input: unknown): ReviewSequenceView {
    const spec = updateSchema.parse(input), old = this.record(pid, id);
    if (old.definition.revision !== spec.expectedRevision) throw new StudioError("Review 定义已修改，请刷新后重试", 409);
    const { expectedRevision: _, ...body } = spec;
    const definition: ReviewSequenceDefinition = { ...body, archived: old.definition.archived, id, projectId: pid, revision: randomUUID() };
    this.validate(pid, definition);
    const record = { ...old, definition };
    this.save(pid, "definitions", id, record);
    this.definitions.set(id, record);
    return this.get(pid, id);
  }
  archive(pid: string, id: string, input: unknown): ReviewSequenceView {
    const spec = z.object({ expectedRevision: z.string(), archived: z.boolean() }).strict().parse(input), old = this.record(pid, id);
    if (old.definition.revision !== spec.expectedRevision) throw new StudioError("Review 定义已修改，请刷新后重试", 409);
    if (spec.archived && this.store.tasks.listActive(pid).some(task => task.contract.reviewSequenceId === id)) throw new StudioError("活动制作任务仍依赖该Review，请先停止任务再归档", 409);
    if (!!old.definition.archived === spec.archived) return this.get(pid, id);
    const definition = { ...old.definition, archived: spec.archived, revision: randomUUID() }, record = { ...old, definition };
    // Archiving changes an active reference lease, never the semantic snapshot
    // hash or any captured pixels. Restoring may honestly report unresolved refs.
    this.save(pid, "definitions", id, record); this.definitions.set(id, record);
    return this.get(pid, id);
  }
  capture(pid: string, id: string): SequenceSnapshot {
    const definition = this.record(pid, id).definition;
    if (definition.archived) throw new StudioError("Review已归档，请先显式恢复再捕获新快照", 409);
    this.validate(pid, definition);
    const dependencies: SequenceSnapshot["dependencies"] = [];
    const segments: SequenceSnapshot["segments"] = [];
    const frameSources: SequenceSnapshot["frameSources"] = [];
    const frames: ClipFrame[] = [], images: ClipSnapshot["images"] = {};
    let elapsed = 0, allocated = 0;
    for (const segment of definition.segments) {
      const { clip, frames: sourceFrames } = this.range(pid, segment);
      let dependency = dependencies.find(d => d.clipId === clip.id);
      if (!dependency) {
        const source = this.store.animation.capture(pid, clip.id, clip.revision);
        dependency = { clipId: clip.id, revision: clip.revision, snapshotId: source.id };
        dependencies.push(dependency);
      }
      const source = this.store.animation.snapshot(pid, dependency.snapshotId);
      const frameIds: string[] = [];
      for (let repeatIndex = 0; repeatIndex < segment.repeat; repeatIndex++) for (const frame of sourceFrames) {
        elapsed += frame.durationUs / segment.speed;
        const next = Math.round(elapsed), durationUs = next - allocated;
        if (durationUs < 1) throw new StudioError("片段速度导致帧时长小于 1us");
        allocated = next;
        const frameId = randomUUID();
        frames.push({ ...structuredClone(frame), id: frameId, durationUs });
        images[frame.imageId] = source.images[frame.imageId]!;
        frameIds.push(frameId);
        frameSources.push({ frameId, segmentId: segment.id, clipId: clip.id, sourceFrameId: frame.id, repeatIndex });
      }
      segments.push({ segmentId: segment.id, frameIds });
    }
    const definitionHash = semanticHash(definition);
    const virtual: ClipAsset = {
      id: definition.id, type: "clip", name: definition.name, folder: "", createdAt: new Date().toISOString(),
      revision: sha256(JSON.stringify([definitionHash, frames, images])), loop: definition.loop, frames,
    };
    const captured = this.store.animation.captureClip(pid, virtual, images);
    const snapshot: SequenceSnapshot = {
      id: randomUUID(), definitionId: id, definitionRevision: definition.revision,
      projectId: pid, createdAt: new Date().toISOString(), snapshotId: captured.id,
      dependencies, segments, frameSources, definitionHash, stale: false,
    };
    this.save(pid, "snapshots", snapshot.id, snapshot);
    this.snapshots.set(snapshot.id, snapshot);
    return structuredClone(snapshot);
  }
  private stale(snapshot: SequenceSnapshot) {
    try {
      const definition = this.record(snapshot.projectId, snapshot.definitionId).definition;
      if (semanticHash(definition) !== snapshot.definitionHash || this.unresolved(definition).length) return true;
      for (const dependency of snapshot.dependencies) {
        const source = this.store.animation.snapshot(snapshot.projectId, dependency.snapshotId);
        const current = this.store.animation.clip(snapshot.projectId, dependency.clipId);
        if (JSON.stringify(current.frames) !== JSON.stringify(source.clip.frames) || current.loop !== source.clip.loop) return true;
        for (const image of Object.values(source.images)) {
          this.store.imagePath(snapshot.projectId, image.id);
          if (this.store.image(snapshot.projectId, image.id).contentHash !== image.contentHash) return true;
        }
      }
      return false;
    } catch { return true; }
  }
  snapshotStale(pid: string, snapshotId: string): boolean | undefined {
    const sequence = [...this.snapshots.values()].find(s => s.projectId === pid && s.snapshotId === snapshotId);
    return sequence ? this.stale(sequence) : undefined;
  }
  listSnapshots(pid: string, id: string): SequenceSnapshot[] {
    this.record(pid, id);
    return [...this.snapshots.values()].filter(s => s.projectId === pid && s.definitionId === id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(s => ({ ...structuredClone(s), stale: this.stale(s) }));
  }
  async inspect(pid: string, id: string, input: { snapshotId?: string } = {}): Promise<SequenceInspection> {
    this.record(pid, id);
    const sequence = input.snapshotId
      ? this.listSnapshots(pid, id).find(s => s.id === input.snapshotId || s.snapshotId === input.snapshotId)
      : this.capture(pid, id);
    if (!sequence) throw new StudioError("Review 序列快照不存在或不属于此定义", 404);
    const snapshot = this.store.animation.snapshot(pid, sequence.snapshotId), frames = snapshot.clip.frames;
    const reviews: ClipReview[] = [], ranges: SequenceCoverage["ranges"] = [];
    for (let start = 0; start < frames.length; start += 16) {
      const end = Math.min(start + 15, frames.length - 1);
      const review = await this.store.animation.inspect(pid, {
        snapshotId: snapshot.id, startFrameId: frames[start]!.id, endFrameId: frames[end]!.id,
      });
      reviews.push(review);
      ranges.push({ reviewId: review.id, start, end, frameIds: frames.slice(start, end + 1).map(f => f.id) });
    }
    const pairs = [...new Map(reviews.flatMap(r => r.pairs).map(p => [`${p.from}:${p.to}:${p.loopBoundary}`, p])).values()];
    const boundaries: SequenceCoverage["boundaries"] = [];
    for (let to = 1; to < sequence.frameSources.length; to++) {
      const left = sequence.frameSources[to - 1]!, right = sequence.frameSources[to]!;
      const kind = left.segmentId !== right.segmentId ? "segment" : left.repeatIndex !== right.repeatIndex ? "repeat" : undefined;
      if (kind) boundaries.push({ from: to - 1, to, kind, covered: pairs.some(p => p.from === to - 1 && p.to === to && !p.loopBoundary) });
    }
    if (snapshot.clip.loop) boundaries.push({ from: frames.length - 1, to: 0, kind: "loop", covered: pairs.some(p => p.from === frames.length - 1 && p.to === 0 && p.loopBoundary) });
    const frameIds = reviews.flatMap(r => r.frames.map(f => f.frameId));
    const complete = new Set(frameIds).size === frames.length && boundaries.every(b => b.covered) &&
      frames.every((_, i) => i === 0 || pairs.some(p => p.from === i - 1 && p.to === i && !p.loopBoundary));
    const stale = this.stale(sequence);
    return {
      ...reviews[0]!, stale,
      sequence: { ...sequence, stale, coverage: { totalFrames: frames.length, frameIds, ranges, pairs, boundaries, complete }, reviews: reviews.map(r => ({ ...r, stale })) },
    };
  }
}
