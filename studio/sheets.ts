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

import { sheetRecipeSchema, type SheetRecipe } from "./sheet-schema.ts";
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
    const recipe = this.parse(pid, id, text),
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
        : receipt?.definitionRevision === definitionRevision &&
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
  parse(pid: string, id: string, text: string): SheetRecipe {
    if (Buffer.byteLength(text) > 256 * 1024)
      throw new StudioError("配置文件超过 256 KB");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new StudioError("INVALID_DOCUMENT：配置不是有效 JSON");
    }
    const checked = sheetRecipeSchema.safeParse(value);
    if (!checked.success)
      throw new StudioError(
        "INVALID_DOCUMENT：" +
          checked.error.issues
            .map((issue) => `/${issue.path.join("/")} ${issue.message}`)
            .join("；"),
      );
    const recipe = checked.data,
      { grid, items, outputFolder } = recipe.slicing,
      source = this.source(pid, id);
    if (grid.columns * grid.rows > 128)
      throw new StudioError("一次最多切割128格");
    if (!(outputFolder === "原图素材" || outputFolder.startsWith("原图素材/")))
      throw new StudioError("切片目录必须位于原图素材分类");
    outputFolder.split("/").forEach(entryName);
    this.store.safePath(pid, `Assets/${outputFolder}`);
    const ids = new Set<string>(),
      cells = new Set<string>();
    for (const item of items) {
      entryName(item.name);
      if (item.id && ids.has(item.id))
        throw new StudioError("切片 ID 不能重复");
      if (item.id) ids.add(item.id);
      if (item.cell[0] >= grid.columns || item.cell[1] >= grid.rows)
        throw new StudioError("切片单元超出网格");
      const cell = item.cell.join(",");
      if (cells.has(cell))
        throw new StudioError("网格单元不能重复，请保留原切片 ID");
      cells.add(cell);
    }
    const [top, right, bottom, left] = grid.margin,
      [gapX, gapY] = grid.spacing;
    if (
      source.width - left - right - gapX * (grid.columns - 1) < grid.columns ||
      source.height - top - bottom - gapY * (grid.rows - 1) < grid.rows
    )
      throw new StudioError("边距、间距或网格数量使切片小于一个像素");
    this.checkReferences(pid, id, recipe);
    return recipe;
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
    const writes = documents.map((input) => {
      const current = this.read(pid, input.documentId);
      if (current.documentRevision !== input.expectedDocumentRevision)
        throw new StudioError(
          "VERSION_CONFLICT：配置已变化，请重新读取；本地草稿已保留",
          409,
        );
      const recipe = this.parse(pid, input.documentId, input.text);
      for (const item of recipe.slicing.items) item.id ??= randomUUID();
      return { path: current.path, bytes: jsonBytes(recipe) };
    });
    publishFiles(this.store, pid, writes, {
      kind: "save-config",
      documentIds: documents.map((d) => d.documentId),
    });
    return documents.map((d) => this.read(pid, d.documentId));
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
      throw new StudioError("请先选择要切割的网格单元");
    const key = sha256(
        JSON.stringify([
          doc.definitionRevision,
          source.revision,
          source.contentHash,
          "grid-v1",
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
    const sourcePath = this.store.imagePath(pid, id, source.revision),
      result = await this.store.worker.run("recipe_slice", {
        path: sourcePath,
        outputDir: this.store.stage(pid),
        ...doc.recipe.slicing,
      });
    if (
      this.read(pid, id).definitionRevision !== expected ||
      this.source(pid, id).revision !== source.revision
    )
      throw new StudioError(
        "VERSION_CONFLICT：切割期间配置或来源发生变化，未发布旧结果",
        409,
      );
    this.store.imagePath(pid, id, source.revision);
    const active = doc.recipe.slicing.items.filter((item) => item.enabled),
      writes: { path: string; bytes: Buffer }[] = [],
      outputs: ImageAsset[] = [];
    const children = this.store
      .assets(pid)
      .filter(
        (asset): asset is ImageAsset =>
          asset.type === "image" && asset.producer?.sheetId === id,
      );
    for (const [index, item] of active.entries()) {
      const old = children.find((asset) => asset.producer!.sliceId === item.id),
        bytes = readFileSync(result.files[index]);
      const folder = old?.folder || doc.recipe.slicing.outputFolder,
        name = old?.name || `${item.name}-${item.id!.slice(0, 8)}.png`,
        file = old?.file || `Assets/${folder}/${name}`;
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
          path: old ? this.store.metaPath(pid, old.id) : file + ".meta.json",
          bytes: jsonBytes(asset),
        },
      );
      const object = `.studio/objects/${asset.contentHash}`;
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
    publishFiles(this.store, pid, writes, {
      kind: "slice",
      sourceId: id,
      receipt: next,
    });
    return next;
  }
}
