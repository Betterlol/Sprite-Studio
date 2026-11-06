import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { atomicJson, sha256, StudioError, type ProjectStore } from "./store.ts";
import { editingContextSchema, productionContractSchema, qualityScopeSchema, type ProductionTask, type GenerationAttempt, type QualityCheck, type DirectionDecision } from "./workflow-model.ts";

const uuid = z.string().uuid();
const createSchema = z.object({ requestId: uuid, title: z.string().trim().min(1).max(200), description: z.string().max(10000), target: editingContextSchema.optional(), referenceIds: z.array(uuid).default([]), contract: productionContractSchema.default(() => productionContractSchema.parse({})), sessionId: uuid.optional() }).strict();
export type CreateTaskInput = z.input<typeof createSchema>;
export type TaskAction = { expectedRevision: number; action: "pause" | "resume" | "stop" | "handoff" | "feedback" | "ready" | "accept"; text?: string; snapshotId?: string };
export type DirectionInput = { expectedRevision: number; accept: boolean; feedback?: string; generatedId?: string; assetId?: string; snapshotId?: string; contentHash?: string };
export type AttemptInput = { expectedRevision: number; id: string; status: GenerationAttempt["status"]; generatedId?: string; assetId?: string; contentHash?: string; reason?: string };
export type CheckInput = { expectedRevision: number; check: QualityCheck };
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
  private raw(pid: string, id: string): ProductionTask {
    const file = this.path(pid, id);
    if (!existsSync(file)) throw new StudioError("制作任务不存在", 404);
    const task = JSON.parse(readFileSync(file, "utf8")) as ProductionTask;
    if (task.id !== id || task.projectId !== pid) throw new StudioError("制作任务不存在", 404);
    return task;
  }
  private rawList(pid: string): ProductionTask[] {
    const folder = this.store.safePath(pid, ".studio/tasks");
    if (!existsSync(folder)) return [];
    return readdirSync(folder).filter(f => /^[0-9a-f-]{36}\.json$/i.test(f)).map(f => this.raw(pid, f.slice(0, -5)));
  }
  private persist(task: ProductionTask) {
    task.updatedAt = now(); const file = this.path(task.projectId, task.id);
    mkdirSync(dirname(file), { recursive: true }); atomicJson(file, task); this.store.changed(task.projectId); return structuredClone(task);
  }
  private validateTarget(pid: string, target?: ProductionTask["target"]) {
    if (!target) return;
    const asset = target.assetId ? this.store.asset(pid, target.assetId) : undefined;
    const clip = target.clipId ? this.store.animation.clip(pid, target.clipId) : undefined;
    if (asset && clip && asset.id !== clip.id) fail("目标资源与动画不一致");
    if (target.revision && (clip || asset)?.revision !== target.revision) fail("目标版本已变化");
    if (target.snapshotId) {
      const snap = this.store.animation.snapshot(pid, target.snapshotId);
      if ((clip && snap.clip.id !== clip.id) || (asset && snap.clip.id !== asset.id)) fail("目标快照不属于目标动画");
    }
    if (target.draftId) { const d = this.store.frameDrafts.get(pid, target.draftId); if (clip && d.clipId !== clip.id) fail("草稿不属于目标动画"); }
    const frames = clip?.frames || (target.snapshotId ? this.store.animation.snapshot(pid, target.snapshotId).clip.frames : undefined);
    if (target.frameId || target.startFrameId || target.endFrameId) {
      if (!frames) fail("帧目标需要动画");
      const start = target.startFrameId ? frames!.findIndex(f => f.id === target.startFrameId) : 0;
      const end = target.endFrameId ? frames!.findIndex(f => f.id === target.endFrameId) : frames!.length - 1;
      if (start < 0 || end < start || (target.frameId && !frames!.some(f => f.id === target.frameId))) fail("帧目标不属于动画或区间无效");
    }
  }
  private scope(pid: string, scope: ProductionTask["contract"]["scope"], snapshotId?: string) {
    if (!scope) fail("需要明确检查范围");
    const snap = snapshotId ? this.store.animation.snapshot(pid, snapshotId) : undefined;
    const clip = snap ? snap.clip : this.store.animation.clip(pid, scope!.clipId);
    if (clip.id !== scope!.clipId) fail("检查范围与快照不匹配");
    const start = scope!.startFrameId ? clip.frames.findIndex(f => f.id === scope!.startFrameId) : 0;
    const end = scope!.endFrameId ? clip.frames.findIndex(f => f.id === scope!.endFrameId) : clip.frames.length - 1;
    if (start < 0 || end < start) fail("检查范围无效");
  }
  private currentSnapshot(pid: string, task: ProductionTask, sid: string) {
    const snap = this.store.animation.snapshot(pid, sid);
    if (snap.renderMode || !task.contract.scope || snap.clip.id !== task.contract.scope.clipId) fail("快照不是任务目标的已保存动画");
    this.scope(pid, task.contract.scope, sid);
    if (this.store.animation.capture(pid, snap.clip.id).id !== sid) fail("快照不再是当前动画版本");
    return snap;
  }
  private directionCurrent(pid: string, task: ProductionTask) {
    const d = task.direction;
    if (!d?.accept || d.intentVersion !== task.intentVersion) return false;
    try {
      if (d.generatedId && sha256(readFileSync(this.store.generated.imagePath(pid, d.generatedId))) !== d.contentHash) return false;
      if (d.assetId && sha256(readFileSync(this.store.imagePath(pid, d.assetId))) !== d.contentHash) return false;
      if (d.snapshotId) {
        const s = this.store.animation.snapshot(pid, d.snapshotId);
        if (this.store.animation.capture(pid, s.clip.id).id !== s.id || sha256(JSON.stringify([s.clip.frames, s.images, s.clip.loop])) !== d.contentHash) return false;
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
  create(pid: string, input: CreateTaskInput): ProductionTask {
    this.store.project(pid); const spec = createSchema.parse(input), hash = sha256(JSON.stringify(spec));
    const old = this.rawList(pid).find(t => t.requestId === spec.requestId);
    if (old) { if (old.requestHash !== hash) fail("同一请求不能更换任务意图"); return this.view(old); }
    this.validateTarget(pid, spec.target);
    for (const id of [...spec.referenceIds, ...spec.contract.roleReferenceIds]) this.store.imagePath(pid, id);
    if (spec.contract.scope) { this.scope(pid, spec.contract.scope); if ((spec.target?.clipId && spec.target.clipId !== spec.contract.scope.clipId) || (spec.target?.assetId && spec.target.assetId !== spec.contract.scope.clipId) || (spec.target?.snapshotId && this.store.animation.snapshot(pid, spec.target.snapshotId).clip.id !== spec.contract.scope.clipId)) fail("任务目标与范围不一致"); }
    if (spec.sessionId && this.store.session(spec.sessionId).projectId !== pid) fail("会话不属于该工程");
    const timestamp = now();
    return this.persist({ id: randomUUID(), projectId: pid, requestId: spec.requestId, requestHash: hash, revision: 1, intentVersion: 1, barrierVersion: 1, title: spec.title, description: spec.description, target: spec.target, referenceIds: spec.referenceIds, contract: spec.contract, sessionId: spec.sessionId, phase: "direction", status: "waiting", waitReason: "direction", attempts: [], checks: [], findings: [], directionHistory: [], acceptanceHistory: [], createdAt: timestamp, updatedAt: timestamp });
  }
  private edit(pid: string, id: string, revision: number) {
    const task = this.raw(pid, id); if (!Number.isInteger(revision) || task.revision !== revision) fail("VERSION_CONFLICT：任务已变化"); return task;
  }
  private save(task: ProductionTask) { task.revision++; return this.persist(task); }
  action(pid: string, id: string, input: TaskAction): ProductionTask {
    const spec = z.object({ expectedRevision: z.number().int().positive(), action: z.enum(["pause","resume","stop","handoff","feedback","ready","accept"]), text: z.string().trim().min(1).optional(), snapshotId: uuid.optional() }).strict().parse(input);
    const t = this.edit(pid, id, spec.expectedRevision);
    if (t.status === "stopped") fail("任务已停止");
    if (["pause", "handoff", "stop", "feedback"].includes(spec.action)) {
      for (const attempt of t.attempts) if (attempt.status === "reserved" || attempt.status === "running") {
        attempt.status = "unknown"; attempt.reason = "版本屏障后生成结果未知，不能自动重发"; attempt.updatedAt = now();
      }
    }
    switch (spec.action) {
      case "pause": case "handoff": t.barrierVersion++; t.status = "paused"; t.waitReason = undefined; t.error = spec.action === "handoff" ? "人工接手" : "已暂停"; break;
      case "stop": t.barrierVersion++; t.status = "stopped"; t.waitReason = undefined; break;
      case "feedback": if (!spec.text) fail("反馈不能为空"); t.description += `\n${spec.text}`; t.intentVersion++; t.barrierVersion++; t.direction = undefined; t.readySnapshotId = undefined; t.phase = "direction"; t.status = "waiting"; t.waitReason = "direction"; break;
      case "resume": if (!["paused", "blocked", "waiting"].includes(t.status)) fail("当前状态不能继续"); if (!this.directionCurrent(pid, t)) { t.phase = "direction"; t.status = "waiting"; t.waitReason = "direction"; } else { t.phase = "production"; t.status = "running"; t.waitReason = undefined; } t.error = undefined; break;
      case "ready": {
        if (!spec.snapshotId) fail("需要确切快照"); this.currentSnapshot(pid, t, spec.snapshotId!);
        if (!this.directionCurrent(pid, t)) fail("方向未通过或已过期");
        const checks = t.checks.filter(c => c.snapshotId === spec.snapshotId && JSON.stringify(c.scope) === JSON.stringify(t.contract.scope));
        if (t.contract.requiredChecks.some(k => !checks.some(c => c.kind === k))) fail("检查范围不完整");
        if (t.checks.filter(c => c.snapshotId === spec.snapshotId).some(c => c.status === "failed" || c.findings.some(f => f.status === "failed" && f.resolution !== "resolved"))) fail("已知检查失败不能标为可验收");
        t.readySnapshotId = spec.snapshotId; t.phase = "delivery"; t.status = "ready"; t.waitReason = undefined; t.error = undefined; break;
      }
      case "accept": if (t.status !== "ready" || !spec.snapshotId || spec.snapshotId !== t.readySnapshotId) fail("只能接受确切的可验收快照"); this.currentSnapshot(pid, t, spec.snapshotId!); if (!this.directionCurrent(pid, t)) fail("方向已过期"); t.acceptedSnapshotId = spec.snapshotId; t.acceptanceHistory.push({ snapshotId: spec.snapshotId!, intentVersion: t.intentVersion, createdAt: now() }); t.status = "accepted"; break;
    }
    return this.save(t);
  }
  decideDirection(pid: string, id: string, input: DirectionInput): ProductionTask {
    const v = z.object({ expectedRevision: z.number().int().positive(), accept: z.boolean(), feedback: z.string().trim().min(1).optional(), generatedId: uuid.optional(), assetId: uuid.optional(), snapshotId: uuid.optional(), contentHash: z.string().optional() }).strict().parse(input);
    const t = this.edit(pid,id,v.expectedRevision); if (t.status === "stopped") fail("任务已停止");
    if (!v.accept && !v.feedback) fail("驳回方向需要意见");
    if (![v.generatedId, v.assetId, v.snapshotId].some(Boolean) || (v.snapshotId && (v.generatedId || v.assetId))) fail("方向需要确切产物或快照");
    let hash: string | undefined;
    if (v.generatedId) { const record = this.store.generated.record(pid, v.generatedId); if (record.projectId !== pid) fail("生成产物不属于工程"); hash = sha256(readFileSync(this.store.generated.imagePath(pid,v.generatedId))); }
    if (v.assetId) { const actual = sha256(readFileSync(this.store.imagePath(pid,v.assetId))); if (hash && actual !== hash) fail("生成产物与资源像素不一致"); hash = actual; }
    if (v.snapshotId) { const snap = this.currentSnapshot(pid,t,v.snapshotId); hash = sha256(JSON.stringify([snap.clip.frames, snap.images, snap.clip.loop])); }
    if (v.contentHash && v.contentHash !== hash) fail("产物摘要与实际内容不一致");
    const decision: DirectionDecision = { accept: v.accept, feedback: v.feedback, generatedId: v.generatedId, assetId: v.assetId, snapshotId: v.snapshotId, contentHash: hash!, intentVersion: t.intentVersion, createdAt: now() };
    t.directionHistory.push(decision); t.direction = decision; t.readySnapshotId = undefined;
    if (v.accept) { t.phase = "production"; t.status = "running"; t.waitReason = undefined; }
    else { t.intentVersion++; t.barrierVersion++; t.phase = "direction"; t.status = "waiting"; t.waitReason = "direction"; }
    return this.save(t);
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
  recordCheck(pid: string, id: string, input: CheckInput): ProductionTask {
    const finding = z.object({ id: uuid, severity: z.enum(["info","warning","error"]), location: z.string().optional(), evidence: z.string().optional(), snapshotId: uuid, status: z.enum(["passed","suspect","failed","unverified"]), resolution: z.enum(["open","resolved","accepted"]), message: z.string() }).strict();
    const schema = z.object({ id: uuid, kind: z.enum(["static","temporal"]), snapshotId: uuid, scope: qualityScopeSchema, status: z.enum(["passed","suspect","failed","unverified"]), findings: z.array(finding), createdAt: z.string().datetime(), dependencies: z.array(z.string()).optional() }).strict();
    const v = z.object({ expectedRevision: z.number().int().positive(), check: schema }).strict().parse(input);
    const t = this.edit(pid,id,v.expectedRevision); if (t.status === "stopped") fail("任务已停止");
    this.currentSnapshot(pid,t,v.check.snapshotId); this.scope(pid,v.check.scope,v.check.snapshotId);
    if (v.check.findings.some(f => f.snapshotId !== v.check.snapshotId)) fail("检查证据快照不匹配");
    const existing = t.checks.find(c => c.id === v.check.id);
    if (existing) { if (JSON.stringify(existing) !== JSON.stringify(v.check)) fail("相同检查ID不能更换内容"); return t; }
    t.checks.push(v.check); t.findings.push(...v.check.findings);
    if (t.status === "ready" || t.status === "accepted") { t.status = "blocked"; t.waitReason = "scope"; }
    return this.save(t);
  }
}
