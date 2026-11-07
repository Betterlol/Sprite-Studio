import { z } from "zod";
const dimension = z.number().int().min(1).max(32);
const pixel = z.number().int().min(0).max(4096);
// Do not change v1 defaults or normalization: its serialized definition is a cache key.
export const sheetRecipeV1Schema = z.object({
  schemaVersion: z.literal(1), type: z.literal("sheet-recipe"),
  slicing: z.object({
    method: z.literal("grid"),
    grid: z.object({ columns: dimension, rows: dimension,
      margin: z.tuple([pixel, pixel, pixel, pixel]).describe("Integer source pixels: top, right, bottom, left"),
      spacing: z.tuple([pixel, pixel]).describe("Integer source pixels: horizontal gap, vertical gap"),
    }).strict(),
    items: z.array(z.object({
      id: z.string().uuid().optional().describe("Omit for new slices; preserve returned ID on later edits"),
      cell: z.tuple([pixel, pixel]).describe("Zero-based column, row"),
      name: z.string().min(1).max(70), enabled: z.boolean(),
    }).strict()).max(128),
    outputFolder: z.string().min(1).max(500),
  }).strict(),
}).strict();
export const SHEET_ALGORITHM = "alpha-runs-8-v1";
// A complete 4096-key explicit grouping exceeds the legacy 256 KiB text budget.
export const MAX_SHEET_V2_BYTES = 512 * 1024;
export const detectionSchema = z.object({
  alphaThreshold: z.number().int().min(0).max(255).default(16),
  minComponentPixels: z.number().int().min(1).max(16_777_216).default(1),
}).strict();
export const sheetOutputSchema = z.object({
  width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096),
  scale: z.number().min(0.05).max(4).default(1),
  alignment: z.enum(["center", "bottom-center"]).default("center"),
}).strict();
const commonItem = { id: z.string().uuid().optional(), name: z.string().min(1).max(70), enabled: z.boolean() };
const common = {
  output: sheetOutputSchema, outputFolder: z.string().min(1).max(500),
  expectedFrames: z.number().int().min(1).max(128).optional(),
};
const coordinate = z.number().int().min(0).max(16_777_216);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sheetRecipeV2Schema = z.object({
  schemaVersion: z.literal(2), type: z.literal("sheet-recipe"),
  slicing: z.discriminatedUnion("method", [
    z.object({ method: z.literal("grid"), ...common, grid: sheetRecipeV1Schema.shape.slicing.shape.grid,
      items: z.array(z.object({ ...commonItem, cell: z.tuple([pixel, pixel]) }).strict()).max(128),
    }).strict(),
    z.object({ method: z.literal("boxes"), ...common,
      items: z.array(z.object({ ...commonItem, box: z.tuple([coordinate, coordinate, coordinate, coordinate]).describe("Source pixel half-open rectangle [left,top,right,bottom]") }).strict()).max(128),
    }).strict(),
    z.object({ method: z.literal("components"), ...common,
      sourceContentHash: hash, algorithmVersion: z.string().min(1).max(80), detection: detectionSchema,
      items: z.array(z.object({ ...commonItem, componentKeys: z.array(hash).min(1).max(4096) }).strict()).max(128),
    }).strict(),
  ]),
}).strict();
export const sheetRecipeSchema = z.union([sheetRecipeV1Schema, sheetRecipeV2Schema]);
export type SheetRecipeV1 = z.infer<typeof sheetRecipeV1Schema>;
export type SheetRecipeV2 = z.infer<typeof sheetRecipeV2Schema>;
export type SheetRecipe = z.infer<typeof sheetRecipeSchema>;
export type SheetGrid = SheetRecipeV1["slicing"]["grid"];
export type SheetRect = { box: number[]; index: number; key?: string; name?: string; enabled?: boolean };
export const inspectSheetSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("detect"), assetId: z.string().uuid(), expectedSourceRevision: z.string(),
    detection: detectionSchema.default({ alphaThreshold: 16, minComponentPixels: 1 }),
    offset: z.number().int().min(0).max(4096).default(0), limit: z.number().int().min(1).max(128).default(128),
  }).strict(),
  z.object({ action: z.literal("preview"), assetId: z.string().uuid(), expectedSourceRevision: z.string(),
    text: z.string().max(MAX_SHEET_V2_BYTES), start: z.number().int().min(0).max(128).default(0),
    limit: z.number().int().min(1).max(16).default(16),
  }).strict(),
]);
export type InspectSheetInput = z.input<typeof inspectSheetSchema>;
