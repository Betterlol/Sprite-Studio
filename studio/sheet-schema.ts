import { z } from "zod";
const dimension = z.number().int().min(1).max(32);
const pixel = z.number().int().min(0).max(4096);
export const sheetRecipeSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("sheet-recipe"),
    slicing: z
      .object({
        method: z.literal("grid"),
        grid: z
          .object({
            columns: dimension,
            rows: dimension,
            margin: z
              .tuple([pixel, pixel, pixel, pixel])
              .describe("Integer source pixels: top, right, bottom, left"),
            spacing: z
              .tuple([pixel, pixel])
              .describe("Integer source pixels: horizontal gap, vertical gap"),
          })
          .strict(),
        items: z
          .array(
            z
              .object({
                id: z
                  .string()
                  .uuid()
                  .optional()
                  .describe(
                    "Omit for new slices; preserve returned ID on later edits",
                  ),
                cell: z
                  .tuple([pixel, pixel])
                  .describe("Zero-based column, row"),
                name: z.string().min(1).max(70),
                enabled: z.boolean(),
              })
              .strict(),
          )
          .max(128),
        outputFolder: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict();
export type SheetRecipe = z.infer<typeof sheetRecipeSchema>;
