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
  };
};
export type ClipFrame = { id: string; imageId: string; durationUs: number };
export type ClipAsset = {
  id: string;
  type: "clip";
  name: string;
  revision: string;
  createdAt: string;
  frames: ClipFrame[];
  loop: boolean;
  origin?: { assetId: string; revision: string };
};
export type Asset = ImageAsset | ClipAsset;
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  assetIds: string[];
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
};
export const transformSchema = z.object({
  scale: z.number().min(0.05).max(4).default(1),
  offsetX: z.number().min(-4096).max(4096).default(0),
  offsetY: z.number().min(-4096).max(4096).default(0),
  width: z.number().int().min(1).max(4096).optional(),
  height: z.number().int().min(1).max(4096).optional(),
  clip: z.boolean().default(false),
});
export type Transform = z.infer<typeof transformSchema>;
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
