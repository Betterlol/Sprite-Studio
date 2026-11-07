import { sha256, StudioError, type ProjectStore } from "./store.ts";
import { existsSync, readFileSync } from "node:fs";
import { assertDraftSourceCurrent, freezeEditingContext } from "./workflow-context.ts";
import type { Session } from "./model.ts";
import type { PermissionTool } from "./tool-permissions.ts";

export type TaskIntent = { taskId: string; intentVersion: number; barrierVersion: number };
export function captureTaskIntent(store: ProjectStore, session: Session): TaskIntent | undefined {
  if (!session.taskId) return;
  const intent = session.workflowIntent;
  if (!intent || intent.taskId !== session.taskId) throw new StudioError("任务没有当前回合意图，请显式继续", 409);
  assertTaskIntent(store, session, intent);
  return structuredClone(intent);
}
export function assertTaskIntent(store: ProjectStore, session: Session, intent?: TaskIntent) {
  assertDraftSourceCurrent(store, session.projectId, session.editingContext);
  if (!intent) { if (session.taskId) throw new StudioError("旧普通回合不能操作新绑定任务", 409); return; }
  const task = store.tasks.get(session.projectId, intent.taskId);
  if (session.taskId !== intent.taskId || task.sessionId !== session.id || session.workflowIntent?.intentVersion !== intent.intentVersion || session.workflowIntent?.barrierVersion !== intent.barrierVersion || task.intentVersion !== intent.intentVersion || task.barrierVersion !== intent.barrierVersion || ["paused", "stopped", "blocked", "failed"].includes(task.status)) throw new StudioError("任务意图/屏障/会话已失效，排队操作未执行", 409);
  assertDraftSourceCurrent(store, session.projectId, task.target);
  assertDraftSourceCurrent(store, session.projectId, session.editingContext);
}
export function productionWrite(name: string, input: any) {
  return ["create_clip", "write_documents", "slice_sheet", "adjust_image", "save_frame_draft", "save_clip_draft"].includes(name) || (name === "review_sequence" && ["create", "update", "archive"].includes(input.action));
}
export function precheckTaskTool(store: ProjectStore, session: Session, intent: TaskIntent | undefined, name: string, input: any) {
  assertTaskIntent(store, session, intent);
  const pid = session.projectId;
  const contexts = [session.editingContext, intent ? store.tasks.get(pid, intent.taskId).target : undefined];
  const humanSources = contexts.flatMap(context => {
    if (context?.mode !== "draft" || !context.draftId) return [];
    const document = store.documents.read(pid, context.draftId);
    return document.draft.source === "human" ? [{ draftId: context.draftId, documentRevision: context.documentRevision }]
      : "deliveryTarget" in document.draft && document.draft.deliveryTarget ? [document.draft.deliveryTarget] : [];
  });
  if (humanSources.length) {
    // Evidence shared from a human draft is not formal publication permission,
    // even in an ordinary conversation or via a pre-existing legacy alias.
    const reject = () => { throw new StudioError("人工草稿协作必须使用完整助手结果草稿并显式采用；不能通过旧帧稿或正式配置绕过采用", 409); };
    if (["create_frame_draft", "save_frame_draft"].includes(name)) reject();
    if (name === "save_clip_draft") {
      const target = store.clipDrafts.read(pid, input.draftId).draft.deliveryTarget;
      if (!target || !humanSources.every(source => source.draftId === target.draftId && source.documentRevision === target.documentRevision)) reject();
    }
    if (name === "write_documents") for (const document of input.documents || []) {
      if (store.frameDrafts.has(document.documentId)) reject();
      if (!store.clipDrafts.has(pid, document.documentId) && store.asset(pid, document.documentId).type === "clip") reject();
    }
  }
  if (!intent) return;
  const task = store.tasks.get(pid, intent.taskId);
  if (["ready", "accepted"].includes(task.status) && (productionWrite(name, input) || ["save_image", "create_clip_draft", "create_frame_draft"].includes(name))) throw new StudioError("成果处于验收状态；通过任务消息/局部反馈继续制作", 409);
  if (productionWrite(name, input) && (task.phase !== "production" || task.status !== "running" || !store.tasks.directionCurrent(pid, task))) throw new StudioError("任务方向尚未通过，不能发布制作结果", 409);
  if (name === "save_image") {
    const generated = store.generated.record(pid, input.generatedId);
    if (generated.sessionId !== session.id || !task.attempts.some(a => a.generatedId === generated.id && (a.intentVersion === task.intentVersion || task.direction?.generatedId === generated.id))) throw new StudioError("生成产物不是当前任务会话的attempt", 409);
    if (task.phase === "production" && (!store.tasks.directionCurrent(pid, task) || (task.direction?.generatedId && task.direction.generatedId !== generated.id))) throw new StudioError("该生成产物尚未获得任务方向认可", 409);
  }
  const goal = task.contract.scope?.clipId || task.target?.clipId;
  if (name === "create_clip" && goal) {
    const receipt = store.safePath(pid, `.studio/clip-requests/${input.requestId}.json`);
    if (!existsSync(receipt) || JSON.parse(readFileSync(receipt, "utf8")).id !== goal) throw new StudioError("任务已经绑定动画，不能新建无关目标", 409);
  }
  const checkClip = (clipId: string) => { if (goal && clipId !== goal) throw new StudioError("工具目标不在制作任务范围", 409); };
  const checkBodyScope = (text: string, legacy = false) => {
    const scope = task.contract.scope;
    if (!scope || (!scope.startFrameId && !scope.endFrameId)) return;
    const baseline = task.target?.snapshotId ? store.animation.snapshot(pid, task.target.snapshotId) : store.animation.capture(pid, scope.clipId);
    const range = store.animation.range(baseline, scope.startFrameId, scope.endFrameId), value = JSON.parse(text);
    if (legacy) {
      const allowed = new Set(baseline.clip.frames.slice(range.start, range.end + 1).map(f => f.id));
      for (const edit of value.frames) {
        const old = baseline.clip.frames.find(f => f.id === edit.frameId);
        if (!allowed.has(edit.frameId) && old && (edit.durationUs !== old.durationUs || JSON.stringify(edit.transform) !== JSON.stringify(old.transform || { scale: 1, offsetX: 0, offsetY: 0, clip: false }))) throw new StudioError("修改超出任务约定帧区间", 409);
      }
      return;
    }
    const before = baseline.clip.frames.slice(0, range.start), after = baseline.clip.frames.slice(range.end + 1);
    if (JSON.stringify(value.frames.slice(0, before.length)) !== JSON.stringify(before) || JSON.stringify(after.length ? value.frames.slice(-after.length) : []) !== JSON.stringify(after) || (scope.startFrameId && !value.frames.some((f: { id: string }) => f.id === scope.startFrameId)) || (scope.endFrameId && !value.frames.some((f: { id: string }) => f.id === scope.endFrameId)) || value.loop !== baseline.clip.loop || (value.initialFps ?? 12) !== (baseline.clip.initialFps ?? 12)) throw new StudioError("修改超出任务约定帧区间或删除了边界", 409);
  };
  const imageAllowed = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false; seen.add(id);
    const roots = [task.target?.assetId, task.direction?.assetId, ...task.referenceIds, ...task.contract.roleReferenceIds, ...task.attempts.map(a => a.assetId)];
    if (roots.includes(id) || (goal && store.animation.clip(pid, goal).frames.some(f => f.imageId === id)) || (task.direction?.generatedId && store.generated.record(pid, task.direction.generatedId).assetIds.includes(id))) return true;
    const image = store.image(pid, id), parent = image.producer?.sheetId || image.origin?.assetId;
    return !!parent && imageAllowed(parent, seen);
  };
  if (["create_clip_draft", "create_frame_draft"].includes(name)) {
    checkClip(input.clipId);
    if (!goal) throw new StudioError("请先通过create_clip绑定任务动画目标", 409);
    if (task.target?.mode === "draft" && name === "create_frame_draft") throw new StudioError("完整草稿任务必须显式派生对象草稿，不能丢失人工编排", 409);
    if (task.target?.mode === "draft" && input.fromDraftId !== task.target.draftId) throw new StudioError("请从任务冻结的人工草稿显式派生", 409);
  }
  if (["save_clip_draft", "save_frame_draft"].includes(name)) {
    const draft = name === "save_clip_draft" ? store.clipDrafts.read(pid, input.draftId).draft : store.frameDrafts.get(pid, input.draftId);
    checkClip(draft.clipId);
    if (draft.sessionId !== session.id || draft.source !== "agent") throw new StudioError("不能提交人工或其他会话草稿", 409);
    checkBodyScope(name === "save_clip_draft" ? store.clipDrafts.read(pid, input.draftId).text : store.frameDrafts.read(pid, input.draftId).text, name === "save_frame_draft");
  }
  if (name === "write_documents") for (const doc of input.documents || []) {
    if (store.clipDrafts.has(pid, doc.documentId)) {
      const draft = store.clipDrafts.read(pid, doc.documentId).draft; checkClip(draft.clipId);
      if (draft.sessionId !== session.id || draft.source !== "agent") throw new StudioError("请显式派生会话草稿，不能修改人工正文", 409);
      checkBodyScope(doc.text);
    } else if (store.frameDrafts.has(doc.documentId)) {
      const draft = store.frameDrafts.get(pid, doc.documentId); checkClip(draft.clipId);
      if (draft.sessionId !== session.id) throw new StudioError("草稿不属于当前会话", 409);
      checkBodyScope(doc.text, true);
    } else {
      const asset = store.asset(pid, doc.documentId);
      if (asset.type === "clip") { checkClip(asset.id); throw new StudioError("制作任务请使用完整对象草稿，不直接覆盖动画配置", 409); }
      if (!imageAllowed(asset.id)) throw new StudioError("切割来源不在任务约定范围", 409);
    }
  }
  if (["slice_sheet", "adjust_image", "inspect_sheet"].includes(name) && !imageAllowed(input.assetId)) throw new StudioError("图片不在任务约定范围", 409);
  if (productionWrite(name, input) && name !== "review_sequence") {
    const rounds = (task.repairRounds || []).filter(r => r.intentVersion === task.intentVersion);
    const currentSnapshotId = goal ? store.animation.capture(pid, goal).id : undefined;
    const hasCurrentFailure = task.checks.some(c => c.snapshotId === currentSnapshotId && c.status === "failed");
    const decision = store.quality.repair(rounds, task.contract.repairLimit, rounds.length > 0 || hasCurrentFailure);
    // Publishing an already checked exact body is not an additional repair.
    // Never exempt a modified document just because the tool is called save.
    let checkedPublication = false;
    if (decision.stop && ["save_clip_draft", "save_frame_draft"].includes(name)) {
      const document = store.documents.read(pid, input.draftId);
      if (document.documentRevision === input.documentRevision) {
        let snapshotId: string;
        if (name === "save_frame_draft" && document.draft.status === "pending") {
          // Pending legacy approvals are readonly but still the exact checked
          // body. Do not relax the public context resolver to accept them.
          const draft = store.frameDrafts.check(pid, input.draftId, input.documentRevision);
          const base = store.animation.snapshot(pid, draft.baseSnapshotId);
          const edits = new Map(store.frameDrafts.edits(pid, draft).map(frame => [frame.frameId, frame]));
          snapshotId = store.animation.captureClip(pid, { ...base.clip, revision: sha256(JSON.stringify([base.id, input.documentRevision])), frames: base.clip.frames.map(frame => { const edit = edits.get(frame.id); return edit ? { ...frame, transform: edit.transform, durationUs: edit.durationUs } : frame; }) }, base.images, true).id;
        } else snapshotId = freezeEditingContext(store, pid, { mode: "draft", draftId: input.draftId, documentRevision: input.documentRevision }).snapshotId!;
        const check = store.tasks.checksForIntent(pid, task.id).findLast(c => c.kind === "static" && c.draftId === input.draftId && c.documentRevision === input.documentRevision && JSON.stringify(c.scope) === JSON.stringify(task.contract.scope));
        const last = rounds.at(-1);
        const authorizedRound = rounds.length <= task.contract.repairLimit && !store.quality.repair(rounds.slice(0, -1), task.contract.repairLimit, true).stop;
        checkedPublication = authorizedRound && !!check && ["passed", "suspect"].includes(check.status) && !check.findings.some(f => f.status === "failed" || f.status === "unverified") && !!last?.improved && last.snapshotId === check.snapshotId && snapshotId === check.snapshotId;
      }
    }
    if (decision.stop && decision.reason !== "nothing-actionable" && !checkedPublication) throw new StudioError(`修复已停止：${decision.reason}，需要人工接手`, 409);
  }
}

/** New capabilities inherit existing denials/asks instead of becoming alternate routes. */
export function toolPolicyParents(name: PermissionTool, input: any): PermissionTool[] {
  if (name === "inspect_sheet") return ["read_document", "inspect_clip"];
  if (name === "create_clip_draft") return ["create_frame_draft"];
  if (name === "save_clip_draft") return ["save_frame_draft"];
  if (name === "review_sequence") return [input.action === "list" ? "list_assets" : ["create", "update", "archive"].includes(input.action) ? "write_documents" : "inspect_clip"];
  if (name === "workflow_task") return [input.action === "status" ? "list_assets" : "inspect_clip"];
  return [];
}
