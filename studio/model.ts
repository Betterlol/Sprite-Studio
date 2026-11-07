import { z } from "zod";

export const agentModels = [
  "gpt-6.1-sol",
  "gpt-6.1-luna",
  "gpt-6.1-terra",
] as const;
export const agentModelSchema = z.enum(agentModels);
export type AgentModel = z.infer<typeof agentModelSchema>;
export const defaultAgentModel: AgentModel = "gpt-6.1-sol";

export const imageKindSchema = z.enum(["reference", "image"]);
export type ImageKind = z.infer<typeof imageKindSchema>;
export const resourceCategories = ["参考图", "原图素材", "动画"] as const;
export type ResourceCategory = (typeof resourceCategories)[number];
export const folderCategory = (folder: string) =>
  resourceCategories.find(
    (root) => folder === root || folder.startsWith(root + "/"),
  );
export const resourceCategory = (
  asset: Pick<Asset, "type"> & { kind?: ImageKind },
): ResourceCategory =>
  asset.type === "clip"
    ? "动画"
    : asset.kind === "reference"
      ? "参考图"
      : "原图素材";
export function categoryFolder(category: ResourceCategory, folder = "") {
  const root = folderCategory(folder);
  const suffix = root ? folder.slice(root.length) : folder ? "/" + folder : "";
  return category + suffix;
}
export type Project = {
  id: string;
  name: string;
  createdAt: string;
  version: 1;
  resourceLayout?: 1;
};
export type ImageAsset = {
  producer?: { sheetId: string; sliceId: string };
  folder?: string;
  id: string;
  type: "image";
  name: string;
  kind: ImageKind;
  revision: string;
  createdAt: string;
  width: number;
  height: number;
  frameCount: number;
  mime: string;
  file: string;
  contentHash: string;
  origin?: {
    kind: string;
    assetId?: string;
    revision?: string;
    operation?: unknown;
    runId?: string;
    interpolationId?: string;
  };
};
export type FrameTransform = {
  scale: number;
  offsetX: number;
  offsetY: number;
  clip: boolean;
};
export const frameTransformSchema = z
  .object({
    scale: z.number().min(0.05).max(4).default(1),
    offsetX: z.number().min(-4096).max(4096).default(0),
    offsetY: z.number().min(-4096).max(4096).default(0),
    clip: z.boolean().default(false),
  })
  .strict();
export type ClipFrame = {
  id: string;
  imageId: string;
  durationUs: number;
  transform?: FrameTransform;
};
export type FrameDraft = {
  id: string;
  projectId: string;
  clipId: string;
  frameId: string;
  baseSnapshotId: string;
  source: "agent" | "human";
  sessionId?: string;
  taskId?: string;
  intentVersion?: number;
  readOnly?: boolean;
  status: "editing" | "pending" | "saved" | "discarded";
  createdAt: string;
  documentRevision: string;
  text: string;
  snapshotId?: string;
  mergedInto?: string;
  changeId?: string;
};
export const legacyFrameEditSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("frame-edit"),
    transform: frameTransformSchema,
    durationUs: z.number().int().min(1000).max(60_000_000),
  })
  .strict();
export const frameEditItemSchema = z
  .object({
    frameId: z.string().uuid(),
    transform: frameTransformSchema,
    durationUs: z.number().int().min(1000).max(60_000_000),
  })
  .strict();
export const frameEditSchema = z
  .object({
    schemaVersion: z.literal(2),
    type: z.literal("frame-edit"),
    frames: z.array(frameEditItemSchema).min(1).max(128),
  })
  .strict();
export type RenderWarning = {
  frameId?: string;
  frameNumber?: number;
  bounds: [number, number, number, number];
  overflow: { left: number; top: number; right: number; bottom: number };
  blocking: boolean;
};
export type TransformPreview = {
  id: string;
  width: number;
  height: number;
  bounds: [number, number, number, number] | null;
  overflow: { left: number; top: number; right: number; bottom: number };
  blocking: boolean;
  url: string;
};
export type FrameSaveApproval = {
  id: string;
  draftId: string;
  documentRevision: string;
  beforeSnapshotId: string;
  previewSnapshotId: string;
  frameNumber: number;
  clipName: string;
  frameChanges?: {
    frameId: string;
    frameNumber: number;
    before: Pick<ClipFrame, "transform" | "durationUs">;
    after: Pick<ClipFrame, "transform" | "durationUs">;
  }[];
  before: Pick<ClipFrame, "transform" | "durationUs">;
  after: Pick<ClipFrame, "transform" | "durationUs">;
};
export type ClipAsset = {
  initialFps?: number;
  folder?: string;
  file?: string;
  id: string;
  type: "clip";
  name: string;
  revision: string;
  createdAt: string;
  frames: ClipFrame[];
  loop: boolean;
  origin?: { assetId: string; revision: string };
  appliedInterpolationIds?: string[];
  appliedFrameChangeIds?: string[];
  revertedFrameChangeIds?: string[];
};
export type Asset = ImageAsset | ClipAsset;
export type LibrarySelection = { assetIds: string[]; folders: string[] };
export type TrashEntry = {
  resourceLayout?: 1;
  id: string;
  label: string;
  deletedAt: string;
  status: "trashed" | "restored";
  assets: Asset[];
  folders: string[];
  roots: { from: string; to: string }[];
};
export type DeletePlan = {
  selection: LibrarySelection;
  assetIds: string[];
  folders: string[];
  blockers: { name: string; reason: string }[];
};
export type ChatMessage = {
  context?: import("./workflow-model.ts").EditingContext;
  taskId?: string;
  generatedIds?: string[];
  id: string;
  role: "user" | "assistant";
  text: string;
  displayText?: string;
  assetIds: string[];
  clipReferences?: ClipAttachment[];
  reviewIds?: string[];
  clipDraftIds?: string[];
  changeIds?: string[];
  createdAt: string;
  status?: "streaming" | "completed" | "interrupted" | "failed";
  phase?: string;
};
export type Activity = {
  id: string;
  label: string;
  status: "running" | "completed" | "failed";
  detail?: string;
};
export type PromptQuestion = {
  id: string;
  question: string;
  options: string[];
};
export type PendingPrompt = {
  id: string;
  requestId?: string | number;
  blocking?: boolean;
  questions: PromptQuestion[];
};
export type SessionDiagnostic = {
  id: string;
  createdAt: string;
  kind: "approval" | "runtime" | "tool";
  message: string;
  method?: string;
  turnId?: string;
};
export type ToolApproval = {
  id: string;
  tool: string;
  label: string;
  arguments: Record<string, unknown>;
  createdAt: string;
  taskId?: string;
  taskRevision?: number;
  intentVersion?: number;
  barrierVersion?: number;
  directionRequired?: boolean;
};
export type Session = {
  taskId?: string;
  workflowIntent?: { taskId: string; intentVersion: number; barrierVersion: number };
  editingContext?: import("./workflow-model.ts").EditingContext;
  agentDraftId?: string;
  workflowReferenceHashes?: string[];
  diagnostics?: SessionDiagnostic[];
  outputFolder?: string;
  id: string;
  projectId: string;
  title: string;
  threadId?: string;
  turnId?: string;
  status: "idle" | "starting" | "running" | "interrupted" | "failed";
  model?: string;
  messages: ChatMessage[];
  activities: Activity[];
  error?: string;
  prompt?: PendingPrompt;
  frameSaveApproval?: FrameSaveApproval;
  toolApproval?: ToolApproval;
  createdAt: string;
  updatedAt: string;
  interpolationId?: string;
};
export type FrameReference = {
  frameId: string;
  imageId: string;
  revision: string;
  contentHash: string;
};
export type Interpolation = {
  id: string;
  projectId: string;
  sessionId: string;
  clipId: string;
  clipRevision: string;
  start: FrameReference;
  end: FrameReference;
  count: number;
  fps: number;
  description: string;
  columns: number;
  rows: number;
  width: number;
  height: number;
  status: "running" | "generated" | "applied" | "failed" | "interrupted";
  createdAt: string;
  updatedAt: string;
  error?: string;
  sheetId?: string;
  generationItemId?: string;
  referenceHashes?: string[];
  referencesVerified?: boolean;
  beforeSnapshotId?: string;
  afterSnapshotId?: string;
};
export const interpolationSchema = z.object({
  requestId: z.string().uuid(),
  clipId: z.string().uuid(),
  revision: z.string(),
  startFrameId: z.string().uuid(),
  endFrameId: z.string().uuid(),
  count: z.number().int().min(1).max(8),
  timingPolicy: z.enum(["preserve-duration", "fps"]).default("preserve-duration"),
  interiorPolicy: z.enum(["preserve", "replace"]).default("preserve"),
  fps: z.number().min(1).max(60).default(12),
  description: z.string().trim().min(1).max(2000),
});
export const interpolationLayoutSchema = z.object({
  columns: z.number().int().min(1).max(10),
  rows: z.number().int().min(1).max(10),
  includesEndpoints: z.boolean().default(true),
  timingPolicy: z.enum(["preserve-duration", "fps"]).optional(),
  interiorPolicy: z.enum(["preserve", "replace"]).optional(),
  fps: z.number().min(1).max(60).optional(),
});
export type InterpolationLayout = z.infer<typeof interpolationLayoutSchema>;
export function interpolationGrid(count: number) {
  const cells = count + 2;
  let rows = Math.floor(Math.sqrt(cells));
  while (cells % rows) rows--;
  return { columns: cells / rows, rows };
}
export const transformSchema = z.object({
  scale: z.number().min(0.05).max(4).default(1),
  offsetX: z.number().min(-4096).max(4096).default(0),
  offsetY: z.number().min(-4096).max(4096).default(0),
  width: z.number().int().min(1).max(4096).optional(),
  height: z.number().int().min(1).max(4096).optional(),
  clip: z.boolean().default(false),
});
export type Transform = z.infer<typeof transformSchema>;
export const clipReferenceSchema = z.object({
  clipId: z.string().uuid(),
  revision: z.string(),
  startFrameId: z.string().uuid().optional(),
  endFrameId: z.string().uuid().optional(),
});
export type ClipReference = z.infer<typeof clipReferenceSchema>;
export type ClipAttachment = ClipReference & {
  snapshotId: string;
  name: string;
};
export type ClipSnapshot = {
  renderMode?: "preview";
  id: string;
  projectId: string;
  createdAt: string;
  clip: ClipAsset;
  images: Record<
    string,
    Pick<ImageAsset, "id" | "mime" | "contentHash" | "width" | "height">
  >;
};
export type FrameObservation = {
  frameId: string;
  index: number;
  durationUs: number;
  bbox: [number, number, number, number] | null;
  center: [number, number] | null;
  width: number;
  height: number;
};
export type ClipReview = {
  warnings?: RenderWarning[];
  draftId?: string;
  documentRevision?: string;
  id: string;
  projectId: string;
  snapshotId: string;
  clipId: string;
  clipRevision: string;
  createdAt: string;
  startFrameId: string;
  endFrameId: string;
  frames: FrameObservation[];
  pairs: { from: number; to: number; loopBoundary: boolean }[];
  files: { contact: string; onion: string };
  hashes: { contact: string; onion: string };
  stale?: boolean;
};
export type FrameChange = {
  frameIds?: string[];
  id: string;
  projectId: string;
  clipId: string;
  frameId: string;
  baseSnapshotId: string;
  legacyClipId?: string;
  createdAt: string;
  updatedAt: string;
  source: "agent" | "human";
  status: "pending" | "applied" | "reverted" | "archived";
  transform?: Transform;
  durationUs?: number;
  afterSnapshotId?: string;
  resultFrames?: ClipFrame[];
};
export const frameAdjustmentSchema = z
  .object({
    requestId: z.string().uuid(),
    clipId: z.string().uuid(),
    revision: z.string(),
    frameId: z.string().uuid(),
    transform: transformSchema
      .omit({ width: true, height: true })
      .strict()
      .optional(),
    durationUs: z.number().int().min(1000).max(60_000_000).optional(),
  })
  .refine(
    (input) => input.transform !== undefined || input.durationUs !== undefined,
    "请提供位置、缩放或时长调整",
  );
export function snapshotFrameUrl(
  projectId: string,
  snapshotId: string,
  frameId: string,
) {
  return `/api/projects/${projectId}/snapshots/${snapshotId}/images/${frameId}`;
}
export const sliceSchema = z
  .object({
    columns: z.number().int().min(1).max(32),
    rows: z.number().int().min(1).max(32),
    fps: z.number().min(1).max(60).default(12),
    name: z.string().trim().min(1).max(100).optional(),
  })
  .refine((data) => data.columns * data.rows <= 128, "一次最多切割 128 帧");
export const clipSchema = z.object({
  revision: z.string(),
  frames: z
    .array(
      z.object({
        id: z.string().uuid(),
        imageId: z.string().uuid(),
        durationUs: z.number().int().min(1000).max(60_000_000),
        transform: frameTransformSchema.optional(),
      }),
    )
    .max(128),
  loop: z.boolean(),
  initialFps: z.number().min(1).max(60).optional(),
});
export function assetUrl(
  projectId: string,
  imageId: string,
  revision?: string,
): string {
  return `/api/projects/${projectId}/images/${imageId}${revision ? `?v=${revision}` : ""}`;
}
export function clipFrameUrl(
  projectId: string,
  clip: ClipAsset,
  frame: ClipFrame,
  imageRevision?: string,
) {
  return `/api/projects/${projectId}/clips/${clip.id}/frames/${frame.id}/image?v=${clip.revision}&imageRevision=${imageRevision || ""}`;
}
