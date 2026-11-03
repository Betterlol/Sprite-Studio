import { z } from "zod";
export const roleSchema = z.enum(["reference", "source", "candidate"]);
export type AssetRole = z.infer<typeof roleSchema>;
export type Project = {
  id: string;
  name: string;
  createdAt: string;
  version: 1;
};
export type ImageAsset = {
  folder?: string;
  id: string;
  type: "image";
  name: string;
  role: AssetRole;
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
export type ClipFrame = { id: string; imageId: string; durationUs: number };
export type ClipAsset = {
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
  id: string;
  role: "user" | "assistant";
  text: string;
  displayText?: string;
  assetIds: string[];
  clipReferences?: ClipAttachment[];
  reviewIds?: string[];
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
export type PendingPrompt = { id: string; questions: PromptQuestion[] };
export type Session = {
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
  status:
    | "running"
    | "candidate"
    | "preview"
    | "applied"
    | "failed"
    | "interrupted";
  createdAt: string;
  updatedAt: string;
  error?: string;
  sheetId?: string;
  generationItemId?: string;
  referenceHashes?: string[];
  referencesVerified?: boolean;
  prepared?: {
    clipId: string;
    clipRevision: string;
    spec: InterpolationLayout;
  };
};
export const interpolationSchema = z.object({
  requestId: z.string().uuid(),
  clipId: z.string().uuid(),
  revision: z.string(),
  startFrameId: z.string().uuid(),
  endFrameId: z.string().uuid(),
  count: z.number().int().min(1).max(8),
  fps: z.number().min(1).max(60).default(12),
  description: z.string().trim().min(1).max(2000),
});
export const interpolationLayoutSchema = z.object({
  columns: z.number().int().min(1).max(10),
  rows: z.number().int().min(1).max(10),
  includesEndpoints: z.boolean().default(true),
  fps: z.number().min(1).max(60),
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
  id: string;
  projectId: string;
  clipId: string;
  frameId: string;
  baseSnapshotId: string;
  candidateClipId: string;
  createdAt: string;
  updatedAt: string;
  source: "agent" | "human";
  status: "draft" | "applied" | "reverted" | "discarded";
  transform?: Transform;
  durationUs?: number;
  appliedSnapshotId?: string;
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
      }),
    )
    .min(1)
    .max(128),
  loop: z.boolean(),
});
export function assetUrl(
  projectId: string,
  imageId: string,
  revision?: string,
): string {
  return `/api/projects/${projectId}/images/${imageId}${revision ? `?v=${revision}` : ""}`;
}
