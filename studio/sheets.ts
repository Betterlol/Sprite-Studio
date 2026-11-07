import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { entryName } from "./library.ts";
import { publishFiles } from "./file-operations.ts";
import {
  sha256,
  StudioError,
  assetRevision,
  type ProjectStore,
} from "./store.ts";
import type { ImageAsset } from "./model.ts";

import { sheetRecipeSchema, SHEET_ALGORITHM, MAX_SHEET_V2_BYTES, type SheetRecipe } from "./sheet-schema.ts";
import { checkedPng } from "./sheet-inspection.ts";
import { join } from "node:path";
export type { SheetRecipe } from "./sheet-schema.ts";
export type SheetDocument = {
  documentId: string;
  path: string;
  text: string;
  documentRevision: string;
  definitionRevision: string;
  exists: boolean;
  recipe: SheetRecipe;
  status: "unconfigured" | "dirty" | "ready";
  outputIds: string[];
};
type SliceReceipt = {
  key: string;
  definitionRevision: string;
  sourceRevision: string;
  outputIds: string[];
  requestId: string;
};
const jsonBytes = (value: unknown) =>
  Buffer.from(JSON.stringify(value, null, 2) + "\n");
export class SheetDocuments {
  store: ProjectStore;
  running = new Map<string, Promise<SliceReceipt>>();
  constructor(store: ProjectStore) {
    this.store = store;
  }
  revision(pid: string) {
    return sha256(
      JSON.stringify(
        this.store
          .assets(pid)
          .filter(
            (asset) =>
              asset.type === "image" &&
              !asset.producer &&
              asset.frameCount === 1,
          )
          .map((asset) => {
            const file = this.store.safePath(pid, asset.file! + ".recipe.json");
            return [
              asset.id,
              existsSync(file) ? sha256(readFileSync(file)) : "missing",
            ];
          }),
      ),
    );
  }
  private source(pid: string, id: string) {
    const image = this.store.image(pid, id);
    if (image.frameCount !== 1 || image.producer)
      throw new StudioError("请为静态原图配置切割，不对切片重复建立切割来源");
    return image;
  }
  private path(pid: string, id: string) {
    return this.source(pid, id).file + ".recipe.json";
  }
  private receiptPath(id: string) {
    return `.studio/slicing/${id}.json`;
  }
  private receipt(pid: string, id: string): SliceReceipt | undefined {
    const path = this.store.safePath(pid, this.receiptPath(id));
    return existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : undefined;
  }
  read(pid: string, id: string): SheetDocument {
    const source = this.source(pid, id),
      path = this.path(pid, id),
      full = this.store.safePath(pid, path),
      exists = existsSync(full);
    const fallback: SheetRecipe = {
      schemaVersion: 1,
      type: "sheet-recipe",
      slicing: {
        method: "grid",
        grid: {
          columns: Math.min(4, source.width),
          rows: 1,
          margin: [0, 0, 0, 0],
          spacing: [0, 0],
        },
        items: [],
        outputFolder: `原图素材/${source.id.slice(0, 8)}-切片`,
      },
    };
    const text = exists
      ? readFileSync(full, "utf8")
      : jsonBytes(fallback).toString();
    const recipe = this.parse(pid, id, text, "read"),
      definitionRevision = sha256(JSON.stringify(recipe)),
      receipt = this.receipt(pid, id);
    const outputsExist = receipt?.outputIds.every((outputId) => {
      try {
        this.store.imagePath(pid, outputId);
        return true;
      } catch {
        return false;
      }
    });
    return {
      documentId: id,
      path,
      text,
      exists,
      documentRevision: exists ? sha256(text) : "missing",
      definitionRevision,
      recipe,
      status: !exists
        ? "unconfigured"
        : (recipe.slicing.method !== "components" || (recipe.slicing.sourceContentHash === source.contentHash && recipe.slicing.algorithmVersion === SHEET_ALGORITHM)) &&
            receipt?.definitionRevision === definitionRevision &&
            receipt.sourceRevision === source.revision &&
            outputsExist
          ? "ready"
          : "dirty",
      outputIds:
        receipt?.outputIds.filter((outputId) =>
          this.store.indexes.get(pid)?.has(outputId),
        ) || [],
    };
  }
  parse(pid: string, id: string, text: string, mode: "read" | "inspect" | "save" | "execute" = "save"): SheetRecipe {
    if (Buffer.byteLength(text) > MAX_SHEET_V2_BYTES)
      throw new StudioError("配置文件超过 512 KB");
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new StudioError("INVALID_DOCUMENT：配置不是有效 JSON"); }
    const checked = sheetRecipeSchema.safeParse(value);
    if (!checked.success) throw new StudioError("INVALID_DOCUMENT：" + checked.error.issues.map(issue => `/${issue.path.join("/")} ${issue.message}`).join("；"));
    const recipe = checked.data, slicing = recipe.slicing, source = this.source(pid, id);
    if (recipe.schemaVersion === 1 && Buffer.byteLength(text) > 256 * 1024) throw new StudioError("配置文件超过 256 KB");
    const { items, outputFolder } = slicing;
    if (!(outputFolder === "原图素材" || outputFolder.startsWith("原图素材/"))) throw new StudioError("切片目录必须位于原图素材分类");
    outputFolder.split("/").forEach(entryName);
    this.store.safePath(pid, `Assets/${outputFolder}`);
    const ids = new Set<string>(), cells = new Set<string>();
    for (const item of items) {
      const keys = new Set<string>();
      entryName(item.name);
      if (item.id && ids.has(item.id)) throw new StudioError("切片 ID 不能重复");
      if (item.id) ids.add(item.id);
      if ("cell" in item && slicing.method === "grid") {
        if (item.cell[0] >= slicing.grid.columns || item.cell[1] >= slicing.grid.rows) throw new StudioError("切片单元超出网格");
        const cell = item.cell.join(",");
        if (cells.has(cell)) throw new StudioError("网格单元不能重复，请保留原切片 ID");
        cells.add(cell);
      }
      if ("box" in item) {
        const [l,t,r,b] = item.box;
        if (!(l < r && t < b) || (mode !== "read" && (r > source.width || b > source.height))) throw new StudioError("矩形超出原图或为空");
      }
      if ("componentKeys" in item) for (const key of item.componentKeys) {
        if (keys.has(key)) throw new StudioError("同一分组的组件key不能重复");
        keys.add(key);
      }
    }
    if (slicing.method === "grid") {
      const grid = slicing.grid;
      if (grid.columns * grid.rows > 128) throw new StudioError("一次最多切割128格");
      const [top,right,bottom,left] = grid.margin, [gx,gy] = grid.spacing;
      if (source.width-left-right-gx*(grid.columns-1) < grid.columns || source.height-top-bottom-gy*(grid.rows-1) < grid.rows) throw new StudioError("边距、间距或网格数量使切片小于一个像素");
    }
    if (mode !== "read" && source.width*source.height > 16_777_216) throw new StudioError("源图像素预算超限");
    if ("output" in slicing && slicing.output.width*slicing.output.height*items.filter(i => i.enabled).length > 67_108_864) throw new StudioError("输出总解码像素预算超限");
    if (slicing.method === "components" && mode === "save") this.store.sheetInspection.validateComponents(pid, source.contentHash, slicing);
    if (slicing.method === "components" && mode === "execute" && (slicing.sourceContentHash !== source.contentHash || slicing.algorithmVersion !== SHEET_ALGORITHM)) throw new StudioError("STALE_ANALYSIS：来源或算法已变化，请重新检测", 409);
    if (mode === "save" || mode === "execute") {
      this.checkIdentity(pid, id, recipe);
      this.checkReferences(pid, id, recipe);
    }
    return recipe;
  }
  private checkIdentity(pid: string, id: string, recipe: SheetRecipe) {
    const owned = new Set<string>();
    const currentPath = this.store.safePath(pid, this.path(pid, id));
    if (existsSync(currentPath)) {
      // Existing membership is the authority for an edited logical frame, not geometry/name.
      const old = sheetRecipeSchema.safeParse(JSON.parse(readFileSync(currentPath, "utf8")));
      if (old.success) for (const item of old.data.slicing.items) if (item.id) owned.add(item.id);
    }
    for (const asset of this.store.assets(pid)) if (asset.type === "image" && asset.producer?.sheetId === id) owned.add(asset.producer.sliceId);
    for (const item of recipe.slicing.items) if (item.id && !owned.has(item.id)) throw new StudioError("切片 ID 不属于当前来源；新条目请省略 ID", 409);
  }
  private checkReferences(pid: string, id: string, recipe: SheetRecipe) {
    const active = new Set(
      recipe.slicing.items
        .filter((item) => item.enabled && item.id)
        .map((item) => item.id),
    );
    const removed = this.store
      .assets(pid)
      .filter(
        (asset) =>
          asset.type === "image" &&
          asset.producer?.sheetId === id &&
          !active.has(asset.producer.sliceId),
      );
    if (!removed.length) return;
    const plan = this.store.library.planDelete(pid, {
      assetIds: removed.map((asset) => asset.id),
      folders: [],
    });
    if (plan.blockers.length)
      throw new StudioError(
        "MISSING_REFERENCE：不能移除或停用仍被使用的切片：" +
          plan.blockers.map((b) => b.name + "：" + b.reason).join("；"),
        409,
      );
  }
  write(
    pid: string,
    documents: {
      documentId: string;
      expectedDocumentRevision: string;
      text: string;
    }[],
  ) {
    if (
      !documents.length ||
      documents.length > 16 ||
      new Set(documents.map((d) => d.documentId)).size !== documents.length
    )
      throw new StudioError("每次提交1至16份不同的配置");
    const writes = documents.map((input) => this.prepare(pid, input));
    publishFiles(this.store, pid, writes, {
      kind: "save-config",
      documentIds: documents.map((d) => d.documentId),
    });
    return documents.map((d) => this.read(pid, d.documentId));
  }
  prepare(
    pid: string,
    input: {
      documentId: string;
      expectedDocumentRevision: string;
      text: string;
    },
  ) {
    const current = this.read(pid, input.documentId);
    if (current.documentRevision !== input.expectedDocumentRevision)
      throw new StudioError(
        "VERSION_CONFLICT：配置已变化，请重新读取；本地草稿已保留",
        409,
      );
    const recipe = this.parse(pid, input.documentId, input.text);
    for (const item of recipe.slicing.items) item.id ??= randomUUID();
    return { path: current.path, bytes: jsonBytes(recipe) };
  }
  schema() {
    return z.toJSONSchema(sheetRecipeSchema);
  }
  execute(
    pid: string,
    id: string,
    expected: string,
    requestId: string,
  ): Promise<SliceReceipt> {
    z.string().uuid().parse(requestId);
    const key = `${pid}:${id}`;
    if (this.running.has(key))
      return Promise.reject(
        new StudioError("RESOURCE_BUSY：此原图正在切割", 409),
      );
    const promise = this.store
      .reading(pid, () => this.build(pid, id, expected, requestId))
      .finally(() => this.running.delete(key));
    this.running.set(key, promise);
    return promise;
  }
  private async build(
    pid: string,
    id: string,
    expected: string,
    requestId: string,
  ): Promise<SliceReceipt> {
    const doc = this.read(pid, id),
      source = this.source(pid, id);
    if (!doc.exists || doc.definitionRevision !== expected)
      throw new StudioError(
        "VERSION_CONFLICT：请先保存配置，并基于当前配置执行",
        409,
      );
    if (!doc.recipe.slicing.items.some((item) => item.enabled))
      throw new StudioError("请先选择要切割的条目");
    const sourcePath = this.store.imagePath(pid, id, source.revision);
    this.parse(pid, id, doc.text, "execute");
    const key = sha256(
        JSON.stringify([
          doc.definitionRevision,
          source.revision,
          source.contentHash,
          doc.recipe.schemaVersion === 1 ? "grid-v1" : "sheet-v2-alpha-runs-8-v1",
        ]),
      ),
      receipt = this.receipt(pid, id);
    const requestPath = `.studio/slice-requests/${requestId}.json`,
      fullRequest = this.store.safePath(pid, requestPath);
    if (existsSync(fullRequest)) {
      const old = JSON.parse(readFileSync(fullRequest, "utf8"));
      if (old.sourceId !== id || old.key !== key)
        throw new StudioError(
          "VERSION_CONFLICT：同一请求 ID 不能执行不同配置",
          409,
        );
      return old.receipt;
    }
    if (receipt?.key === key && doc.status === "ready") {
      publishFiles(
        this.store,
        pid,
        [
          {
            path: requestPath,
            bytes: jsonBytes({ sourceId: id, key, receipt }),
          },
        ],
        { kind: "cached-slice" },
      );
      return receipt;
    }
    const children = this.store.assets(pid).filter((asset): asset is ImageAsset => asset.type === "image" && asset.producer?.sheetId === id);
    const active = doc.recipe.slicing.items.filter(item => item.enabled);
    const destination = (item: { id?: string; name: string }) => {
      const old = children.find(asset => asset.producer!.sliceId === item.id),
        folder = old?.folder || doc.recipe.slicing.outputFolder,
        name = old?.name || `${item.name}-${item.id!.slice(0, 8)}.png`,
        file = old?.file || `Assets/${folder}/${name}`,
        meta = old ? this.store.metaPath(pid, old.id) : file + ".meta.json";
      return { old, folder, name, file, meta };
    };
    const fileBaselines = new Map<string,string>();
    const track = (path: string) => {
      if (fileBaselines.has(path)) return;
      const full = this.store.safePath(pid,path);
      fileBaselines.set(path,existsSync(full) ? sha256(readFileSync(full)) : "missing");
    };
    for (const child of children) {
      this.store.imagePath(pid, child.id, child.revision);
      track(child.file!); track(this.store.metaPath(pid,child.id));
    }
    for (const item of active) {
      const {old,file,meta} = destination(item);
      if (!old && (existsSync(this.store.safePath(pid,file)) || existsSync(this.store.safePath(pid,meta)))) throw new StudioError("输出位置已有同名文件，请修改切片名称",409);
      track(file); track(meta);
    }
    const baseline = JSON.stringify(children.map(a => [a.id, a.revision, a.file]));
    const recheck = () => {
      if (this.read(pid, id).definitionRevision !== expected || this.source(pid, id).revision !== source.revision) throw new StudioError("VERSION_CONFLICT：切割期间配置或来源发生变化，未发布旧结果", 409);
      this.store.imagePath(pid, id, source.revision);
      const current = this.store.assets(pid).filter((asset): asset is ImageAsset => asset.type === "image" && asset.producer?.sheetId === id);
      if (baseline !== JSON.stringify(current.map(a => [a.id, a.revision, a.file]))) throw new StudioError("VERSION_CONFLICT：切割期间输出发生变化", 409);
      for (const child of children) this.store.imagePath(pid, child.id, child.revision);
      for (const [path,expectedHash] of fileBaselines) {
        const full = this.store.safePath(pid,path), hash = existsSync(full) ? sha256(readFileSync(full)) : "missing";
        if (hash !== expectedHash) throw new StudioError("VERSION_CONFLICT：切割输出路径或元数据在发布前变化",409);
      }
      this.parse(pid, id, doc.text, "execute");
    };
    const stage = this.store.stage(pid);
    const result = await this.store.worker.run("recipe_slice", {
      path: sourcePath, outputDir: stage, recipeVersion: doc.recipe.schemaVersion, ...doc.recipe.slicing,
    }).catch(error => { recheck(); if (String(error.message).includes("STALE_ANALYSIS")) throw new StudioError(error.message, 409); throw error; });
    recheck();
    const slicing = doc.recipe.slicing;
    let width: number, height: number;
    if ("output" in slicing) { width = slicing.output.width; height = slicing.output.height; }
    else {
      const { grid } = slicing, [top,right,bottom,left] = grid.margin, [gx,gy] = grid.spacing;
      width = Math.ceil((source.width-left-right-gx*(grid.columns-1))/grid.columns);
      height = Math.ceil((source.height-top-bottom-gy*(grid.rows-1))/grid.rows);
    }
    if (width*height*active.length > 67_108_864) throw new StudioError("输出总解码像素预算超限");
    if (!Array.isArray(result.files) || result.files.length !== active.length || result.width !== width || result.height !== height) throw new StudioError("图像处理输出数量或尺寸不符");
    const indexes = doc.recipe.slicing.items.flatMap((item,index) => item.enabled ? [index] : []);
    if (doc.recipe.schemaVersion === 2 && JSON.stringify(result.itemIndexes) !== JSON.stringify(indexes)) throw new StudioError("图像处理输出顺序协议不符");
    const decoded: Buffer[] = [];
    for (const [index, file] of result.files.entries()) {
      if (file !== join(stage, `${String(index).padStart(3,"0")}.png`)) throw new StudioError("图像处理输出文件顺序不符");
      decoded.push(await checkedPng(this.store, file, stage, width, height));
    }
    recheck();
    const writes: { path: string; bytes: Buffer }[] = [], outputs: ImageAsset[] = [];
    for (const [index, item] of active.entries()) {
      const {old,folder,name,file,meta} = destination(item), bytes = decoded[index]!;
      if (old) this.store.imagePath(pid, old.id, old.revision);
      if (
        !old &&
        (existsSync(this.store.safePath(pid, file)) ||
          existsSync(this.store.safePath(pid, file + ".meta.json")))
      )
        throw new StudioError("输出位置已有同名文件，请修改切片名称", 409);
      const asset: ImageAsset = {
        ...old,
        id: old?.id || randomUUID(),
        type: "image",
        kind: "image",
        name,
        folder,
        file,
        revision: "",
        createdAt: old?.createdAt || new Date().toISOString(),
        width: result.width,
        height: result.height,
        frameCount: 1,
        mime: "image/png",
        contentHash: sha256(bytes),
        producer: { sheetId: id, sliceId: item.id! },
        origin: { kind: "recipe_slice", assetId: id },
      };
      asset.revision = assetRevision(asset);
      outputs.push(asset);
      writes.push(
        { path: file, bytes },
        {
          path: meta,
          bytes: jsonBytes(asset),
        },
      );
      const object = `.studio/objects/${asset.contentHash}`;
      track(object);
      if (fileBaselines.get(object) !== "missing" && fileBaselines.get(object) !== asset.contentHash) throw new StudioError("不可变输出对象已改变",409);
      if (
        !existsSync(this.store.safePath(pid, object)) &&
        !writes.some((w) => w.path === object)
      )
        writes.push({ path: object, bytes });
    }
    const projected = new Map(outputs.map((asset) => [asset.id, asset]));
    for (const asset of this.store.assets(pid))
      if (asset.type === "clip") {
        const images = asset.frames.map(
          (frame) =>
            projected.get(frame.imageId) ||
            this.store.image(pid, frame.imageId),
        );
        if (
          images.some((image) => projected.has(image.id)) &&
          new Set(images.map((image) => `${image.width}x${image.height}`))
            .size > 1
        )
          throw new StudioError(
            `切割会导致动画“${asset.name}”画布不一致，请先调整引用`,
            409,
          );
      }
    const next = {
      key,
      definitionRevision: expected,
      sourceRevision: source.revision,
      outputIds: outputs.map((asset) => asset.id),
      requestId,
    };
    writes.push(
      { path: this.receiptPath(id), bytes: jsonBytes(next) },
      {
        path: requestPath,
        bytes: jsonBytes({ sourceId: id, key, receipt: next }),
      },
    );
    recheck();
    publishFiles(this.store, pid, writes, {
      kind: "slice",
      sourceId: id,
      receipt: next,
    }, recheck);
    return next;
  }
}
