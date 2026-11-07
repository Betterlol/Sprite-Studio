import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { z } from "zod";
import { sha256, StudioError, type ProjectStore } from "./store.ts";
import { detectionSchema, inspectSheetSchema, SHEET_ALGORITHM, type InspectSheetInput, type SheetRect } from "./sheet-schema.ts";

export type SheetInspection = {
  id: string; action: "detect" | "preview"; assetId: string; sourceRevision: string; sourceContentHash: string;
  algorithmVersion?: string; parameterHash?: string; detection?: z.infer<typeof detectionSchema>;
  total: number; offset?: number; limit: number; start?: number; end?: number;
  candidates?: { key: string; box: number[]; pixelCount: number }[];
  rectangles?: SheetRect[]; frames?: { index: number; name: string; box: number[]; scaledSize: number[]; offset: number[]; overflow: Record<string, number>; blocking: boolean }[];
  width?: number; height?: number; blocking?: boolean; suggestedOutput?: { width: number; height: number };
  discardedCount?: number; discardedPixels?: number; diagnostics: { code: string; message: string }[];
  images: { hash: string; url: string }[];
};
type Cached = { info: Omit<SheetInspection, "assetId" | "sourceRevision" | "images">; allKeys?: string[]; images: string[] };
export function detectionKey(sourceContentHash: string, detection: z.infer<typeof detectionSchema>) {
  return sha256(JSON.stringify(["sheet-analysis-v2", sourceContentHash, SHEET_ALGORITHM, detection]));
}
/** Fully decode worker PNGs, rather than trusting reported dimensions or an IHDR. */
export async function checkedPng(store: ProjectStore, file: string, stage: string, width?: number, height?: number) {
  if (dirname(resolve(file)) !== resolve(stage)) throw new StudioError("图像处理输出不在当前暂存目录");
  const bytes = readFileSync(file);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new StudioError("图像处理未返回PNG");
  const decoded = await store.worker.run("inspect", { path: file });
  if (!bytes.equals(readFileSync(file))) throw new StudioError("图像处理输出在解码期间变化", 409);
  if (decoded.frameCount !== 1 || (width !== undefined && decoded.width !== width) || (height !== undefined && decoded.height !== height)) throw new StudioError("图像处理输出解码尺寸不符");
  return bytes;
}
export class SheetInspectionService {
  store: ProjectStore;
  constructor(store: ProjectStore) { this.store = store; }
  private cachePath(pid: string, id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new StudioError("切割检查不存在", 404);
    return this.store.safePath(pid, `.studio/sheet-inspections/${id}.json`);
  }
  private cached(pid: string, id: string): Cached | undefined {
    try {
      const envelope = JSON.parse(readFileSync(this.cachePath(pid, id), "utf8"));
      if (envelope.hash !== sha256(JSON.stringify(envelope.value))) return;
      const value = envelope.value as Cached;
      if (value.info.id !== id) return;
      for (const hash of value.images) this.imagePath(pid, hash);
      return value;
    } catch { return; }
  }
  validateComponents(pid: string, sourceHash: string, slicing: { sourceContentHash: string; algorithmVersion: string; detection: z.infer<typeof detectionSchema>; items: { componentKeys: string[] }[] }) {
    if (slicing.sourceContentHash !== sourceHash || slicing.algorithmVersion !== SHEET_ALGORITHM) throw new StudioError("STALE_ANALYSIS：来源或算法已变化，请重新检测并显式修复成员", 409);
    const saved = this.cached(pid, detectionKey(sourceHash, slicing.detection));
    if (!saved?.allKeys) throw new StudioError("STALE_ANALYSIS：请先按当前来源和参数执行只读检测", 409);
    const keys = new Set(saved.allKeys);
    if (slicing.items.some(item => item.componentKeys.some(key => !keys.has(key)))) throw new StudioError("STALE_ANALYSIS：组件key不属于当前检测，请重新检测并显式分组", 409);
  }
  async inspect(pid: string, input: InspectSheetInput): Promise<SheetInspection> {
    const spec = inspectSheetSchema.parse(input);
    return this.store.reading(pid, async () => {
      const source = this.store.image(pid, spec.assetId);
      if (source.frameCount !== 1 || source.producer) throw new StudioError("请选择静态原图检查切割");
      const sourcePath = this.store.imagePath(pid, source.id, spec.expectedSourceRevision);
      if (source.width * source.height > 16_777_216) throw new StudioError("源图像素预算超限");
      const recipe = spec.action === "preview" ? this.store.sheets.parse(pid, source.id, spec.text, "inspect") : undefined;
      if (spec.action === "preview" && spec.start > recipe!.slicing.items.filter(item => item.enabled).length) throw new StudioError("预览批次起点超出启用帧数");
      const id = sha256(JSON.stringify(["sheet-inspect-v2", source.contentHash, spec.action === "detect" ? [spec.detection, spec.offset, spec.limit] : [recipe, spec.start, spec.limit]]));
      let cached = this.cached(pid, id);
      if (!cached) {
        const stage = this.store.stage(pid);
        const result = await this.store.worker.run(spec.action === "detect" ? "sheet_detect" : "sheet_preview", {
          path: sourcePath, outputDir: stage,
          ...(spec.action === "detect" ? { detection: spec.detection, offset: spec.offset, limit: spec.limit } : { ...recipe!.slicing, recipeVersion: recipe!.schemaVersion, start: spec.start, limit: spec.limit }),
        }).catch(error => { this.store.imagePath(pid, source.id, spec.expectedSourceRevision); if (String(error.message).includes("STALE_ANALYSIS")) throw new StudioError(error.message, 409); throw error; });
        this.store.imagePath(pid, source.id, spec.expectedSourceRevision);
        const validBox = (box: unknown) => Array.isArray(box) && box.length === 4 && box.every(Number.isInteger) && box[0] >= 0 && box[1] >= 0 && box[0] < box[2] && box[1] < box[3] && box[2] <= source.width && box[3] <= source.height;
        if (spec.action === "detect") {
          const parameterHash = sha256(JSON.stringify(spec.detection)); // Zod uses canonical alphaThreshold/minComponentPixels order.
          if (result.algorithmVersion !== SHEET_ALGORITHM || result.parameterHash !== parameterHash || JSON.stringify(result.detection) !== JSON.stringify(spec.detection) ||
            !Number.isInteger(result.total) || result.total < 0 || result.total > 4096 || !Array.isArray(result.allKeys) || result.allKeys.length !== result.total ||
            new Set(result.allKeys).size !== result.total || result.allKeys.some((key: unknown) => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) ||
            result.offset !== spec.offset || result.limit !== spec.limit || !Array.isArray(result.candidates) || result.candidates.length !== Math.min(spec.limit,Math.max(0,result.total-spec.offset)) ||
            result.candidates.some((candidate: any,index: number) => candidate.key !== result.allKeys[spec.offset+index] || !validBox(candidate.box) || !Number.isInteger(candidate.pixelCount) || candidate.pixelCount < 1 || candidate.pixelCount > source.width*source.height))
            throw new StudioError("图像处理返回无效连通候选协议");
        } else {
          const indexes = recipe!.slicing.items.flatMap((item,index) => item.enabled ? [index] : []), end = Math.min(indexes.length,spec.start+spec.limit);
          if (result.total !== indexes.length || result.start !== spec.start || result.end !== end || result.limit !== spec.limit ||
            !Array.isArray(result.frames) || JSON.stringify(result.frames.map((frame: any) => frame.index)) !== JSON.stringify(indexes.slice(spec.start,end)) ||
            !Array.isArray(result.rectangles) || result.rectangles.length !== recipe!.slicing.items.length || result.rectangles.some((rect: any,index: number) => rect.index !== index || !validBox(rect.box)))
            throw new StudioError("图像处理返回无效切割预览批次协议");
        }
        if (!Array.isArray(result.files) || result.files.length !== 1) throw new StudioError("切割检查证据数量不符");
        const bytes = await checkedPng(this.store, result.files[0], stage).catch(error => { this.store.imagePath(pid, source.id, spec.expectedSourceRevision); throw error; });
        this.store.imagePath(pid, source.id, spec.expectedSourceRevision);
        const folder = this.store.safePath(pid, ".studio/sheet-inspections");
        mkdirSync(folder, { recursive: true });
        const hash = sha256(bytes), target = join(folder, hash + ".png");
        if (existsSync(target) && sha256(readFileSync(target)) !== hash) throw new StudioError("不可变检查图片已改变", 409);
        if (!existsSync(target)) writeFileSync(target, bytes, { flag: "wx" });
        const { files, allKeys, ...info } = result;
        cached = { info: { ...info, id, action: spec.action, sourceContentHash: source.contentHash }, images: [hash], ...(allKeys ? { allKeys } : {}) };
        const value = JSON.stringify(cached);
        // Immutable, content-checked cache only: no project assets, recipe, journals or clips.
        writeFileSync(this.cachePath(pid, id), JSON.stringify({ hash: sha256(value), value: cached }));
        // Any detection page also seeds the complete key manifest used by synchronous prepare.
        if (spec.action === "detect" && id !== detectionKey(source.contentHash, spec.detection)) {
          // Do not mislabel a paginated overlay as the first page. Store the key manifest separately.
          const manifestId = detectionKey(source.contentHash, spec.detection);
          if (!this.cached(pid, manifestId)) {
            const manifest: Cached = { ...cached, info: { ...cached.info, id: manifestId } };
            writeFileSync(this.cachePath(pid, manifestId), JSON.stringify({ hash: sha256(JSON.stringify(manifest)), value: manifest }));
          }
        }
      }
      this.store.imagePath(pid, source.id, spec.expectedSourceRevision);
      return { ...cached.info, assetId: source.id, sourceRevision: source.revision,
        images: cached.images.map(hash => ({ hash, url: `/api/projects/${pid}/sheet-inspections/${hash}/image` })) } as SheetInspection;
    });
  }
  imagePath(pid: string, hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new StudioError("检查图片不存在", 404);
    const path = this.store.safePath(pid, `.studio/sheet-inspections/${hash}.png`);
    if (!existsSync(path)) throw new StudioError("检查图片不存在", 404);
    if (sha256(readFileSync(path)) !== hash) throw new StudioError("检查图片已改变，请重新检查", 409);
    return path;
  }
}
