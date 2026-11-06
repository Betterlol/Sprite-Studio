import { randomUUID } from "node:crypto";
import { StudioError, type ProjectStore } from "./store.ts";
import { checkStaticQuality, unverifiedTemporalCheck, getQualityCapabilities, decideDelivery, decideRepair, type RepairRound } from "./quality.ts";
import type { QualityCheck, QualityScope } from "./workflow-model.ts";
import type { RenderWarning } from "./model.ts";
import { assertDraftSourceCurrent, freezeEditingContext } from "./workflow-context.ts";

/** Trusted renderer-backed checks. No model/HTTP observation can assert passed. */
export class WorkflowQuality {
  private store: ProjectStore;
  constructor(store: ProjectStore) { this.store = store; }
  capabilities() { return getQualityCapabilities(); }
  async inspect(pid: string, snapshotId: string, scope: QualityScope): Promise<QualityCheck[]> {
    const snapshot = this.store.animation.snapshot(pid, snapshotId);
    if (snapshot.clip.id !== scope.clipId) throw new StudioError("检查范围与快照不一致");
    const range = this.store.animation.range(snapshot, scope.startFrameId, scope.endFrameId);
    const warnings: RenderWarning[] = [];
    for (let i = range.start; i <= range.end; i++) {
      const frame = snapshot.clip.frames[i]!;
      // Preview rendering returns blocking overflow instead of silently truncating it
      // or throwing before the failed check can be recorded.
      const preview = this.store.animation.captureClip(pid, snapshot.clip, snapshot.images, true);
      const result = await this.store.animation.renderFrame(pid, preview.id, frame.id);
      if (result.bounds && result.overflow) warnings.push({ frameId: frame.id, frameNumber: i + 1, bounds: result.bounds, overflow: result.overflow, blocking: !!result.blocking });
    }
    const createdAt = new Date().toISOString();
    return [checkStaticQuality({ snapshot, scope, id: randomUUID(), createdAt, warnings }),
      unverifiedTemporalCheck({ id: randomUUID(), snapshotId, scope: { ...scope }, createdAt })];
  }
  async checkTask(pid: string, taskId: string, guard: () => void) {
    guard();
    const task = this.store.tasks.get(pid, taskId);
    assertDraftSourceCurrent(this.store, pid, task.target);
    if (!task.contract.scope) throw new StudioError("需要先绑定制作目标和检查范围", 409);
    const snapshot = this.store.animation.capture(pid, task.contract.scope.clipId);
    const draftIds = new Set((task.drafts || []).filter(draft => draft.intentVersion === task.intentVersion).map(draft => draft.draftId));
    for (const check of this.store.tasks.checksForIntent(pid, taskId)) if (check.draftId) draftIds.add(check.draftId);
    // Compatibility for pre-registry first-intent tasks. Never adopt an old
    // pointer into a later intent merely because the session still remembers it.
    const legacyPointer = task.sessionId ? this.store.sessions.get(task.sessionId)?.agentDraftId : undefined;
    if (!task.drafts && task.intentVersion === 1 && legacyPointer) {
      const document = this.store.documents.read(pid, legacyPointer);
      if (document.draft.createdAt >= task.createdAt) draftIds.add(legacyPointer);
    }
    for (const draftId of draftIds) {
      const document = this.store.documents.read(pid, draftId);
      if (document.draft.source !== "agent" || document.draft.sessionId !== task.sessionId || document.draft.clipId !== snapshot.clip.id) throw new StudioError("任务草稿关联的会话/目标不一致", 409);
      if (["editing", "pending"].includes(document.draft.status)) {
        if (document.draft.status === "pending") throw new StudioError(`任务仍有未保存的Agent草稿${draftId}等待决定`, 409);
        const previewContext = freezeEditingContext(this.store, pid, { mode: "draft", draftId, documentRevision: document.documentRevision });
        const preview = this.store.animation.snapshot(pid, previewContext.snapshotId!);
        if (JSON.stringify(preview.clip.frames) !== JSON.stringify(snapshot.clip.frames) || preview.clip.loop !== snapshot.clip.loop || (preview.clip.initialFps ?? 12) !== (snapshot.clip.initialFps ?? 12)) throw new StudioError(`任务仍有未保存的Agent对象草稿${draftId}；请先检查、保存或显式放弃，不能把旧saved版本当交付`, 409);
      }
    }
    const checks = await this.inspect(pid, snapshot.id, task.contract.scope);
    guard();
    assertDraftSourceCurrent(this.store, pid, task.target);
    // Rendering can overlap a manual edit; neither late checks nor readiness may
    // attach the old result to the new current version.
    if (this.store.animation.capture(pid, snapshot.clip.id).id !== snapshot.id) throw new StudioError("检查期间动画已变化", 409);
    let current = this.store.tasks.get(pid, taskId);
    const previous = this.store.tasks.checksForIntent(pid, taskId).findLast(c => c.kind === "static" && c.snapshotId !== snapshot.id && JSON.stringify(c.scope) === JSON.stringify(task.contract.scope));
    if (previous) {
      const issue = previous.findings.find(f => f.status === "failed" || f.status === "suspect");
      if (issue) {
        const issueId = `${issue.location || task.contract.scope.clipId}:${issue.message}`;
        const improved = !checks[0]!.findings.some(f => f.location === issue.location && f.message === issue.message && ["failed", "suspect"].includes(f.status));
        current = this.store.tasks.recordRepairRound(pid, taskId, { expectedRevision: current.revision, issueId, snapshotId: snapshot.id, improved });
      }
    }
    for (const check of checks) current = this.store.tasks.recordCheck(pid, taskId, { expectedRevision: current.revision, check });
    const decision = decideDelivery({ snapshotId: snapshot.id, checks: current.checks.filter(c => JSON.stringify(c.scope) === JSON.stringify(task.contract.scope)), requiredChecks: task.contract.requiredChecks });
    return { task: current, snapshot, checks, decision };
  }
  async checkDraft(pid: string, taskId: string, draftId: string, documentRevision: string, guard: () => void) {
    guard();
    const task = this.store.tasks.get(pid, taskId);
    if (!task.contract.scope) throw new StudioError("需要任务检查范围", 409);
    const context = freezeEditingContext(this.store, pid, { mode: "draft", draftId, documentRevision });
    const snapshot = this.store.animation.snapshot(pid, context.snapshotId!);
    const checks = (await this.inspect(pid, snapshot.id, task.contract.scope)).map(check => ({ ...check, draftId, documentRevision }));
    guard();
    // Re-resolve exact document after asynchronous rendering, not the base clip.
    if (freezeEditingContext(this.store, pid, context).snapshotId !== snapshot.id) throw new StudioError("草稿检查期间正文已改变", 409);
    let current = this.store.tasks.get(pid, taskId);
    const previous = this.store.tasks.checksForIntent(pid, taskId).findLast(check => check.kind === "static" && check.snapshotId !== snapshot.id && JSON.stringify(check.scope) === JSON.stringify(task.contract.scope));
    const issue = previous?.findings.find(finding => finding.status === "failed");
    if (issue) {
      const improved = !checks[0]!.findings.some(finding => finding.location === issue.location && finding.message === issue.message && finding.status === "failed");
      current = this.store.tasks.recordRepairRound(pid, taskId, { expectedRevision: current.revision, issueId: `${issue.location || task.contract.scope.clipId}:${issue.message}`, snapshotId: snapshot.id, improved }, context);
    }
    for (const check of checks) current = this.store.tasks.recordCheck(pid, taskId, { expectedRevision: current.revision, check }, context);
    return { task: current, snapshot, checks, repair: this.repair((current.repairRounds || []).filter(round => round.intentVersion === current.intentVersion), current.contract.repairLimit, checks[0]!.status === "failed") };
  }
  repair(rounds: RepairRound[], limit: number, actionable: boolean, capabilityAvailable = true) {
    return decideRepair({ rounds, limit, actionable, capabilityAvailable });
  }
}
