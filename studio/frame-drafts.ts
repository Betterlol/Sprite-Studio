import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicJson, sha256, StudioError, type ProjectStore } from "./store.ts";
import { bytes } from "./documents.ts";
import {
  frameEditSchema,
  legacyFrameEditSchema,
  type FrameDraft,
  type FrameChange,
  type ClipSnapshot,
  type RenderWarning,
} from "./model.ts";

export const frameSavePolicySchema = z.enum(["ask", "allow", "deny"]);
const identity = () => ({ scale: 1, offsetX: 0, offsetY: 0, clip: false });
const entries = (base: ClipSnapshot) =>
  base.clip.frames.map((f) => ({
    frameId: f.id,
    transform: f.transform || identity(),
    durationUs: f.durationUs,
  }));
export class FrameDrafts {
  store: ProjectStore;
  records = new Map<string, string>();
  saving = new Map<string, Promise<FrameChange>>();
  constructor(store: ProjectStore) {
    this.store = store;
    for (const pid of store.projects.keys()) {
      const folder = store.safePath(pid, ".studio/animation/drafts");
      if (!existsSync(folder)) continue;
      const active: FrameDraft[] = [];
      for (const file of readdirSync(folder).filter((f) =>
        f.endsWith(".json"),
      )) {
        const original = JSON.parse(
          readFileSync(join(folder, file), "utf8"),
        ) as FrameDraft;
        if (original.projectId !== pid || file !== original.id + ".json")
          continue;
        const draft = structuredClone(original);
        this.records.set(draft.id, pid);
        if (this.historical(draft)) {
          const clip = store.indexes.get(pid)?.get(draft.clipId);
          if (clip?.type === "clip" && clip.appliedFrameChangeIds?.includes(draft.id) && draft.status !== "saved") this.persist({ ...draft, status: "saved", changeId: draft.id });
          else if (draft.status === "pending") this.persist({ ...draft, status: "editing" });
          // No live approval survives restart, but historical readonly still
          // applies. Preserve text (including v1) and never merge it into a
          // new owner/intent merely because its immutable base is the same.
          continue;
        }
        const raw = JSON.parse(draft.text);
        if (raw.schemaVersion === 1) {
          const old = legacyFrameEditSchema.parse(raw),
            base = store.animation.snapshot(pid, draft.baseSnapshotId);
          const text = bytes({
            schemaVersion: 2,
            type: "frame-edit",
            frames: entries(base).map((f) =>
              f.frameId === draft.frameId
                ? { ...f, transform: old.transform, durationUs: old.durationUs }
                : f,
            ),
          }).toString();
          const backup = join(folder, "legacy");
          mkdirSync(backup, { recursive: true });
          if (!existsSync(join(backup, file)))
            atomicJson(join(backup, file), original);
          draft.text = text;
          draft.documentRevision = sha256(text);
        }
        const clip = store.indexes.get(pid)?.get(draft.clipId);
        if (
          clip?.type === "clip" &&
          clip.appliedFrameChangeIds?.includes(draft.id)
        ) {
          draft.status = "saved";
          draft.changeId = draft.id;
        } else if (draft.status === "pending") draft.status = "editing";
        this.persist(draft);
        if (draft.status === "editing") active.push(draft);
      }
      // Only current same-owner/intent per-frame drafts may be combined. Old
      // task-associated files without explicit tags stay separate rather than
      // guessing an owner; ordinary unbound/human recovery keeps its old merge.
      const groups = new Map<string, FrameDraft[]>();
      for (const draft of active) {
        const key = JSON.stringify([
          draft.clipId,
          draft.baseSnapshotId,
          draft.source,
          draft.sessionId,
          draft.taskId,
          draft.intentVersion,
          draft.source === "agent" && !draft.taskId && store.tasks.legacyDraftHasTaskOwner(pid, draft) ? draft.id : undefined,
        ]);
        groups.set(key, [...(groups.get(key) || []), draft]);
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        group.sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        );
        const target = group[0]!,
          base = store.animation.snapshot(pid, target.baseSnapshotId),
          combined = entries(base);
        for (const draft of group) {
          for (const edit of this.edits(pid, draft)) {
            const index = combined.findIndex((f) => f.frameId === edit.frameId);
            combined[index] = edit;
          }
        }
        const text = bytes({
          schemaVersion: 2,
          type: "frame-edit",
          frames: combined,
        }).toString();
        this.persist({ ...target, text, documentRevision: sha256(text) });
        for (const old of group.slice(1))
          this.persist({ ...old, status: "discarded", mergedInto: target.id });
      }
    }
  }
  private historical(draft: FrameDraft) {
    // draftHoldsLease reads raw task records only: never Task.view, which may
    // resolve a target draft and recurse back into get during startup/read.
    return draft.source === "agent" && !!this.store.tasks && !this.store.tasks.draftHoldsLease(draft.projectId, draft);
  }
  private view(draft: FrameDraft): FrameDraft {
    const { readOnly: _readOnly, ...record } = draft;
    return { ...record, ...(this.historical(record) ? { readOnly: true } : {}) };
  }
  private assertEditable(draft: FrameDraft) {
    if (this.historical(draft)) throw new StudioError("所属任务/意图已结束，该Agent帧草稿为只读历史；请显式派生新草稿", 409);
  }
  path(id: string) {
    return `.studio/animation/drafts/${id}.json`;
  }
  has(id: string) {
    return this.records.has(id);
  }
  get(pid: string, id: string): FrameDraft {
    if (this.records.get(id) !== pid)
      throw new StudioError("动画调整草稿不存在", 404);
    const draft = JSON.parse(readFileSync(this.store.safePath(pid, this.path(id)), "utf8")) as FrameDraft;
    if (draft.id !== id || draft.projectId !== pid) throw new StudioError("动画调整草稿不存在", 404);
    return this.view(draft);
  }
  list(pid: string) {
    return [...this.records]
      .filter(([, p]) => p === pid)
      .map(([id]) => this.get(pid, id))
      .filter((d) => d.status === "editing" || d.status === "pending")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  persist(draft: FrameDraft) {
    const file = this.store.safePath(draft.projectId, this.path(draft.id));
    mkdirSync(join(file, ".."), { recursive: true });
    const { readOnly: _readOnly, ...record } = draft;
    atomicJson(file, record);
    this.records.set(draft.id, draft.projectId);
    this.store.changed(draft.projectId);
    return this.view(record);
  }
  create(
    pid: string,
    input: { clipId: string; revision: string; frameId: string },
    source: "agent" | "human",
    sessionId?: string,
    owner?: { taskId: string; intentVersion: number },
  ) {
    const spec = z
      .object({
        clipId: z.string().uuid(),
        revision: z.string(),
        frameId: z.string().uuid(),
      })
      .strict()
      .parse(input);
    const base = this.store.animation.capture(pid, spec.clipId, spec.revision);
    if (!base.clip.frames.some((f) => f.id === spec.frameId))
      throw new StudioError("帧不在目标动画中");
    const existing = this.list(pid).find(
      (d) =>
        d.clipId === spec.clipId &&
        d.source === source &&
        d.sessionId === sessionId &&
        !d.readOnly &&
        d.taskId === (source === "agent" ? owner?.taskId : undefined) &&
        d.intentVersion === (source === "agent" ? owner?.intentVersion : undefined) &&
        d.baseSnapshotId === base.id,
    );
    if (existing) return this.read(pid, existing.id);
    const text = bytes({
      schemaVersion: 2,
      type: "frame-edit",
      frames: entries(base),
    }).toString();
    const draft: FrameDraft = {
      id: randomUUID(),
      projectId: pid,
      clipId: spec.clipId,
      frameId: spec.frameId,
      baseSnapshotId: base.id,
      source,
      sessionId,
      ...(source === "agent" ? owner : {}),
      status: "editing",
      createdAt: new Date().toISOString(),
      text,
      documentRevision: sha256(text),
    };
    this.persist(draft);
    return this.read(pid, draft.id);
  }
  read(pid: string, id: string) {
    const draft = this.get(pid, id);
    return {
      documentId: id,
      path: this.path(id),
      type: "frame-edit",
      text: draft.text,
      documentRevision: draft.documentRevision,
      definitionRevision: draft.documentRevision,
      exists: true,
      draft,
    };
  }
  parse(text: string) {
    if (Buffer.byteLength(text) > 256 * 1024)
      throw new StudioError("草稿配置超过256KB");
    try {
      return frameEditSchema.parse(JSON.parse(text));
    } catch (error) {
      throw new StudioError("无效动画调整配置：" + String(error));
    }
  }
  configuration(pid: string, draft: FrameDraft) {
    const raw = JSON.parse(draft.text);
    if (raw.schemaVersion !== 1) return this.parse(draft.text);
    const old = legacyFrameEditSchema.parse(raw), base = this.store.animation.snapshot(pid, draft.baseSnapshotId);
    return frameEditSchema.parse({ schemaVersion: 2, type: "frame-edit", frames: entries(base).map(frame => frame.frameId === draft.frameId ? { ...frame, transform: old.transform, durationUs: old.durationUs } : frame) });
  }
  edits(pid: string, draft: FrameDraft) {
    const config = this.configuration(pid, draft),
      base = this.store.animation.snapshot(pid, draft.baseSnapshotId),
      original = entries(base);
    if (
      new Set(config.frames.map((f) => f.frameId)).size !== config.frames.length
    )
      throw new StudioError("草稿中的帧实例不能重复");
    return config.frames.filter((f) => {
      const before = original.find((b) => b.frameId === f.frameId);
      if (!before) throw new StudioError("草稿引用了动画之外的帧实例");
      return JSON.stringify(f) !== JSON.stringify(before);
    });
  }
  prepare(
    pid: string,
    input: {
      documentId: string;
      expectedDocumentRevision: string;
      text: string;
    },
  ) {
    const draft = this.get(pid, input.documentId);
    this.assertEditable(draft);
    this.store.assertClipMutation(pid, draft.clipId);
    if (draft.status !== "editing")
      throw new StudioError(
        draft.mergedInto
          ? `旧草稿已合并到${draft.mergedInto}，请重新读取动画草稿`
          : "草稿正在等待审批或已结束，不能修改",
        409,
      );
    if (draft.documentRevision !== input.expectedDocumentRevision)
      throw new StudioError("VERSION_CONFLICT：草稿已改变，请重新读取", 409);
    const text = bytes(this.parse(input.text)).toString();
    this.edits(pid, { ...draft, text });
    return {
      path: this.path(draft.id),
      bytes: bytes({
        ...draft,
        text,
        documentRevision: sha256(text),
        snapshotId: undefined,
      }),
    };
  }
  check(pid: string, id: string, revision: string) {
    const draft = this.get(pid, id);
    if (draft.documentRevision !== revision)
      throw new StudioError("VERSION_CONFLICT：草稿已改变，请重新预览", 409);
    const base = this.store.animation.snapshot(pid, draft.baseSnapshotId),
      current = this.store.animation.capture(
        pid,
        draft.clipId,
        base.clip.revision,
      );
    if (JSON.stringify(current.images) !== JSON.stringify(base.images))
      throw new StudioError("底图已变化，请重新建立动画调整草稿", 409);
    return draft;
  }
  async preview(pid: string, id: string, revision: string) {
    const draft = this.get(pid, id);
    if (draft.documentRevision !== revision)
      throw new StudioError("草稿已改变，请重新预览", 409);
    const base = this.store.animation.snapshot(pid, draft.baseSnapshotId),
      edits = this.edits(pid, draft),
      byId = new Map(edits.map((e) => [e.frameId, e]));
    const snapshot = this.store.animation.captureClip(
      pid,
      {
        ...base.clip,
        revision: sha256(JSON.stringify([base.id, revision])),
        frames: base.clip.frames.map((f) => {
          const edit = byId.get(f.id);
          return edit
            ? { ...f, transform: edit.transform, durationUs: edit.durationUs }
            : f;
        }),
      },
      base.images,
      true,
    );
    const warnings: RenderWarning[] = [];
    for (const edit of edits) {
      const rendered = await this.store.animation.renderFrame(
        pid,
        snapshot.id,
        edit.frameId,
      );
      if (
        rendered.bounds &&
        rendered.overflow &&
        Object.values(rendered.overflow).some(Boolean)
      )
        warnings.push({
          frameId: edit.frameId,
          frameNumber:
            base.clip.frames.findIndex((f) => f.id === edit.frameId) + 1,
          bounds: rendered.bounds,
          overflow: rendered.overflow,
          blocking: !!rendered.blocking,
        });
    }
    return {
      draft,
      before: base,
      preview: snapshot,
      modified: edits.length > 0,
      modifiedFrameIds: edits.map((e) => e.frameId),
      warnings,
    };
  }
  async save(pid: string, id: string, revision: string) {
    const old = this.get(pid, id);
    if (old.documentRevision !== revision)
      throw new StudioError("草稿已改变，请重新提交保存", 409);
    if (old.status === "saved")
      return this.store.animation.change(pid, old.changeId!);
    this.assertEditable(old);
    this.store.assertClipMutation(pid, old.clipId);
    if (old.status === "discarded") throw new StudioError("草稿已放弃", 409);
    const running = this.saving.get(id);
    if (running) return running;
    const promise = this.store
      .reading(pid, async () => {
        const draft = this.check(pid, id, revision),
          edits = this.edits(pid, draft);
        if (!edits.length) throw new StudioError("没有需要保存的帧修改");
        this.persist({ ...draft, status: "pending" });
        try {
          const preview = await this.preview(pid, id, revision),
            blocked = preview.warnings.filter((w) => w.blocking);
          if (blocked.length)
            throw new StudioError(
              `第 ${blocked.map((w) => w.frameNumber).join("、")} 帧可见内容超出画布，请减小偏移、缩放，或勾选允许裁切`,
            );
          this.check(pid, id, revision);
          const base = this.store.animation.snapshot(pid, draft.baseSnapshotId);
          const change = await this.store.animation.adjustFrames(
            pid,
            {
              requestId: id,
              clipId: draft.clipId,
              revision: base.clip.revision,
              frames: edits,
            },
            draft.source,
            () => {
              this.assertEditable(this.get(pid, id));
              this.store.assertClipMutation(pid, draft.clipId);
              this.check(pid, id, revision);
            },
          );
          this.persist({ ...draft, status: "saved", changeId: change.id });
          return change;
        } catch (error) {
          this.persist({ ...draft, status: "editing" });
          throw error;
        }
      })
      .finally(() => this.saving.delete(id));
    this.saving.set(id, promise);
    return promise;
  }
  discard(pid: string, id: string, revision: string) {
    const draft = this.get(pid, id);
    this.store.assertClipMutation(pid, draft.clipId);
    if (draft.status !== "editing" || draft.documentRevision !== revision)
      throw new StudioError("草稿状态已改变，请刷新", 409);
    return this.persist({ ...draft, status: "discarded" });
  }
  policy() {
    return this.store.permissions.read().save_frame_draft;
  }
  setPolicy(value: unknown) {
    return this.store.permissions.write({
      save_frame_draft: frameSavePolicySchema.parse(value),
    }).save_frame_draft;
  }
}
