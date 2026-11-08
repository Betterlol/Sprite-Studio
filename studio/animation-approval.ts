import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { clipDocumentSchema } from "./documents.ts";
import type { AnimationApprovalPreview, ClipAsset, ClipSnapshot } from "./model.ts";
import { assetRevision, sha256, StudioError, type ProjectStore } from "./store.ts";

export const documentWritesSchema = z.array(z.object({
  documentId: z.string().uuid(),
  expectedDocumentRevision: z.string(),
  text: z.string(),
}).strict()).min(1).max(16);

/** Draft edits are not publication. Direct writes of saved clips are. */
export function writesSavedAnimation(store: ProjectStore, pid: string, input: any): boolean {
  return Array.isArray(input?.documents) && input.documents.some((doc: any) => {
    const id = doc?.documentId;
    return typeof id === "string" && store.assets(pid).some(asset => asset.id === id && asset.type === "clip");
  });
}

function checkImages(store: ProjectStore, snapshot: ClipSnapshot) {
  for (const frozen of Object.values(snapshot.images)) {
    const current = store.image(snapshot.projectId, frozen.id);
    store.imagePath(snapshot.projectId, frozen.id);
    if (current.contentHash !== frozen.contentHash || current.width !== frozen.width || current.height !== frozen.height || current.mime !== frozen.mime)
      throw new StudioError("候选动画的图片已改变，请重新提交播放验收", 409);
  }
}

/** Preserve the existing draft-only route for transforms of existing frame instances. */
export function checkDirectClipTransforms(clip: ClipAsset, config: z.infer<typeof clipDocumentSchema>) {
  if (config.frames.some(frame => {
    const old = clip.frames.find(previous => previous.id === frame.id);
    return old && JSON.stringify(old.transform) !== JSON.stringify(frame.transform);
  })) throw new StudioError("已有帧的变换请通过完整动画草稿或帧调整草稿编辑并提交保存");
}

/** Freeze evidence, not a quality verdict. No visual score or retry policy. */
export async function prepareAnimationApproval(store: ProjectStore, pid: string, sessionId: string, name: string, input: any) {
  const animations: AnimationApprovalPreview[] = [];
  const checks: (() => void)[] = [];
  if (name === "save_clip_draft") {
    const spec = z.object({ draftId: z.string().uuid(), documentRevision: z.string() }).strict().parse(input);
    const document = store.clipDrafts.read(pid, spec.draftId);
    if (document.draft.source !== "agent" || document.draft.sessionId !== sessionId)
      throw new StudioError("草稿不属于当前Agent会话", 409);
    // A completed idempotent retry has no new candidate to accept.
    if (document.draft.status !== "saved" && !document.draft.delivery) {
      const preview = await store.clipDrafts.preview(pid, spec.draftId, spec.documentRevision);
      animations.push({
        clipId: preview.before.clip.id, clipName: preview.before.clip.name,
        beforeSnapshotId: preview.before.id, previewSnapshotId: preview.preview.id,
        draftId: spec.draftId, documentRevision: spec.documentRevision,
        deliveryOnly: !!document.draft.deliveryTarget, warnings: preview.warnings,
      });
      checks.push(() => {
        if (store.clipDrafts.freeze(pid, spec.draftId, spec.documentRevision).id !== preview.preview.id)
          throw new StudioError("候选动画已改变，请重新提交播放验收", 409);
        checkImages(store, preview.preview);
      });
    }
  } else if (name === "write_documents" && writesSavedAnimation(store, pid, input)) {
    const documents = documentWritesSchema.parse(input.documents);
    if (new Set(documents.map(doc => doc.documentId)).size !== documents.length)
      throw new StudioError("每次提交1至16份不同配置");
    for (const [index, doc] of documents.entries()) {
      const asset = store.assets(pid).find(asset => asset.id === doc.documentId);
      if (asset?.type !== "clip") continue;
      const current = store.documents.read(pid, asset.id);
      if (current.documentRevision !== doc.expectedDocumentRevision)
        throw new StudioError("VERSION_CONFLICT：动画配置已变化，请重新读取", 409);
      store.assertClipMutation(pid, asset.id);
      const config = store.documents.parse(pid, asset.id, doc.text) as z.infer<typeof clipDocumentSchema>;
      checkDirectClipTransforms(asset, config);
      // Allocate new instance IDs once. Preview and atomic save use identical text.
      const frames = config.frames.map(frame => ({ ...frame, id: frame.id || randomUUID() }));
      input.documents[index].text = JSON.stringify({ ...config, frames });
      const next = { ...asset, frames, loop: config.loop, initialFps: config.initialFps };
      next.revision = assetRevision(next);
      const before = store.animation.capture(pid, asset.id, asset.revision);
      const preview = store.animation.captureClip(pid, next, undefined, true);
      const fileHash = (path: string) => existsSync(store.safePath(pid, path)) ? sha256(readFileSync(store.safePath(pid, path))) : null;
      const files = [asset.file!, current.path, store.metaPath(pid, asset.id)]
        .map(path => ({ path, hash: fileHash(path) }));
      animations.push({ clipId: asset.id, clipName: asset.name, beforeSnapshotId: before.id, previewSnapshotId: preview.id, warnings: [] });
      checks.push(() => {
        if (store.documents.read(pid, asset.id).documentRevision !== doc.expectedDocumentRevision || store.animation.capture(pid, asset.id).id !== before.id)
          throw new StudioError("动画基线已改变，请重新提交播放验收", 409);
        for (const file of files) if (fileHash(file.path) !== file.hash)
          throw new StudioError("动画文件已改变，请重新提交播放验收", 409);
        checkImages(store, preview);
      });
    }
  }
  return { animations, validate: () => { for (const check of checks) check(); } };
}
