import type { ClipAsset, Asset } from "../studio/model.ts";
import { clipEditSchema, type ClipEdit, type ClipDraftDocument, type EditingContext, type ProductionTask } from "../studio/workflow-model.ts";

export const clipEdit = (clip: ClipAsset): ClipEdit => ({ schemaVersion: 1, type: "clip-edit", frames: structuredClone(clip.frames), loop: clip.loop, initialFps: clip.initialFps });
export type EditorState = { present: ClipEdit; past: ClipEdit[]; future: ClipEdit[]; version: number };
export type EditorAction = { type: "edit"; edit: ClipEdit } | { type: "undo" | "redo" };
export const editorState = (edit: ClipEdit): EditorState => ({ present: edit, past: [], future: [], version: 0 });
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  if (action.type === "edit") {
    const edit = clipEditSchema.parse(action.edit);
    if (sameClipText(JSON.stringify(edit), JSON.stringify(state.present))) return state;
    return { present: edit, past: [...state.past.slice(-99), state.present], future: [], version: state.version + 1 };
  }
  if (action.type === "undo" && state.past.length) return { present: state.past.at(-1)!, past: state.past.slice(0, -1), future: [state.present, ...state.future], version: state.version + 1 };
  if (action.type === "redo" && state.future.length) return { present: state.future[0]!, past: [...state.past, state.present], future: state.future.slice(1), version: state.version + 1 };
  return state;
}

/** Compare shared-schema meaning, not server whitespace, key order or explicit defaults. */
export function clipTextKey(text: string): string {
  try {
    const edit = clipEditSchema.parse(JSON.parse(text));
    return `clip:${JSON.stringify({ frames: edit.frames.map(frame => ({ id: frame.id, imageId: frame.imageId, durationUs: frame.durationUs, transform: { scale: frame.transform?.scale ?? 1, offsetX: frame.transform?.offsetX ?? 0, offsetY: frame.transform?.offsetY ?? 0, clip: frame.transform?.clip ?? false } })), loop: edit.loop, initialFps: edit.initialFps ?? 12 })}`;
  } catch { return `literal:${text}`; }
}
export const sameClipText = (left: string, right: string) => clipTextKey(left) === clipTextKey(right);

/** One serial queue per document. Never retry an unknown/conflicted write with a newer revision. */
export class DraftQueue {
  document: ClipDraftDocument;
  desired: string;
  error: Error | null = null;
  private pending: Promise<ClipDraftDocument> | null = null;
  private put: (revision: string, text: string) => Promise<ClipDraftDocument>;
  constructor(document: ClipDraftDocument, put: (revision: string, text: string) => Promise<ClipDraftDocument>) {
    this.put = put;
    this.document = document;
    this.desired = document.text;
  }
  enqueue(text: string) {
    if (this.document.draft.source !== "human" || this.document.draft.status !== "editing") throw new Error("此草稿为只读，不能覆盖助手或已结束的草稿");
    this.desired = text;
  }
  async flush(): Promise<ClipDraftDocument> {
    if (this.error) throw this.error;
    if (this.pending) { await this.pending; return this.flush(); }
    if (sameClipText(this.document.text, this.desired)) return this.document;
    if (this.document.draft.source !== "human" || this.document.draft.status !== "editing") throw new Error("此草稿为只读，不能写入");
    const text = this.desired;
    const previousRevision = this.document.documentRevision;
    const request = this.put(previousRevision, text);
    this.pending = request;
    try {
      const next = await request;
      if (next.documentId !== this.document.documentId || next.draft.id !== this.document.draft.id || next.draft.projectId !== this.document.draft.projectId || next.draft.clipId !== this.document.draft.clipId || next.draft.source !== "human" || next.draft.status !== "editing") throw new Error("草稿响应身份不一致，已停止写入");
      if (!sameClipText(next.text, text)) throw new Error("服务草稿回包与提交内容语义不一致，已保留本机输入并停止写入");
      this.document = next;
    } catch (error) { this.error = error instanceof Error ? error : new Error(String(error)); throw this.error; }
    finally { this.pending = null; }
    return this.flush();
  }
}

export function dependencyKey(edit: ClipEdit, assets: Asset[]) {
  return JSON.stringify([...new Set(edit.frames.map(f => f.imageId))].sort().map(id => [id, assets.find(a => a.id === id)?.revision || "missing"]));
}
export function dependencyConflicts(edit: ClipEdit, assets: Asset[], versions: Record<string, string>) {
  return [...new Set(edit.frames.map(frame => frame.imageId))].filter(id => !assets.some(asset => asset.id === id && asset.revision === versions[id]));
}
export type PreviewIdentity = { generation: number; documentRevision: string; text: string; dependencies: string };
export function samePreview(request: PreviewIdentity, current: PreviewIdentity) {
  return request.generation === current.generation && request.documentRevision === current.documentRevision && sameClipText(request.text, current.text) && request.dependencies === current.dependencies;
}
export function taskTargets(task: ProductionTask, assetId: string) {
  return task.target?.clipId === assetId || task.target?.assetId === assetId || task.contract.scope?.clipId === assetId;
}
export function editingBlock(tasks: ProductionTask[], assetId: string, handoffs: Record<string, number>) {
  return tasks.find(task => taskTargets(task, assetId) && !["accepted", "stopped", "failed"].includes(task.status) &&
    !(task.status === "paused" && handoffs[task.id] === task.barrierVersion));
}
export function contextFor(clip: ClipAsset, frameId?: string, document?: ClipDraftDocument): EditingContext {
  return { clipId: clip.id, revision: clip.revision, frameId,
    ...(document ? { mode: "draft" as const, draftId: document.draft.id, documentRevision: document.documentRevision, snapshotId: document.draft.baseSnapshotId } : { mode: "saved" as const }) };
}
export function shortcutAllowed(target: EventTarget | null): boolean {
  return !(typeof Element !== "undefined" && target instanceof Element && target.closest('input,textarea,select,button,a,[contenteditable="true"],[role="dialog"],dialog,.modal,.modal-backdrop,[role="separator"]'));
}
export function offsetByDrag(x: number, y: number, dx: number, dy: number, viewScale: number) {
  return { offsetX: Math.max(-4096, Math.min(4096, Math.round(x + dx / viewScale))), offsetY: Math.max(-4096, Math.min(4096, Math.round(y + dy / viewScale))) };
}
