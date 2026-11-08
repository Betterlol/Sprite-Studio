import { z } from "zod";
import { frameTransformSchema, type ClipAsset, type ClipFrame, type ClipSnapshot, type RenderWarning } from "./model.ts";

const id = z.string().uuid();
export const editingContextSchema = z.object({
  clipId: id.optional(), assetId: id.optional(), revision: z.string().optional(),
  snapshotId: id.optional(), frameId: id.optional(), startFrameId: id.optional(),
  endFrameId: id.optional(), draftId: id.optional(), documentRevision: z.string().optional(),
  mode: z.enum(["saved", "draft"]),
}).strict().refine(v => !!(v.clipId || v.assetId || v.snapshotId || v.draftId), "需要可解析的目标");
export type EditingContext = z.infer<typeof editingContextSchema>;
export const qualityScopeSchema = z.object({
  clipId: id, startFrameId: id.optional(), endFrameId: id.optional(),
}).strict();
export type QualityScope = z.infer<typeof qualityScopeSchema>;
export const productionContractSchema = z.object({
  roleReferenceIds: z.array(id).default([]), scope: qualityScopeSchema.optional(),
  immutable: z.array(z.string()).default([]), canvas: z.object({width: z.number().int().positive(), height: z.number().int().positive()}).strict().optional(),
  baseline: z.string().optional(), durationUs: z.number().int().positive().optional(), reviewSequenceId: id.optional(),
  generationLimit: z.number().int().min(0).default(1), repairLimit: z.number().int().min(0).default(3),
  requiredChecks: z.array(z.enum(["static", "temporal"])).min(1).default(["static"]),
}).strict();
export type ProductionContract = z.infer<typeof productionContractSchema>;
export type GenerationAttempt = {
  id: string; intentVersion: number; status: "reserved" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  generatedId?: string; assetId?: string; contentHash?: string; reason?: string; createdAt: string; updatedAt: string;
  preflightVerified: false; unattendedAllowed: false; runtimeItemId?: string;
  referenceEvidence?: { expectedHashes: string[]; receivedHashes: string[]; verified: boolean };
};
export type DirectionDecision = {
  accept: boolean; feedback?: string; generatedId?: string; assetId?: string; snapshotId?: string;
  contentHash: string; intentVersion: number; createdAt: string;
};
export type QualityFinding = {
  id: string; severity: "info" | "warning" | "error"; location?: string; evidence?: string;
  snapshotId: string; status: "passed" | "suspect" | "failed" | "unverified";
  resolution: "open" | "resolved" | "accepted"; message: string;
};
export type QualityCheck = {
  id: string; kind: "static" | "temporal"; snapshotId: string; scope: QualityScope;
  status: "passed" | "suspect" | "failed" | "unverified"; findings: QualityFinding[]; createdAt: string;
  dependencies?: string[]; draftId?: string; documentRevision?: string;
};
export type QualityCapabilities = {
  static: { verified: boolean; categories: string[] }; temporal: { verified: boolean; categories: string[] };
  unattendedGeneration: false; reason: string;
};
export const qualityCapabilities: QualityCapabilities = {
  static: { verified: false, categories: [] }, temporal: { verified: false, categories: [] },
  unattendedGeneration: false, reason: "内置生成调用前预算拦截未验证，禁止无人值守重生成。",
};
export type TaskReviewEvidence = {
  id: string; intentVersion: number; targetSnapshotId: string; definitionId: string;
  sequenceId: string; snapshotId: string; definitionRevision: string;
  dependencies: ReviewSequenceSnapshot["dependencies"]; coverage: { totalFrames: number; frameIds: string[]; complete: boolean; reviewIds: string[] };
  checks: QualityCheck[]; createdAt: string;
};
export type ProductionTask = {
  id: string; projectId: string; requestId: string; requestHash: string; revision: number; intentVersion: number; barrierVersion: number;
  title: string; description: string; phase: "direction" | "production" | "delivery";
  status: "running" | "waiting" | "paused" | "blocked" | "ready" | "accepted" | "stopped" | "failed";
  waitReason?: "direction" | "tool_approval" | "scope" | "version_conflict" | "budget" | "capability";
  target?: EditingContext; referenceIds: string[]; contract: ProductionContract; attempts: GenerationAttempt[];
  direction?: DirectionDecision; directionHistory: DirectionDecision[]; findings: QualityFinding[]; checks: QualityCheck[];
  sessionId?: string; readySnapshotId?: string; acceptedSnapshotId?: string; reviewEvidence?: TaskReviewEvidence[]; readyReviewEvidenceId?: string;
  repairRounds?: { issueId: string; snapshotId: string; intentVersion: number; improved: boolean }[];
  drafts?: { draftId: string; kind: "clip" | "frame"; intentVersion: number }[];
  acceptanceHistory: { snapshotId: string; intentVersion: number; reviewEvidenceId?: string; createdAt: string }[];
  createdAt: string; updatedAt: string; error?: string;
};
export type DraftDeliveryTarget = { draftId: string; documentRevision: string; kind?: "frame" };
export type ClipDraftDelivery = { draftId: string; documentRevision: string; snapshotId: string; target: DraftDeliveryTarget };
export type ClipDraft = { taskIndependent?: boolean; id: string; projectId: string; clipId: string; baseSnapshotId: string; source: "human" | "agent"; sessionId?: string; taskId?: string; intentVersion?: number; readOnly?: boolean; deliveryTarget?: DraftDeliveryTarget; delivery?: ClipDraftDelivery; adoptedResult?: { draftId: string; documentRevision: string }; status: "editing" | "saved" | "discarded"; createdAt: string };
export const clipEditSchema = z.object({
  schemaVersion: z.literal(1), type: z.literal("clip-edit"),
  frames: z.array(z.object({ id, imageId: id, durationUs: z.number().int().min(1000).max(60_000_000), transform: frameTransformSchema.optional() }).strict()).max(128),
  loop: z.boolean(), initialFps: z.number().min(1).max(60).optional(),
}).strict();
export type ClipEdit = z.infer<typeof clipEditSchema>;
export type ClipDraftDocument = { documentId: string; documentRevision: string; text: string; draft: ClipDraft };
export type ClipDraftPreview = { draft: ClipDraft; before: ClipSnapshot; preview: ClipSnapshot; modified: boolean; modifiedFrameIds: string[]; warnings: RenderWarning[] };
export type ClipDraftSave = { draftId: string; clip: ClipAsset; beforeSnapshotId: string; afterSnapshotId: string };
export const reviewSegmentSchema = z.object({ id, clipId: id, startFrameId: id.optional(), endFrameId: id.optional(), repeat: z.number().int().min(1).default(1), speed: z.number().positive().default(1) }).strict();
export type ReviewSegment = z.infer<typeof reviewSegmentSchema>;
export type ReviewSequenceDefinition = { id: string; projectId: string; revision: string; name: string; loop: boolean; segments: ReviewSegment[]; archived?: boolean };
export type ReviewSequenceSnapshot = { id: string; definitionId: string; definitionRevision: string; projectId: string; createdAt: string; snapshotId: string; dependencies: { clipId: string; snapshotId: string; revision: string }[]; segments: { segmentId: string; frameIds: string[] }[]; stale: boolean };
export type { ClipFrame };
