import type { ClipAsset, Asset, Session, FrameDraft, FrameTransform } from "../studio/model.ts";
import { clipEditSchema, type ClipEdit, type ClipDraftDocument, type EditingContext, type ProductionTask, type ReviewSequenceDefinition } from "../studio/workflow-model.ts";

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
  get settled() {
    return !this.pending && !this.error && sameClipText(this.desired, this.document.text);
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
export function editingBlock(tasks: ProductionTask[], assetId: string, handoffs: Record<string, number>, sessions: Pick<Session, "id" | "status">[] = []) {
  return tasks.find(task => taskTargets(task, assetId) && !["accepted", "stopped", "failed"].includes(task.status) &&
    // Historical acceptance becoming stale is not a new Agent execution lease.
    !(task.phase === "delivery" && task.status === "blocked" && task.waitReason === "version_conflict" &&
      (task.acceptedSnapshotId || task.acceptanceHistory.length > 0) &&
      !sessions.some(session => session.id === task.sessionId && ["starting", "running"].includes(session.status))) &&
    !(task.status === "paused" && handoffs[task.id] === task.barrierVersion));
}
export function contextFor(clip: ClipAsset, frameId?: string, document?: ClipDraftDocument): EditingContext {
  return { clipId: clip.id, revision: clip.revision, frameId,
    ...(document ? { mode: "draft" as const, draftId: document.draft.id, documentRevision: document.documentRevision } : { mode: "saved" as const }) };
}
export type DirectionMaterial = { kind: "generated"; generatedId: string } | { kind: "asset"; assetId: string } | { kind: "snapshot"; snapshotId: string };
export function taskSaveApproval(task: ProductionTask, session?: Session) {
  if (!session || session.id !== task.sessionId || session.projectId !== task.projectId) return undefined;
  return session.toolApproval?.tool === "save_image" ? session.toolApproval : undefined;
}
/** Result identity is exclusive. Input references never supplement a generated result. */
export function directionMaterial(task: ProductionTask, session?: Session): DirectionMaterial | null {
  const attempt = task.attempts.at(-1);
  if (attempt && !["completed", "running", "unknown"].includes(attempt.status)) return null;
  // Unknown execution is not an absent artifact. Only its own retained image
  // can be reconciled explicitly; never fall back to a previous result/approval.
  if (attempt?.status === "unknown") return attempt.generatedId ? { kind: "generated", generatedId: attempt.generatedId } : null;
  const approval = taskSaveApproval(task, session);
  if (approval) return typeof approval.arguments.generatedId === "string" ? { kind: "generated", generatedId: approval.arguments.generatedId } : null;
  if (attempt?.generatedId) return { kind: "generated", generatedId: attempt.generatedId };
  if (attempt?.assetId) return { kind: "asset", assetId: attempt.assetId };
  if (task.attempts.length) return null;
  if (task.readySnapshotId || task.target?.snapshotId) return { kind: "snapshot", snapshotId: task.readySnapshotId || task.target!.snapshotId! };
  return task.target?.assetId ? { kind: "asset", assetId: task.target.assetId } : null;
}
export function directionPayload(task: ProductionTask, session: Session | undefined, accept: boolean, feedback: string) {
  const material = directionMaterial(task, session);
  if (!material) throw new Error("当前没有可确认的确切方向产物，请等待或刷新任务结果");
  const { kind, ...identity } = material;
  const approval = taskSaveApproval(task, session);
  if (!accept && !feedback.trim()) throw new Error("驳回方向需要意见");
  return { expectedRevision: task.revision, accept, ...(feedback.trim() ? { feedback: feedback.trim() } : {}), ...identity, ...(approval ? { toolApproval: { sessionId: session!.id, approvalId: approval.id } } : {}) };
}
export function taskFeedbackPayload(task: ProductionTask, action: "feedback" | "save-location", text: string, session?: Session, feedbackKind: "local" | "direction" = "local") {
  if (action === "feedback" && feedbackKind === "local" && !(task.direction?.accept && task.direction.intentVersion === task.intentVersion)) throw new Error("方向尚未认可，不能以局部调整保留方向");
  const approval = taskSaveApproval(task, session);
  return { expectedRevision: task.revision, action, text, ...(action === "feedback" ? { feedbackKind } : approval ? { toolApproval: { sessionId: session!.id, approvalId: approval.id } } : {}) };
}

export type TaskContinuation = "none" | "local" | "direction";
export function messageContinuation(task: ProductionTask | undefined, context: EditingContext | undefined, choice: TaskContinuation): "local" | "direction" | undefined {
  if (choice === "none") return undefined;
  const targetClipId = task?.target?.clipId || task?.contract.scope?.clipId;
  if (!task || !context?.clipId || context.clipId !== targetClipId) throw new Error("续接任务须明确使用同一动画的草稿或版本；浏览其他对象不改变任务目标");
  if (task.status === "paused") throw new Error("任务已暂停，请先明确继续任务，再续接当前版本");
  if (choice === "local" && !(task.direction?.accept && task.direction.intentVersion === task.intentVersion)) throw new Error("局部续接需要已有有效方向；新来源像素或方向变化请明确重新确认方向");
  return choice;
}

export type ConversationSelection = { taskId: string; sessionId: string };
export const taskConversation = (task: ProductionTask): ConversationSelection => ({ taskId: task.id, sessionId: task.sessionId || "" });
export function ordinaryConversation(tasks: ProductionTask[], sessionId: string): ConversationSelection {
  const task = sessionId ? tasks.find(task => task.sessionId === sessionId) : undefined;
  return { taskId: task?.id || "", sessionId };
}
export function assertConversation(tasks: ProductionTask[], selection: ConversationSelection) {
  if (!selection.taskId) return;
  const task = tasks.find(task => task.id === selection.taskId);
  if (!task || (task.sessionId && task.sessionId !== selection.sessionId)) throw new Error("任务与对话不匹配，请重新选择任务；消息和输入已保留");
}

export function conversationDestination(tasks: ProductionTask[], selection: ConversationSelection) {
  assertConversation(tasks, selection);
  return { sessionId: selection.sessionId, taskId: selection.taskId || undefined, needsSession: !selection.sessionId };
}

export function taskReviewContract(reviewSequenceId: string, definitions: ReviewSequenceDefinition[]) {
  if (!reviewSequenceId) return undefined;
  const definition = definitions.find(definition => definition.id === reviewSequenceId);
  if (!definition || definition.archived) throw new Error("必查Review不可用或已归档，请明确选择当前定义");
  return { reviewSequenceId: definition.id };
}
export type TaskCreationScope = "selection" | "frame" | "whole";
export function taskCreationTarget(context: EditingContext | undefined, scope: TaskCreationScope): EditingContext | undefined {
  if (!context) return undefined;
  if (!context.clipId) return { ...context };
  const { frameId, startFrameId, endFrameId, ...whole } = context;
  if (scope === "whole") return whole;
  if (scope === "frame") {
    if (!frameId) throw new Error("当前上下文没有帧实例，不能选择当前帧范围");
    return { ...whole, frameId };
  }
  if (startFrameId || endFrameId) return { ...whole, ...(startFrameId ? {startFrameId} : {}), ...(endFrameId ? {endFrameId} : {}) };
  return frameId ? { ...whole, frameId } : whole;
}
export function taskTargetSummary(target: EditingContext | undefined): string {
  if (!target) return "未指定目标，任务需要先明确范围";
  if (target.clipId) {
    if (target.startFrameId || target.endFrameId) return `当前区间：${target.startFrameId || "首帧"} → ${target.endFrameId || "末帧"}（不扩大为整个动画）`;
    if (target.frameId) return `当前帧实例：${target.frameId}（不是整个动画）`;
    return `整个当前动画：${target.clipId}（无帧/区间限定）`;
  }
  return target.assetId ? `当前图片：${target.assetId}` : `固定快照：${target.snapshotId || target.draftId}`;
}

export type ArchivableReviewDefinition = ReviewSequenceDefinition & { archived?: boolean };
export function assertReviewWritable(definition?: ArchivableReviewDefinition) {
  if (definition?.archived) throw new Error("Review 已归档，不能编辑保存或捕获新快照；历史检查与播放仍可访问");
}
export function reviewArchivePayload(definition: ArchivableReviewDefinition | undefined, expectedRevision: string, dirty: boolean, archived: boolean) {
  if (dirty) throw new Error("先保存或明确放弃未保存的定义修改，再归档/恢复；输入未改变");
  if (!definition || definition.revision !== expectedRevision) throw new Error("Review 定义版本已变化，请核对后重试；输入未改变");
  return { expectedRevision, archived };
}

export type ReviewIdentity = Pick<import("../studio/workflow-model.ts").ReviewSequenceSnapshot, "id" | "snapshotId" | "definitionId" | "projectId">;
export type ReviewInspection<T> = { selected: ReviewIdentity | null; epoch: number; evidence: T | null };
export type ReviewInspectionAction<T> = { type: "select"; snapshot: ReviewIdentity | null } | { type: "inspect"; epoch: number; evidence: T };
export function sameReviewIdentity(left: ReviewIdentity | null, right: ReviewIdentity) {
  return !!left && left.id === right.id && left.snapshotId === right.snapshotId && left.definitionId === right.definitionId && left.projectId === right.projectId;
}
export function reviewInspectionReducer<T extends { sequence: ReviewIdentity }>(state: ReviewInspection<T>, action: ReviewInspectionAction<T>): ReviewInspection<T> {
  if (action.type === "select") return { selected: action.snapshot, epoch: state.epoch + 1, evidence: null };
  return action.epoch === state.epoch && sameReviewIdentity(state.selected, action.evidence.sequence) ? { ...state, evidence: action.evidence } : state;
}

export function legacyDraftsFor(clipId: string, drafts: FrameDraft[]) { return drafts.filter(draft => draft.clipId === clipId); }
export function legacyDerivation(clip: ClipAsset, draft: FrameDraft) {
  if (draft.clipId !== clip.id || draft.source !== "human" || !["editing", "pending"].includes(draft.status)) throw new Error("只能从此动画的未保存人工旧草稿显式派生");
  return { clipId: clip.id, revision: clip.revision, source: "human" as const, fromDraftId: draft.id, expectedFromDocumentRevision: draft.documentRevision };
}
export function finishFrameDrag(edit: ClipEdit, selectedFrameId: string | undefined, frameId: string, transform: FrameTransform): ClipEdit | null {
  if (selectedFrameId !== frameId || !edit.frames.some(frame => frame.id === frameId)) return null;
  return { ...edit, frames: edit.frames.map(frame => frame.id === frameId ? { ...frame, transform } : frame) };
}

export function shortcutAllowed(target: EventTarget | null): boolean {
  return !(typeof Element !== "undefined" && target instanceof Element && target.closest('input,textarea,select,button,a,[contenteditable="true"],[role="dialog"],dialog,.modal,.modal-backdrop,[role="separator"]'));
}
export function offsetByDrag(x: number, y: number, dx: number, dy: number, viewScale: number) {
  return { offsetX: Math.max(-4096, Math.min(4096, Math.round(x + dx / viewScale))), offsetY: Math.max(-4096, Math.min(4096, Math.round(y + dy / viewScale))) };
}
