import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { bytes, clipBody } from "./documents.ts";
import { publishFiles } from "./file-operations.ts";
import { frameEditSchema, type ClipAsset, type ClipSnapshot, type RenderWarning } from "./model.ts";
import { assetRevision, atomicJson, sha256, StudioError, type ProjectStore } from "./store.ts";
import { clipEditSchema, type ClipDraft, type ClipDraftDocument, type ClipDraftPreview, type ClipDraftSave, type ClipEdit } from "./workflow-model.ts";

type RecordData = { draft: ClipDraft; text: string; documentRevision: string; images: ClipSnapshot["images"]; files: Record<string, string | null>; ownedFrameIds?: string[]; receipt?: ClipDraftSave };
type CreateInput = { clipId: string; revision: string; frameId?: string; fromDraftId?: string };
const createSchema = z.object({ clipId: z.string().uuid(), revision: z.string(), frameId: z.string().uuid().optional(), fromDraftId: z.string().uuid().optional() }).strict();
const body = (clip: ClipAsset): ClipEdit => ({ schemaVersion: 1, type: "clip-edit", frames: structuredClone(clip.frames), loop: clip.loop, initialFps: clip.initialFps });
type Ownership = { clipId: string; ids: string[]; recordId?: string };
type FolderIndex = { stamp: number; entries: Ownership[] };
// Draft indexes are shared by service instances on the same store. History is
// always reread because other store services can write it independently.
const ownershipIndexes = new WeakMap<ProjectStore, Map<string, { drafts?: FolderIndex }>>();

export class ClipDrafts {
  private saving = new Map<string, Promise<ClipDraftSave>>();
  private store: ProjectStore;
  constructor(store: ProjectStore) { this.store = store; }
  private path(id: string) { return `.studio/clip-drafts/${id}.json`; }
  private get(pid: string, id: string): RecordData {
    if (!z.string().uuid().safeParse(id).success) throw new StudioError("动画草稿不存在", 404);
    const file = this.store.safePath(pid, this.path(id));
    if (!existsSync(file)) throw new StudioError("动画草稿不存在", 404);
    const record = JSON.parse(readFileSync(file, "utf8")) as RecordData;
    if (record.draft.id !== id || record.draft.projectId !== pid) throw new StudioError("动画草稿不存在", 404);
    return record;
  }
  private persist(record: RecordData) {
    const file = this.store.safePath(record.draft.projectId, this.path(record.draft.id));
    mkdirSync(dirname(file), { recursive: true });
    atomicJson(file, record);
    const index = ownershipIndexes.get(this.store)?.get(record.draft.projectId)?.drafts;
    if (index) {
      index.entries = index.entries.filter(entry => entry.recordId !== record.draft.id);
      index.entries.push({ recordId: record.draft.id, clipId: record.draft.clipId, ids: record.ownedFrameIds ?? this.parse(record.text).frames.map(f => f.id) });
      index.stamp = statSync(dirname(file)).mtimeMs;
    }
    this.store.changed(record.draft.projectId);
  }
  private historical(record: RecordData) {
    return record.draft.source === "agent" && this.store.tasks && !this.store.tasks.draftHoldsLease(record.draft.projectId, record.draft);
  }
  private assertEditable(record: RecordData) {
    if (this.historical(record)) throw new StudioError("所属任务/意图已结束，该Agent草稿为只读历史；请显式派生新草稿", 409);
  }
  private document(record: RecordData): ClipDraftDocument {
    return { documentId: record.draft.id, documentRevision: record.documentRevision, text: record.text, draft: { ...structuredClone(record.draft), ...(this.historical(record) ? { readOnly: true } : {}) } };
  }
  private parse(text: string): ClipEdit {
    if (Buffer.byteLength(text) > 256 * 1024) throw new StudioError("草稿配置超过256KB");
    try { return clipEditSchema.parse(JSON.parse(text)); }
    catch (error) { throw new StudioError("无效动画草稿配置：" + String(error)); }
  }
  private verifyFiles(pid: string, clip: ClipAsset) {
    const read = (path: string) => JSON.parse(readFileSync(this.store.safePath(pid, path), "utf8"));
    const clean = (value: unknown) => JSON.parse(JSON.stringify(value));
    try {
      const disk = read(clip.file!);
      const expectedBody = clean(clipBody(clip));
      // The pre-FPS clip writer omitted initialFps entirely.
      if (!("initialFps" in disk) && clip.initialFps === undefined) delete expectedBody.initialFps;
      if (!isDeepStrictEqual(disk, expectedBody)) throw new Error("clip");
      const configPath = this.store.safePath(pid, clip.file! + ".config.json");
      if (existsSync(configPath) && !isDeepStrictEqual(read(clip.file! + ".config.json"), clean({ schemaVersion: 1, type: "clip", frames: clip.frames, loop: clip.loop, initialFps: clip.initialFps || 12 }))) throw new Error("config");
      const metadata = read(this.store.metaPath(pid, clip.id));
      // loadAssets supplies the directory and the conventional legacy path only
      // when absent; explicit values still have to match the loaded resource.
      if (!("folder" in metadata)) metadata.folder = clip.folder;
      if (!("file" in metadata)) metadata.file = `Assets${clip.folder ? "/" + clip.folder : ""}/${clip.id}.clip.json`;
      const { frames, loop, origin, appliedInterpolationIds, appliedFrameChangeIds, revertedFrameChangeIds, ...compact } = clip;
      if (!isDeepStrictEqual(metadata, clean(clip)) && !isDeepStrictEqual(metadata, clean(compact))) throw new Error("metadata");
    } catch {
      throw new StudioError("动画文件已被外部修改或与当前资源不一致", 409);
    }
  }
  private ownership(pid: string, kind: "history" | "drafts"): Ownership[] {
    let projects = ownershipIndexes.get(this.store);
    if (!projects) ownershipIndexes.set(this.store, projects = new Map());
    let project = projects.get(pid);
    if (!project) projects.set(pid, project = {});
    const folder = this.store.safePath(pid, kind === "history" ? ".studio/history" : ".studio/clip-drafts");
    const stamp = existsSync(folder) ? statSync(folder).mtimeMs : -1;
    const cached = kind === "drafts" ? project.drafts : undefined;
    if (cached && cached.stamp === stamp) return cached.entries;
    const entries: Ownership[] = [];
    if (stamp !== -1) for (const name of readdirSync(folder).filter(f => kind === "history" ? f.endsWith(".json") : /^[0-9a-f-]{36}\.json$/i.test(f))) {
      if (kind === "history") {
        const asset = JSON.parse(readFileSync(join(folder, name), "utf8"));
        if (asset.type === "clip" && typeof asset.id === "string" && Array.isArray(asset.frames)) entries.push({ clipId: asset.id, ids: asset.frames.map((frame: { id: string }) => frame.id) });
      } else {
        const record = this.get(pid, name.slice(0, -5));
        entries.push({ recordId: record.draft.id, clipId: record.draft.clipId, ids: record.ownedFrameIds ?? this.parse(record.text).frames.map(f => f.id) });
      }
    }
    if (kind === "drafts") project.drafts = { stamp, entries };
    return entries;
  }
  private validate(pid: string, clipId: string, value: ClipEdit) {
    const ids = value.frames.map(f => f.id);
    if (new Set(ids).size !== ids.length) throw new StudioError("草稿中的帧实例不能重复");
    const otherIds = new Set<string>();
    const add = (projectId: string, owner: string, frames: { id: string }[]) => {
      if (projectId !== pid || owner !== clipId) for (const frame of frames) otherIds.add(frame.id);
    };
    for (const projectId of this.store.projects.keys()) {
      for (const asset of this.store.assets(projectId)) if (asset.type === "clip") add(projectId, asset.id, asset.frames);
      for (const kind of ["history", "drafts"] as const) for (const entry of this.ownership(projectId, kind)) add(projectId, entry.clipId, entry.ids.map(id => ({ id })));
    }
    for (const snapshot of this.store.animation.snapshots.values()) add(snapshot.projectId, snapshot.clip.id, snapshot.clip.frames);
    if (ids.some(id => otherIds.has(id))) throw new StudioError("草稿引用了其他动画的帧实例");
    const images = value.frames.map(f => this.store.image(pid, f.imageId));
    if (images.some(i => i.frameCount !== 1) || new Set(images.map(i => `${i.width}x${i.height}`)).size > 1) throw new StudioError("动画帧需要相同画布的静态图片");
  }
  private check(pid: string, record: RecordData, revision: string) {
    if (record.documentRevision !== revision || record.draft.status !== "editing") throw new StudioError("VERSION_CONFLICT：草稿已改变或已结束", 409);
    const base = this.store.animation.snapshot(pid, record.draft.baseSnapshotId);
    this.store.animation.capture(pid, record.draft.clipId, base.clip.revision);
    for (const [path, hash] of Object.entries(record.files)) {
      const file = this.store.safePath(pid, path);
      if ((existsSync(file) ? sha256(readFileSync(file)) : null) !== hash) throw new StudioError("动画文件已被外部修改", 409);
    }
    for (const [id, frozen] of Object.entries(record.images)) {
      const image = this.store.image(pid, id);
      this.store.imagePath(pid, id);
      if (image.contentHash !== frozen.contentHash || image.width !== frozen.width || image.height !== frozen.height || image.mime !== frozen.mime) throw new StudioError("底图已变化，请重新建立动画草稿", 409);
    }
    return base;
  }
  create(pid: string, input: CreateInput, source: "human" | "agent", sessionId?: string, owner?: { taskId: string; intentVersion: number }): ClipDraftDocument {
    const spec = createSchema.parse(input);
    if (source !== "human" && source !== "agent") throw new StudioError("无效草稿来源");
    this.verifyFiles(pid, this.store.animation.clip(pid, spec.clipId));
    const base = this.store.animation.capture(pid, spec.clipId, spec.revision);
    if (spec.frameId && !base.clip.frames.some(f => f.id === spec.frameId)) throw new StudioError("帧不在目标动画中");
    if (!spec.fromDraftId) {
      const existing = this.list(pid).find(d => d.clipId === spec.clipId && d.baseSnapshotId === base.id && d.source === source && d.sessionId === sessionId && !d.readOnly);
      if (existing) return this.read(pid, existing.id);
    }
    let value = body(base.clip), images = structuredClone(base.images);
    if (spec.fromDraftId) {
      const path = this.store.safePath(pid, this.path(spec.fromDraftId));
      if (existsSync(path)) {
        const parent = this.get(pid, spec.fromDraftId);
        if (parent.draft.clipId !== spec.clipId || parent.draft.baseSnapshotId !== base.id || parent.draft.status !== "editing") throw new StudioError("派生草稿与当前动画基线不匹配", 409);
        this.check(pid, parent, parent.documentRevision);
        value = this.parse(parent.text);
        images = structuredClone(parent.images);
      } else {
        const old = this.store.frameDrafts.get(pid, spec.fromDraftId);
        if (old.clipId !== spec.clipId || old.baseSnapshotId !== base.id || old.status !== "editing") throw new StudioError("派生草稿与当前动画基线不匹配", 409);
        const legacy = frameEditSchema.parse(JSON.parse(old.text));
        const edits = new Map(legacy.frames.map(f => [f.frameId, f]));
        if (edits.size !== legacy.frames.length || legacy.frames.some(f => !base.clip.frames.some(b => b.id === f.frameId))) throw new StudioError("旧草稿包含无效帧实例");
        value.frames = value.frames.map(f => { const edit = edits.get(f.id); return edit ? { ...f, transform: edit.transform, durationUs: edit.durationUs } : f; });
      }
    }
    this.validate(pid, spec.clipId, value);
    const text = bytes(value).toString();
    const draft: ClipDraft = { id: randomUUID(), projectId: pid, clipId: spec.clipId, baseSnapshotId: base.id, source, sessionId, ...(source === "agent" ? owner : {}), status: "editing", createdAt: new Date().toISOString() };
    const files = Object.fromEntries([base.clip.file!, base.clip.file! + ".config.json", this.store.metaPath(pid, base.clip.id)].map(path => {
      const file = this.store.safePath(pid, path);
      return [path, existsSync(file) ? sha256(readFileSync(file)) : null];
    }));
    const record: RecordData = { draft, text, documentRevision: sha256(text), images, files, ownedFrameIds: value.frames.map(f => f.id) };
    this.persist(record);
    return this.document(record);
  }
  list(pid: string): ClipDraft[] {
    const folder = this.store.safePath(pid, ".studio/clip-drafts");
    if (!existsSync(folder)) return [];
    return readdirSync(folder).filter(f => /^[0-9a-f-]{36}\.json$/i.test(f)).map(f => this.document(this.get(pid, f.slice(0, -5))).draft).filter(d => d.status === "editing").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  has(pid: string, id: string) {
    return z.string().uuid().safeParse(id).success && existsSync(this.store.safePath(pid, this.path(id)));
  }
  read(pid: string, id: string): ClipDraftDocument { return this.document(this.get(pid, id)); }
  dependencyImageIds(pid: string, id: string): string[] { return Object.keys(this.get(pid, id).images); }
  freeze(pid: string, id: string, revision: string): ClipSnapshot {
    const record = this.get(pid, id), base = this.check(pid, record, revision), value = this.parse(record.text);
    this.validate(pid, record.draft.clipId, value);
    return this.store.animation.captureClip(pid, { ...base.clip, frames: value.frames, loop: value.loop, initialFps: value.initialFps ?? 12, revision: sha256(JSON.stringify([base.id, revision])) }, record.images, true);
  }
  validateText(pid: string, id: string, text: string): ClipEdit {
    const record = this.get(pid, id), value = this.parse(text);
    this.validate(pid, record.draft.clipId, value);
    return value;
  }
  prepare(pid: string, input: { documentId: string; expectedDocumentRevision: string; text: string }) {
    const record = this.get(pid, input.documentId);
    this.assertEditable(record);
    this.store.assertClipMutation(pid, record.draft.clipId);
    if (this.saving.has(`${pid}/${input.documentId}`)) throw new StudioError("草稿正在保存", 409);
    const base = this.check(pid, record, input.expectedDocumentRevision), value = this.parse(input.text);
    this.validate(pid, record.draft.clipId, value);
    const captured = this.store.animation.captureClip(pid, { ...base.clip, frames: value.frames });
    const images = { ...record.images, ...Object.fromEntries(Object.entries(captured.images).filter(([key]) => !record.images[key])) };
    const text = bytes(value).toString();
    const next = { ...record, images, text, documentRevision: sha256(text), ownedFrameIds: [...new Set([...(record.ownedFrameIds ?? this.parse(record.text).frames.map(f => f.id)), ...value.frames.map(f => f.id)])] };
    return { path: this.path(input.documentId), bytes: bytes(next) };
  }
  invalidateIndex(pid: string) { const index = ownershipIndexes.get(this.store)?.get(pid); if (index) index.drafts = undefined; }
  write(pid: string, id: string, input: { expectedDocumentRevision: string; text: string }): ClipDraftDocument {
    const record = this.get(pid, id);
    this.assertEditable(record);
    this.store.assertClipMutation(pid, record.draft.clipId);
    if (record.draft.status !== "editing" || this.saving.has(`${pid}/${id}`)) throw new StudioError("草稿已结束或正在保存", 409);
    const base = this.check(pid, record, input.expectedDocumentRevision);
    const value = this.parse(input.text);
    this.validate(pid, record.draft.clipId, value);
    // Freeze newly introduced dependencies on first reference, never silently rebase them.
    const captured = this.store.animation.captureClip(pid, { ...base.clip, frames: value.frames });
    const images = { ...record.images, ...Object.fromEntries(Object.entries(captured.images).filter(([key]) => !record.images[key])) };
    const text = bytes(value).toString();
    const next = { ...record, images, text, documentRevision: sha256(text), ownedFrameIds: [...new Set([...(record.ownedFrameIds ?? this.parse(record.text).frames.map(f => f.id)), ...value.frames.map(f => f.id)])] };
    this.persist(next);
    return this.document(next);
  }
  async preview(pid: string, id: string, revision: string): Promise<ClipDraftPreview> {
    const record = this.get(pid, id);
    if (record.draft.status !== "editing") throw new StudioError("草稿已结束", 409);
    const base = this.check(pid, record, revision), value = this.parse(record.text);
    this.validate(pid, record.draft.clipId, value);
    const clip = { ...base.clip, frames: value.frames, loop: value.loop, initialFps: value.initialFps ?? 12, revision: sha256(JSON.stringify([base.id, revision])) };
    const snapshot = this.store.animation.captureClip(pid, clip, record.images, true);
    const original = new Map(base.clip.frames.map((f, i) => [f.id, { frame: f, index: i }]));
    const modifiedFrameIds = value.frames.filter((f, i) => { const old = original.get(f.id); return !old || old.index !== i || JSON.stringify(old.frame) !== JSON.stringify(f); }).map(f => f.id);
    for (const f of base.clip.frames) if (!value.frames.some(item => item.id === f.id)) modifiedFrameIds.push(f.id);
    const modified = JSON.stringify(body(base.clip)) !== JSON.stringify(value);
    const warnings: RenderWarning[] = [];
    for (const [index, frame] of value.frames.entries()) {
      const rendered = await this.store.animation.renderFrame(pid, snapshot.id, frame.id);
      if (rendered.bounds && rendered.overflow && Object.values(rendered.overflow).some(Boolean)) warnings.push({ frameId: frame.id, frameNumber: index + 1, bounds: rendered.bounds, overflow: rendered.overflow, blocking: !!rendered.blocking });
    }
    this.check(pid, this.get(pid, id), revision);
    return { draft: record.draft, before: base, preview: snapshot, modified, modifiedFrameIds, warnings };
  }
  async save(pid: string, id: string, revision: string, beforeCommit?: () => void): Promise<ClipDraftSave> {
    const old = this.get(pid, id);
    if (old.documentRevision !== revision) throw new StudioError("VERSION_CONFLICT：草稿已改变", 409);
    if (old.draft.status === "saved" && old.receipt) return structuredClone(old.receipt);
    this.assertEditable(old);
    this.store.assertClipMutation(pid, old.draft.clipId);
    if (old.draft.status !== "editing") throw new StudioError("草稿已放弃", 409);
    const key = `${pid}/${id}`, running = this.saving.get(key);
    if (running) throw new StudioError("草稿正在保存，请稍后重试", 409);
    const promise = this.store.reading(pid, async () => {
      const preview = await this.preview(pid, id, revision);
      if (preview.warnings.some(w => w.blocking)) throw new StudioError("可见内容超出画布，请调整或允许裁切");
      const record = this.get(pid, id), base = this.check(pid, record, revision), value = this.parse(record.text);
      this.validate(pid, record.draft.clipId, value);
      const current = this.store.animation.clip(pid, record.draft.clipId);
      const next: ClipAsset = { ...current, frames: value.frames, loop: value.loop, initialFps: value.initialFps ?? 12 };
      next.revision = assetRevision(next);
      const after = this.store.animation.captureClip(pid, next, Object.fromEntries(Object.entries(record.images).filter(([imageId]) => value.frames.some(f => f.imageId === imageId))));
      const receipt: ClipDraftSave = JSON.parse(JSON.stringify({ draftId: id, clip: next, beforeSnapshotId: base.id, afterSnapshotId: after.id }));
      const saved: RecordData = { ...record, draft: { ...record.draft, status: "saved" }, receipt };
      beforeCommit?.();
      this.assertEditable(this.get(pid, id));
      this.store.assertClipMutation(pid, record.draft.clipId);
      this.check(pid, this.get(pid, id), revision);
      this.validate(pid, record.draft.clipId, value);
      publishFiles(this.store, pid, [
        { path: current.file! + ".config.json", bytes: bytes({ schemaVersion: 1, type: "clip", initialFps: next.initialFps, loop: next.loop, frames: next.frames }) },
        { path: current.file!, bytes: bytes(clipBody(next)) },
        { path: this.store.metaPath(pid, current.id), bytes: bytes(next) },
        { path: `.studio/history/${current.id}-${current.revision}.json`, bytes: bytes(current) },
        { path: this.path(id), bytes: bytes(saved) },
      ], { kind: "save-clip-draft", draftId: id });
      const projectIndex = ownershipIndexes.get(this.store)?.get(pid);
      if (projectIndex) projectIndex.drafts = undefined;
      return receipt;
    }).finally(() => this.saving.delete(key));
    this.saving.set(key, promise);
    return promise;
  }
  discard(pid: string, id: string, revision: string): ClipDraftDocument {
    const record = this.get(pid, id);
    this.store.assertClipMutation(pid, record.draft.clipId);
    if (record.draft.status !== "editing" || record.documentRevision !== revision || this.saving.has(`${pid}/${id}`)) throw new StudioError("草稿状态已改变，请刷新", 409);
    record.draft.status = "discarded";
    this.persist(record);
    return this.document(record);
  }
}
