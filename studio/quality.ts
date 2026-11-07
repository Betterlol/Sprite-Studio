import type { ClipSnapshot, RenderWarning } from "./model.ts";
import type { QualityCapabilities, QualityCheck, QualityFinding, QualityScope } from "./workflow-model.ts";

/** Capabilities of this deterministic policy, not a claim about any model. */
export function getQualityCapabilities(): QualityCapabilities {
  return {
    static: { verified: true, categories: ["duration", "image-reference", "render-overflow"] },
    temporal: { verified: false, categories: [] },
    unattendedGeneration: false,
    reason: "内置生成调用前预算拦截未验证；日志不是硬控制，禁止无人值守重生成。时序模型评估未验证，需人工动态验收。",
  };
}

export type QualityObservation = { location: string; category: "center" | "size" | "color" | "timing" | "loop" | "boundary"; evidence: string };
export type StaticCheckInput = {
  snapshot: ClipSnapshot; scope: QualityScope; id: string; createdAt: string;
  warnings?: RenderWarning[]; observations?: QualityObservation[]; dependencies?: string[];
  /** Expanded Review speeds use integer microseconds, not editable clip limits. */
  durationRange?: { min: number; max: number };
};

/** Evaluates supplied snapshot data only; the caller must resolve and verify its evidence. */
export function checkStaticQuality(input: StaticCheckInput): QualityCheck {
  const { snapshot, scope } = input;
  if (scope.clipId !== snapshot.clip.id) throw new Error("质量检查范围与快照不匹配");
  const frames = snapshot.clip.frames;
  const start = scope.startFrameId ? frames.findIndex(f => f.id === scope.startFrameId) : 0;
  const end = scope.endFrameId ? frames.findIndex(f => f.id === scope.endFrameId) : frames.length - 1;
  if (start < 0 || end < start || end >= frames.length) throw new Error("无效质量检查范围");
  const selected = frames.slice(start, end + 1);
  const ids = new Set(selected.map(f => f.id));
  const findings: QualityFinding[] = [];
  function add(status: QualityFinding["status"], location: string, message: string, evidence?: string) {
    findings.push({ id: `${input.id}:${findings.length + 1}`, severity: status === "failed" ? "error" : "warning", location, message, evidence, snapshotId: snapshot.id, status, resolution: "open" });
  }
  for (const frame of selected) {
    if (!Number.isInteger(frame.durationUs) || frame.durationUs < (input.durationRange?.min ?? 1000) || frame.durationUs > (input.durationRange?.max ?? 60_000_000))
      add("failed", frame.id, "非法帧时长", String(frame.durationUs));
    if (!snapshot.images[frame.imageId]) add("failed", frame.id, "图片引用缺失", frame.imageId);
  }
  for (const warning of input.warnings ?? []) {
    if (!warning.frameId || !ids.has(warning.frameId)) continue;
    if (Object.values(warning.overflow).some(value => value > 0)) {
      if (warning.blocking) add("failed", warning.frameId, "不允许的裁切越界", JSON.stringify(warning.overflow));
      else add("suspect", warning.frameId, "允许的越界需要结合意图检查", JSON.stringify(warning.overflow));
    }
  }
  const allFrameIds = new Set(frames.map(f => f.id));
  for (const obs of input.observations ?? []) {
    // Non-frame locations (e.g. a named transition) cannot be range-resolved here.
    if (allFrameIds.has(obs.location) && !ids.has(obs.location)) continue;
    add("suspect", obs.location, `需要人工判断：${obs.category}`, obs.evidence);
  }
  if (input.warnings === undefined) add("unverified", scope.clipId, "未提供渲染越界检查证据");
  const status = findings.some(f => f.status === "failed") ? "failed" : findings.some(f => f.status === "unverified") ? "unverified" : findings.length ? "suspect" : "passed";
  return { id: input.id, kind: "static", snapshotId: snapshot.id, scope: { ...scope }, status, findings, createdAt: input.createdAt, ...(input.dependencies ? { dependencies: [...input.dependencies] } : {}) };
}

/** No synthetic test upgrades temporal model capabilities. */
export function unverifiedTemporalCheck(input: { id: string; snapshotId: string; scope: QualityScope; createdAt: string; dependencies?: string[] }): QualityCheck {
  return { ...input, kind: "temporal", status: "unverified", findings: [{ id: `${input.id}:1`, severity: "warning", snapshotId: input.snapshotId, status: "unverified", resolution: "open", message: "时序模型评估未验证；需要人工动态验收。" }] };
}

export type RepairRound = { issueId: string; improved: boolean };
export type RepairDecision = { stop: boolean; reason: "continue" | "limit" | "no-progress" | "nothing-actionable" | "conflict" | "capability" };
/** Two consecutive unsuccessful attempts on the same issue stop, regardless of other issues. */
export function decideRepair(input: { rounds: RepairRound[]; limit: number; actionable: boolean; conflict?: boolean; capabilityAvailable?: boolean }): RepairDecision {
  if (!Number.isInteger(input.limit) || input.limit < 0) throw new Error("无效修复轮次上限");
  if (input.conflict) return { stop: true, reason: "conflict" };
  if (input.capabilityAvailable === false) return { stop: true, reason: "capability" };
  if (!input.actionable) return { stop: true, reason: "nothing-actionable" };
  if (input.rounds.length >= input.limit) return { stop: true, reason: "limit" };
  const last = input.rounds.at(-1);
  if (last && !last.improved) {
    const previous = input.rounds.slice(0, -1).findLast(r => r.issueId === last.issueId);
    if (previous && !previous.improved) return { stop: true, reason: "no-progress" };
  }
  return { stop: false, reason: "continue" };
}

export type DeliveryDecision = { status: "blocked" | "ready"; reasons: string[]; pendingHumanDynamicReview: boolean };
/** Checks must already be validated against actual snapshot and dependencies by the service. */
export function decideDelivery(input: { snapshotId: string; checks: QualityCheck[]; requiredChecks: ("static" | "temporal")[] }): DeliveryDecision {
  const reasons: string[] = [];
  const current = input.checks.filter(check => check.snapshotId === input.snapshotId);
  if (current.some(check => check.status === "failed" || check.findings.some(f => f.status === "failed" && f.resolution === "open"))) reasons.push("存在确定性失败，不能正常交付。");
  for (const kind of input.requiredChecks) {
    const checks = current.filter(check => check.kind === kind);
    if (!checks.length || (kind === "static" && checks.some(check => check.status === "unverified"))) reasons.push(`缺少已验证的 ${kind} 检查。`);
  }
  const pendingHumanDynamicReview = !current.some(check => check.kind === "temporal" && check.status === "passed");
  return { status: reasons.length ? "blocked" : "ready", reasons, pendingHumanDynamicReview };
}

/** Future adapters must enforce refusal before execution, including concurrent and unknown attempts.
 * This contract alone does not certify an implementation or enable unattended generation. */
export type GenerationBudgetAdapter = {
  authorizeBeforeExecution(request: { attemptId: string; taskId: string; limit: number }): Promise<{ allowed: boolean; reason: string }>;
};

/** The current runtime has no proven pre-call control. A ledger is not an enforcement adapter. */
export function generationBudgetCapability(): { preflightHardControl: false; unattendedGeneration: false; reason: string } {
  return { preflightHardControl: false, unattendedGeneration: false, reason: "调用前硬预算未验证；attempt ledger 仅为日志，不能拦截生成。" };
}
