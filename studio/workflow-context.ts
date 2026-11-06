import { z } from "zod";
import { sha256, StudioError, type ProjectStore } from "./store.ts";
import { editingContextSchema, type EditingContext } from "./workflow-model.ts";
import type { ClipSnapshot } from "./model.ts";

/** Resolve identity once. Browsing context is evidence, never a write capability. */
export function freezeEditingContext(store: ProjectStore, pid: string, input: unknown): EditingContext {
  const value = editingContextSchema.parse(input);
  let snapshot: ClipSnapshot | undefined;
  const asset = value.assetId ? store.asset(pid, value.assetId) : undefined;
  if (value.mode === "draft") {
    if (!value.draftId || !value.documentRevision) throw new StudioError("草稿上下文需要确切draftId和documentRevision");
    if (store.clipDrafts.has(pid, value.draftId)) {
      snapshot = store.clipDrafts.freeze(pid, value.draftId, value.documentRevision);
    } else {
      const draft = store.frameDrafts.check(pid, value.draftId, value.documentRevision);
      if (draft.status !== "editing") throw new StudioError("草稿已结束或正在审批", 409);
      const base = store.animation.snapshot(pid, draft.baseSnapshotId);
      const edits = new Map(store.frameDrafts.edits(pid, draft).map(f => [f.frameId, f]));
      snapshot = store.animation.captureClip(pid, {
        ...base.clip, revision: sha256(JSON.stringify([base.id, value.documentRevision])),
        frames: base.clip.frames.map(f => { const edit = edits.get(f.id); return edit ? { ...f, transform: edit.transform, durationUs: edit.durationUs } : f; }),
      }, base.images, true);
    }
    if (value.snapshotId && value.snapshotId !== snapshot.id) throw new StudioError("草稿快照与确切正文不一致", 409);
  } else {
    if (value.draftId || value.documentRevision) throw new StudioError("saved上下文与草稿正文不一致，不能混用");
    if (value.snapshotId) {
      snapshot = store.animation.snapshot(pid, value.snapshotId);
      if (snapshot.renderMode) throw new StudioError("草稿快照不能冒充已保存动画");
    } else if (value.clipId || asset?.type === "clip") {
      snapshot = store.animation.capture(pid, value.clipId || asset!.id, value.revision);
    }
  }
  if (snapshot) {
    if ((value.clipId && value.clipId !== snapshot.clip.id) || (asset && asset.id !== snapshot.clip.id)) throw new StudioError("资源、动画、快照或草稿不一致", 409);
    // A draft's revision is its saved baseline; documentRevision identifies its body.
    const revision = value.mode === "draft"
      ? store.animation.snapshot(pid, store.clipDrafts.has(pid, value.draftId!) ? store.clipDrafts.read(pid, value.draftId!).draft.baseSnapshotId : store.frameDrafts.get(pid, value.draftId!).baseSnapshotId).clip.revision
      : snapshot.clip.revision;
    if (value.revision && value.revision !== revision) throw new StudioError("目标版本已变化", 409);
    if (snapshot.clip.frames.length) store.animation.range(snapshot, value.startFrameId, value.endFrameId);
    else if (value.frameId || value.startFrameId || value.endFrameId) throw new StudioError("空动画没有可引用的帧区间");
    if (value.frameId && !snapshot.clip.frames.some(f => f.id === value.frameId)) throw new StudioError("帧不属于上下文动画");
    return { ...value, clipId: snapshot.clip.id, revision, snapshotId: snapshot.id };
  }
  if (!asset || asset.type !== "image" || value.clipId || value.frameId || value.startFrameId || value.endFrameId) throw new StudioError("上下文没有可解析的目标");
  store.imagePath(pid, asset.id, value.revision);
  return { ...value, revision: asset.revision };
}

/** Human source edits invalidate the derived Agent intent, including during render. */
export function assertDraftSourceCurrent(store: ProjectStore, pid: string, context?: EditingContext) {
  if (context?.mode !== "draft" || !context.draftId) return;
  const current = store.clipDrafts.has(pid, context.draftId)
    ? store.clipDrafts.read(pid, context.draftId)
    : store.frameDrafts.read(pid, context.draftId);
  if (current.documentRevision !== context.documentRevision || current.draft.status !== "editing") throw new StudioError("VERSION_CONFLICT：人工来源草稿已改变或结束，旧Agent意图失效", 409);
}

export const workflowMessageSchema = z.object({ context: editingContextSchema.optional(), taskId: z.string().uuid().optional() });
