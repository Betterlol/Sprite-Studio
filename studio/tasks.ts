import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { atomicJson, sha256, StudioError, type ProjectStore } from "./store.ts";
import { freezeEditingContext, assertDraftSourceCurrent } from "./workflow-context.ts";
import { decideDelivery } from "./quality.ts";
import { editingContextSchema, productionContractSchema, qualityScopeSchema, type ProductionTask, type EditingContext, type GenerationAttempt, type QualityCheck, type DirectionDecision } from "./workflow-model.ts";

const uuid = z.string().uuid();
const createSchema = z.object({ requestId: uuid, title: z.string().trim().min(1).max(200), description: z.string().max(10000), target: editingContextSchema.optional(), referenceIds: z.array(uuid).default([]), contract: productionContractSchema.default(() => productionContractSchema.parse({})), sessionId: uuid.optional() }).strict();
export type CreateTaskInput = z.input<typeof createSchema>;
export type TaskAction = { expectedRevision: number; action: "pause" | "resume" | "stop" | "handoff" | "feedback" | "save-location" | "ready" | "accept"; text?: string; snapshotId?: string; feedbackKind?: "local" | "direction" };
export type DirectionInput = { expectedRevision: number; accept: boolean; feedback?: string; generatedId?: string; assetId?: string; snapshotId?: string; contentHash?: string };
export type AttemptInput = { expectedRevision: number; id: string; status: GenerationAttempt["status"]; generatedId?: string; assetId?: string; contentHash?: string; reason?: string };
export type CheckInput = { expectedRevision: number; check: QualityCheck };
type StoredTask = ProductionTask & { checkIntentVersions?: Record<string, number> };
const now = () => new Date().toISOString();
const fail = (message: string): never => { throw new StudioError(message, 409); };

export class ProductionTasks {
  readonly store: ProjectStore;
  constructor(store: ProjectStore) {
    this.store = store;
    for (const pid of store.projects.keys()) {
      for (const task of this.rawList(pid)) {
        if (task.status === "running" || (task.status === "waiting" && task.waitReason === "tool_approval") || task.attempts.some(a => a.status === "running" || a.status === "reserved")) {
          task.status = "paused"; task.waitReason = undefined; task.error = "interrupted：工作台已重启，未自动恢复或批准工具";
          task.barrierVersion++; task.revision++;
          for (const a of task.attempts) if (a.status === "running" || a.status === "reserved") { a.status = "unknown"; a.reason = "重启后结果未知，不能自动重发"; a.updatedAt = now(); }
          this.persist(task);
        }
      }
    }
  }
  private path(pid: string, id: string) { uuid.parse(id); return this.store.safePath(pid, `.studio/tasks/${id}.json`); }
  private raw(pid: string, id: string): StoredTask {
    const file = this.path(pid, id);
    if (!existsSync(file)) throw new StudioError("制作任务不存在", 404);
    const task = JSON.parse(readFileSync(file, "utf8")) as StoredTask;
    if (task.id !== id || task.projectId !== pid) throw new StudioError("制作任务不存在", 404);
    return task;
  }
  private rawList(pid: string): StoredTask[] {
    const folder = this.store.safePath(pid, ".studio/tasks");
    if (!existsSync(folder)) return [];
    return readdirSync(folder).filter(f => /^[0-9a-f-]{36}\.json$/i.test(f)).map(f => this.raw(pid, f.slice(0, -5)));
  }
  private persist(task: ProductionTask) {
    task.updatedAt = now(); const file = this.path(task.projectId, task.id);
    mkdirSync(dirname(file), { recursive: true }); atomicJson(file, task); this.store.changed(task.projectId); return structuredClone(task);
  }
  private validateTarget(pid: string, target?: ProductionTask["target"]) {
    return target ? freezeEditingContext(this.store, pid, target) : undefined;
  }
  private scope(pid: string, scope: ProductionTask["contract"]["scope"], snapshotId?: string) {
    if (!scope) fail("需要明确检查范围");
    const snap = snapshotId ? this.store.animation.snapshot(pid, snapshotId) : undefined;
    const clip = snap ? snap.clip : this.store.animation.clip(pid, scope!.clipId);
    if (clip.id !== scope!.clipId) fail("检查范围与快照不匹配");
    if (!clip.frames.length && !scope!.startFrameId && !scope!.endFrameId) return;
    const start = scope!.startFrameId ? clip.frames.findIndex(f => f.id === scope!.startFrameId) : 0;
    const end = scope!.endFrameId ? clip.frames.findIndex(f => f.id === scope!.endFrameId) : clip.frames.length - 1;
    if (start < 0 || end < start) fail("检查范围无效");
  }
  private currentSnapshot(pid: string, task: ProductionTask, sid: string) {
    const snap = this.store.animation.snapshot(pid, sid);
    if (snap.renderMode || !snap.clip.frames.length || !task.contract.scope || snap.clip.id !== task.contract.scope.clipId) fail("快照不是任务目标的非空已保存动画");
    this.scope(pid, task.contract.scope, sid);
    if (this.store.animation.capture(pid, snap.clip.id).id !== sid) fail("快照不再是当前动画版本");
    return snap;
  }
  directionCurrent(pid: string, task: ProductionTask) {
    const d = task.direction;
    if (!d?.accept || d.intentVersion !== task.intentVersion) return false;
    try {
      assertDraftSourceCurrent(this.store, pid, task.target);
      if (d.generatedId && sha256(readFileSync(this.store.generated.imagePath(pid, d.generatedId))) !== d.contentHash) return false;
      if (d.assetId && sha256(readFileSync(this.store.imagePath(pid, d.assetId))) !== d.contentHash) return false;
      if (d.snapshotId) {
        const s = this.store.animation.snapshot(pid, d.snapshotId);
        // Direction approves frozen source material, not future arrangement edits.
        // Readiness independently requires the exact CURRENT delivery snapshot.
        if (sha256(JSON.stringify([s.clip.frames, s.images, s.clip.loop])) !== d.contentHash) return false;
        for (const f of s.clip.frames) this.store.animation.imagePath(pid, s.id, f.id);
      }
      return true;
    } catch { return false; }
  }
  private view(task: ProductionTask) {
    if (["ready", "accepted"].includes(task.status)) {
      try { this.currentSnapshot(task.projectId, task, task.readySnapshotId!); if (!this.directionCurrent(task.projectId, task)) throw new Error(); }
      catch { return { ...task, status: "blocked" as const, waitReason: "version_conflict" as const, error: "当前成果已变化，历史验收保留但结论已过期" }; }
    }
    return task;
  }
  list(pid: string): ProductionTask[] { return this.rawList(pid).map(t => this.view(t)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  get(pid: string, id: string): ProductionTask { return this.view(this.raw(pid, id)); }
  wasAccepted(pid: string, id: string) { return this.raw(pid, id).status === "accepted"; }
  protectsSession(pid: string, sessionId: string) { return this.rawList(pid).some(task => task.sessionId === sessionId && !["accepted", "stopped"].includes(task.status)); }
  create(pid: string, input: CreateTaskInput): ProductionTask {
    this.store.project(pid); const spec = createSchema.parse(input), hash = sha256(JSON.stringify(spec));
    const old = this.rawList(pid).find(t => t.requestId === spec.requestId);
    if (old) { if (old.requestHash !== hash) fail("同一请求不能更换任务意图"); return this.view(old); }
    if (spec.contract.scope && spec.target?.draftId) {
      const draft = this.store.clipDrafts.has(pid, spec.target.draftId) ? this.store.clipDrafts.read(pid, spec.target.draftId).draft : this.store.frameDrafts.get(pid, spec.target.draftId);
      if (draft.clipId !== spec.contract.scope.clipId) fail("任务目标与范围不一致");
    }
    const target = this.validateTarget(pid, spec.target);
    for (const id of [...spec.referenceIds, ...spec.contract.roleReferenceIds]) this.store.imagePath(pid, id);
    if (spec.contract.reviewSequenceId) this.store.reviewSequences.get(pid, spec.contract.reviewSequenceId);
    if (spec.contract.scope) { this.scope(pid, spec.contract.scope); if ((target?.clipId && target.clipId !== spec.contract.scope.clipId) || (target?.assetId && target.assetId !== spec.contract.scope.clipId)) fail("任务目标与范围不一致"); }
    else if (target?.clipId) spec.contract.scope = { clipId: target.clipId, ...(target.startFrameId ? { startFrameId: target.startFrameId } : {}), ...(target.endFrameId ? { endFrameId: target.endFrameId } : {}) };
    if (spec.sessionId && this.store.session(spec.sessionId).projectId !== pid) fail("会话不属于该工程");
    const timestamp = now();
    return this.persist({ id: randomUUID(), projectId: pid, requestId: spec.requestId, requestHash: hash, revision: 1, intentVersion: 1, barrierVersion: 1, title: spec.title, description: spec.description, target, referenceIds: spec.referenceIds, contract: spec.contract, sessionId: spec.sessionId, phase: "direction", status: "waiting", waitReason: "direction", attempts: [], checks: [], findings: [], directionHistory: [], acceptanceHistory: [], createdAt: timestamp, updatedAt: timestamp });
  }
  private edit(pid: string, id: string, revision: number) {
    const task = this.raw(pid, id); if (!Number.isInteger(revision) || task.revision !== revision) fail("VERSION_CONFLICT：任务已变化"); return task;
  }
  private save(task: ProductionTask) { task.revision++; return this.persist(task); }
  private interruptAttempts(task: ProductionTask) {
    for (const attempt of task.attempts) if (attempt.status === "reserved" || attempt.status === "running") {
      attempt.status = "unknown"; attempt.reason = "版本屏障后生成结果未知，不能自动重发"; attempt.updatedAt = now();
    }
  }
  action(pid: string, id: string, input: TaskAction, sourceContext?: EditingContext): ProductionTask {
    const spec = z.object({ expectedRevision: z.number().int().positive(), action: z.enum(["pause","resume","stop","handoff","feedback","save-location","ready","accept"]), text: z.string().trim().min(1).optional(), snapshotId: uuid.optional(), feedbackKind: z.enum(["local", "direction"]).optional() }).strict().parse(input);
    const t = this.edit(pid, id, spec.expectedRevision);
    if (t.status === "stopped") fail("任务已停止");
    if (sourceContext) {
      if (spec.action !== "feedback" || !spec.feedbackKind) fail("来源续接需要明确反馈类型");
      const frozen = freezeEditingContext(this.store, pid, sourceContext), goal = t.contract.scope?.clipId || t.target?.clipId;
      if (!goal || frozen.clipId !== goal) fail("上下文不能改绑任务目标");
      this.scope(pid, t.contract.scope, frozen.snapshotId);
      if (spec.feedbackKind === "local" && t.target?.snapshotId && frozen.snapshotId) {
        const before = this.store.animation.snapshot(pid, t.target.snapshotId), after = this.store.animation.snapshot(pid, frozen.snapshotId);
        const approvedPixels = new Set(Object.values(before.images).map(image => image.contentHash));
        if (Object.values(after.images).some(image => !approvedPixels.has(image.contentHash))) fail("来源像素已改变，需要direction反馈而非local续接");
      }
      t.target = frozen;
    }
    if (["pause", "handoff", "stop", "feedback"].includes(spec.action)) this.interruptAttempts(t);
    switch (spec.action) {
      case "pause": case "handoff": t.barrierVersion++; t.status = "paused"; t.waitReason = undefined; t.error = spec.action === "handoff" ? "人工接手" : "已暂停"; break;
      case "stop": t.barrierVersion++; t.status = "stopped"; t.waitReason = undefined; break;
      case "feedback": {
        if (!spec.text) fail("反馈不能为空");
        const local = spec.feedbackKind === "local";
        if (local && !this.directionCurrent(pid, t)) fail("局部反馈需要已有有效方向");
        t.description += `\n${spec.text}`; t.intentVersion++; t.barrierVersion++; t.readySnapshotId = undefined;
        if (local) { t.direction = { ...t.direction!, intentVersion: t.intentVersion }; t.phase = "production"; if (t.status !== "paused") { t.status = "running"; t.waitReason = undefined; } }
        else { t.direction = undefined; t.phase = "direction"; if (t.status !== "paused") { t.status = "waiting"; t.waitReason = "direction"; } }
        break;
      }
      case "save-location": if (!spec.text) fail("位置反馈不能为空"); t.description += `\n保存位置反馈（不改变方向或生成额度）：${spec.text}`; break;
      case "resume": if (!["paused", "blocked", "waiting"].includes(this.view(t).status)) fail("当前状态不能继续"); if (!this.directionCurrent(pid, t)) { t.phase = "direction"; t.status = "waiting"; t.waitReason = "direction"; } else { t.phase = "production"; t.status = "running"; t.waitReason = undefined; } t.readySnapshotId = undefined; t.error = undefined; break;
      case "ready": {
        if (t.status !== "running" || t.phase !== "production") fail("请先显式恢复制作，再进入验收");
        if (!spec.snapshotId) fail("需要确切快照"); this.currentSnapshot(pid, t, spec.snapshotId!);
        if (!this.directionCurrent(pid, t)) fail("方向未通过或已过期");
        const checks = t.checks.filter(c => t.checkIntentVersions?.[c.id] === t.intentVersion && c.snapshotId === spec.snapshotId && JSON.stringify(c.scope) === JSON.stringify(t.contract.scope));
        if (t.contract.requiredChecks.some(k => !checks.some(c => c.kind === k))) fail("检查范围不完整");
        if (t.checks.filter(c => c.snapshotId === spec.snapshotId).some(c => c.status === "failed" || c.findings.some(f => f.status === "failed" && f.resolution !== "resolved"))) fail("已知检查失败不能标为可验收");
        const delivery = decideDelivery({ snapshotId: spec.snapshotId!, checks, requiredChecks: t.contract.requiredChecks });
        if (delivery.status !== "ready") fail(delivery.reasons.join("；"));
        t.readySnapshotId = spec.snapshotId; t.phase = "delivery"; t.status = "ready"; t.waitReason = undefined; t.error = undefined; break;
      }
      case "accept": if (t.status !== "ready" || !spec.snapshotId || spec.snapshotId !== t.readySnapshotId) fail("只能接受确切的可验收快照"); this.currentSnapshot(pid, t, spec.snapshotId!); if (!this.directionCurrent(pid, t)) fail("方向已过期"); t.acceptedSnapshotId = spec.snapshotId; t.acceptanceHistory.push({ snapshotId: spec.snapshotId!, intentVersion: t.intentVersion, createdAt: now() }); t.status = "accepted"; break;
    }
    return this.save(t);
  }
  decideDirection(pid: string, id: string, input: DirectionInput, validateOnly = false): ProductionTask {
    const v = z.object({ expectedRevision: z.number().int().positive(), accept: z.boolean(), feedback: z.string().trim().min(1).optional(), generatedId: uuid.optional(), assetId: uuid.optional(), snapshotId: uuid.optional(), contentHash: z.string().optional() }).strict().parse(input);
    const t = this.edit(pid,id,v.expectedRevision); if (t.status !== "waiting" || t.phase !== "direction" || t.waitReason !== "direction") fail("请先显式恢复并进入方向等待状态");
    if (!v.accept && !v.feedback) fail("驳回方向需要意见");
    if (![v.generatedId, v.assetId, v.snapshotId].some(Boolean) || (v.snapshotId && (v.generatedId || v.assetId))) fail("方向需要确切产物或快照");
    let hash: string | undefined;
    if (v.generatedId) { const record = this.store.generated.record(pid, v.generatedId); if (record.projectId !== pid || (t.sessionId && record.sessionId !== t.sessionId)) fail("生成产物不属于任务会话"); if (!t.attempts.some(a => a.generatedId === v.generatedId && a.intentVersion === t.intentVersion && ["completed", "unknown"].includes(a.status))) fail("生成产物不是当前任务意图的真实attempt"); hash = sha256(readFileSync(this.store.generated.imagePath(pid,v.generatedId))); }
    if (v.assetId) { const actual = sha256(readFileSync(this.store.imagePath(pid,v.assetId))); if (hash && actual !== hash) fail("生成产物与资源像素不一致"); hash = actual; }
    if (v.snapshotId) {
      const snap = this.store.animation.snapshot(pid, v.snapshotId);
      if (t.target?.snapshotId !== snap.id) fail("方向快照不是任务冻结的来源");
      if (!snap.clip.frames.length) fail("方向快照没有真实帧，请使用确切参考图或生成产物");
      hash = sha256(JSON.stringify([snap.clip.frames, snap.images, snap.clip.loop]));
      for (const frame of snap.clip.frames) this.store.animation.imagePath(pid, snap.id, frame.id);
    }
    if (v.contentHash && v.contentHash !== hash) fail("产物摘要与实际内容不一致");
    if (validateOnly) return structuredClone(t);
    const decision: DirectionDecision = { accept: v.accept, feedback: v.feedback, generatedId: v.generatedId, assetId: v.assetId, snapshotId: v.snapshotId, contentHash: hash!, intentVersion: t.intentVersion, createdAt: now() };
    t.directionHistory.push(decision); t.direction = decision; t.readySnapshotId = undefined;
    if (v.accept) { t.phase = "production"; t.status = "running"; t.waitReason = undefined; }
    else { this.interruptAttempts(t); t.intentVersion++; t.barrierVersion++; t.phase = "direction"; t.status = "waiting"; t.waitReason = "direction"; }
    return this.save(t);
  }
  pauseForRuntime(pid: string, id: string, reason: string, capability = false) {
    const task = this.raw(pid, id);
    if (["paused", "stopped", "ready", "accepted"].includes(task.status)) return this.view(task);
    this.interruptAttempts(task); task.barrierVersion++;
    task.status = capability ? "blocked" : "paused"; task.waitReason = capability ? "capability" : undefined; task.error = reason;
    return this.save(task);
  }
  bindSession(pid: string, id: string, sessionId: string): ProductionTask {
    const t = this.raw(pid, id);
    if (this.store.session(sessionId).projectId !== pid || (t.sessionId && t.sessionId !== sessionId)) fail("任务不属于该会话");
    if (t.sessionId === sessionId) return this.view(t);
    if (this.rawList(pid).some(other => other.id !== id && other.sessionId === sessionId && !["stopped", "accepted"].includes(other.status))) fail("会话已绑定另一制作任务");
    t.sessionId = sessionId; return this.save(t);
  }
  /** Only a receipt produced by this task's create_clip tool can bind a new goal. */
  bindProducedClip(pid: string, id: string, input: { expectedRevision: number; sessionId: string; requestId: string; clipId: string; intentVersion: number; barrierVersion: number }): ProductionTask {
    const t = this.edit(pid, id, input.expectedRevision);
    if (t.sessionId !== input.sessionId || t.intentVersion !== input.intentVersion || t.barrierVersion !== input.barrierVersion || t.status !== "running" || !this.directionCurrent(pid, t)) fail("任务制作意图已失效");
    const receipt = JSON.parse(readFileSync(this.store.safePath(pid, `.studio/clip-requests/${uuid.parse(input.requestId)}.json`), "utf8"));
    if (receipt.id !== input.clipId || receipt.provenance?.taskId !== id || receipt.provenance?.sessionId !== input.sessionId || receipt.provenance?.intentVersion !== input.intentVersion || receipt.provenance?.barrierVersion !== input.barrierVersion) fail("创建回执不属于当前任务产出");
    if (t.contract.scope && t.contract.scope.clipId !== input.clipId) fail("任务已有其他动画目标，不能自动改绑");
    const clip = this.store.animation.clip(pid, input.clipId);
    if (t.contract.scope?.clipId === clip.id) return this.view(t);
    t.target = { mode: "saved", clipId: clip.id, revision: clip.revision, snapshotId: this.store.animation.capture(pid, clip.id).id };
    t.contract.scope = { clipId: clip.id };
    return this.save(t);
  }
  /** Runtime notifications are an audit trail, NEVER authorization or a hard cap. */
  observeGeneration(pid: string, id: string, input: { sessionId: string; intentVersion: number; barrierVersion: number; runtimeItemId: string; generatedId?: string; failed?: boolean; referenceHashes?: string[] }): ProductionTask {
    const t = this.raw(pid, id);
    if (t.sessionId !== input.sessionId) fail("生成事件不属于任务会话");
    let a = t.attempts.find(a => a.runtimeItemId === input.runtimeItemId);
    const current = t.intentVersion === input.intentVersion && t.barrierVersion === input.barrierVersion && !["paused", "stopped", "failed"].includes(t.status);
    if (!a) {
      a = { id: randomUUID(), runtimeItemId: input.runtimeItemId, intentVersion: input.intentVersion, status: current ? "running" : "unknown", createdAt: now(), updatedAt: now(), preflightVerified: false, unattendedAllowed: false };
      t.attempts.push(a);
    }
    if (input.generatedId) {
      const generated = this.store.generated.record(pid, input.generatedId);
      if (generated.sessionId !== input.sessionId) fail("生成产物不属于会话");
      a.generatedId = input.generatedId; a.contentHash = sha256(readFileSync(this.store.generated.imagePath(pid, input.generatedId)));
      const expectedHashes = [...new Set(input.referenceHashes || [])], receivedHashes = generated.inputImages.map(i => i.sha256);
      a.referenceEvidence = { expectedHashes, receivedHashes, verified: expectedHashes.length > 0 && expectedHashes.every(hash => receivedHashes.includes(hash)) };
      if (current && a.status !== "unknown") a.status = "completed";
    } else if (input.failed && current && a.status !== "unknown") a.status = "failed";
    if (!current) a.status = "unknown";
    a.reason = "运行时事件留存；没有调用前硬预算证明，不允许自动重发"; a.updatedAt = now();
    return this.save(t);
  }
  recordSavedImage(pid: string, id: string, input: { sessionId: string; intentVersion: number; barrierVersion: number; generatedId: string; assetId: string }) {
    const task = this.raw(pid, id), generated = this.store.generated.record(pid, input.generatedId), asset = this.store.image(pid, input.assetId);
    if (task.sessionId !== input.sessionId || task.intentVersion !== input.intentVersion || task.barrierVersion !== input.barrierVersion || !generated.assetIds.includes(asset.id) || asset.contentHash !== generated.contentHash) fail("保存回执不属于当前任务产物");
    const attempt = task.attempts.find(attempt => attempt.generatedId === generated.id);
    if (!attempt) fail("保存产物缺少真实attempt");
    if (attempt!.assetId === asset.id) return this.view(task);
    attempt!.assetId = asset.id; return this.save(task);
  }
  recordAttempt(pid: string, id: string, input: AttemptInput): ProductionTask {
    const v = z.object({ expectedRevision: z.number().int().positive(), id: uuid, status: z.enum(["reserved","running","completed","failed","cancelled","unknown"]), generatedId: uuid.optional(), assetId: uuid.optional(), contentHash: z.string().optional(), reason: z.string().optional() }).strict().parse(input);
    const t = this.edit(pid,id,v.expectedRevision); if (t.status === "stopped") fail("任务已停止");
    const old = t.attempts.find(a => a.id === v.id);
    if (old && old.status === v.status && old.generatedId === v.generatedId && old.assetId === v.assetId && (v.contentHash === undefined || old.contentHash === v.contentHash) && old.reason === v.reason) return t;
    if (!old && v.status !== "reserved") fail("生成必须先记录请求");
    if (!old && (t.attempts.length >= t.contract.generationLimit || t.attempts.some(a => a.status === "unknown"))) fail("生成额度已用完或存在未知请求，不能自动重发");
    if (old && (old.intentVersion !== t.intentVersion || !({ reserved: ["running","cancelled","unknown"], running: ["completed","failed","cancelled","unknown"], completed: [], failed: [], cancelled: [], unknown: [] } as Record<string,string[]>)[old.status]!.includes(v.status))) fail("生成请求状态不能转换或意图已变化");
    let hash: string | undefined;
    if (v.generatedId) hash = sha256(readFileSync(this.store.generated.imagePath(pid,v.generatedId)));
    if (v.assetId) { const h = sha256(readFileSync(this.store.imagePath(pid,v.assetId))); if (hash && hash !== h) fail("产物像素不一致"); hash = h; }
    if (v.contentHash && hash !== v.contentHash) fail("产物摘要不匹配");
    if (v.status === "completed" && !hash) fail("完成的请求需要真实产物");
    const a: GenerationAttempt = { id: v.id, intentVersion: old?.intentVersion ?? t.intentVersion, status: v.status, generatedId: v.generatedId, assetId: v.assetId, contentHash: hash, reason: v.reason, createdAt: old?.createdAt ?? now(), updatedAt: now(), preflightVerified: false, unattendedAllowed: false };
    if (old) t.attempts[t.attempts.indexOf(old)] = a; else t.attempts.push(a);
    return this.save(t);
  }
  checksForIntent(pid: string, id: string) {
    const task = this.raw(pid, id);
    return task.checks.filter(check => task.checkIntentVersions?.[check.id] === task.intentVersion);
  }
  private checkDraftProof(pid: string, task: ProductionTask, context: EditingContext, snapshotId: string) {
    const frozen = freezeEditingContext(this.store, pid, context);
    if (context.mode !== "draft" || frozen.snapshotId !== snapshotId || frozen.clipId !== task.contract.scope?.clipId || !context.draftId) fail("草稿检查与任务当前范围不匹配");
    const document = this.store.documents.read(pid, context.draftId!);
    if (document.draft.source !== "agent" || document.draft.sessionId !== task.sessionId) fail("检查草稿不属于任务会话");
  }
  recordRepairRound(pid: string, id: string, input: { expectedRevision: number; issueId: string; snapshotId: string; improved: boolean }, draftContext?: EditingContext): ProductionTask {
    const t = this.edit(pid, id, input.expectedRevision);
    if (draftContext) this.checkDraftProof(pid, t, draftContext, input.snapshotId);
    else this.currentSnapshot(pid, t, input.snapshotId);
    if ((t.repairRounds || []).some(r => r.snapshotId === input.snapshotId && r.issueId === input.issueId)) return this.view(t);
    (t.repairRounds ??= []).push({ issueId: input.issueId, snapshotId: input.snapshotId, intentVersion: t.intentVersion, improved: input.improved });
    return this.save(t);
  }
  recordCheck(pid: string, id: string, input: CheckInput, draftContext?: EditingContext): ProductionTask {
    const finding = z.object({ id: z.string().min(1).max(200), severity: z.enum(["info","warning","error"]), location: z.string().optional(), evidence: z.string().optional(), snapshotId: uuid, status: z.enum(["passed","suspect","failed","unverified"]), resolution: z.enum(["open","resolved","accepted"]), message: z.string() }).strict();
    const schema = z.object({ id: uuid, kind: z.enum(["static","temporal"]), snapshotId: uuid, scope: qualityScopeSchema, status: z.enum(["passed","suspect","failed","unverified"]), findings: z.array(finding), createdAt: z.string().datetime(), dependencies: z.array(z.string()).optional(), draftId: uuid.optional(), documentRevision: z.string().optional() }).strict();
    const v = z.object({ expectedRevision: z.number().int().positive(), check: schema }).strict().parse(input);
    const t = this.edit(pid,id,v.expectedRevision); if (t.status === "stopped") fail("任务已停止");
    if (draftContext) {
      this.checkDraftProof(pid, t, draftContext, v.check.snapshotId);
      if (v.check.draftId !== draftContext.draftId || v.check.documentRevision !== draftContext.documentRevision) fail("草稿检查正文版本不一致");
    } else { if (v.check.draftId || v.check.documentRevision) fail("草稿检查缺少受信来源"); this.currentSnapshot(pid,t,v.check.snapshotId); }
    this.scope(pid,v.check.scope,v.check.snapshotId);
    if (v.check.findings.some(f => f.snapshotId !== v.check.snapshotId)) fail("检查证据快照不匹配");
    const existing = t.checks.find(c => c.id === v.check.id);
    if (existing) { if (JSON.stringify(existing) !== JSON.stringify(v.check)) fail("相同检查ID不能更换内容"); return t; }
    t.checks.push(v.check); t.findings.push(...v.check.findings);
    (t.checkIntentVersions ??= {})[v.check.id] = t.intentVersion;
    if (t.status === "ready" || t.status === "accepted") { t.status = "blocked"; t.waitReason = "scope"; }
    return this.save(t);
  }
}
