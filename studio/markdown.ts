import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { entryName } from "./library.ts";
import { publishFiles } from "./file-operations.ts";
import { bytes } from "./documents.ts";
import { sha256, StudioError, type ProjectStore } from "./store.ts";
import { markdownReferenceSchema, type MarkdownAsset, type MarkdownDocument } from "./model.ts";

export const MAX_MARKDOWN_BYTES = 256 * 1024;
export const markdownCreateSchema = z.object({
  name: z.string().min(1), text: z.string().default(""), folder: z.string().default(""), requestId: z.string().uuid(),
}).strict();
export const markdownWriteSchema = z.object({ expectedRevision: z.string(), text: z.string() }).strict();
function textBytes(text: string) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length > MAX_MARKDOWN_BYTES) throw new StudioError("Markdown 文档不能超过256KB", 413);
  if (text.includes("\0") || buffer.toString("utf8") !== text) throw new StudioError("文档必须是有效UTF-8文本，不能包含空字符");
  return buffer;
}
export class MarkdownDocuments {
  store: ProjectStore;
  constructor(store: ProjectStore) { this.store = store; }
  read(pid: string, id: string, revision?: string): MarkdownDocument {
    const asset = this.store.asset(pid, id);
    if (asset.type !== "markdown") throw new StudioError("请选择Markdown文档");
    if (revision !== undefined && revision !== asset.revision) throw new StudioError("文档版本已变化，请刷新后重新引用", 409);
    const buffer = readFileSync(this.store.safePath(pid, asset.file));
    if (sha256(buffer) !== asset.contentHash) throw new StudioError("文档已被外部修改，请重新导入，避免覆盖", 409);
    return { asset, text: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
  }
  create(pid: string, input: unknown): MarkdownDocument {
    const spec = markdownCreateSchema.parse(input), buffer = textBytes(spec.text);
    const name = entryName(/\.md$/i.test(spec.name) ? spec.name : spec.name + ".md");
    const folder = spec.folder === "" || spec.folder === "." ? "文档" : spec.folder.startsWith("文档/") || spec.folder === "文档" ? spec.folder : "文档/" + spec.folder;
    this.store.library.folder(pid, folder);
    if (folder !== "文档" && !folder.startsWith("文档/")) throw new StudioError("文档只能保存在文档分类内");
    const requestPath = `.studio/markdown-requests/${spec.requestId}.json`;
    const requestHash = sha256(JSON.stringify({ name, folder, text: spec.text }));
    if (existsSync(this.store.safePath(pid, requestPath))) {
      const receipt = JSON.parse(readFileSync(this.store.safePath(pid, requestPath), "utf8"));
      if (receipt.requestHash !== requestHash) throw new StudioError("创建请求ID已用于不同内容", 409);
      return this.read(pid, receipt.assetId);
    }
    if (this.store.assets(pid).some(asset => asset.folder === folder && asset.name.toLowerCase() === name.toLowerCase()) || this.store.library.folders(pid).some(path => path.toLowerCase() === `${folder}/${name}`.toLowerCase())) throw new StudioError("同名文档或目录已存在，不会覆盖", 409);
    const file = `Assets/${folder}/${name}`;
    if (existsSync(this.store.safePath(pid, file)) || existsSync(this.store.safePath(pid, file + ".meta.json"))) throw new StudioError("文档文件已存在，不会覆盖", 409);
    const now = new Date().toISOString(), hash = sha256(buffer);
    const asset: MarkdownAsset = { id: randomUUID(), type: "markdown", name, folder, file, revision: hash, contentHash: hash, byteLength: buffer.length, createdAt: now, updatedAt: now };
    publishFiles(this.store, pid, [
      { path: file, bytes: buffer }, { path: file + ".meta.json", bytes: bytes(asset) },
      { path: requestPath, bytes: bytes({ requestHash, assetId: asset.id }) },
    ], { assetId: asset.id });
    return this.read(pid, asset.id);
  }
  import(pid: string, filename: string, buffer: Buffer, folder = "") {
    if (!/\.md$/i.test(filename)) throw new StudioError("请选择.md文档");
    if (buffer.length > MAX_MARKDOWN_BYTES) throw new StudioError("Markdown 文档不能超过256KB", 413);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { throw new StudioError("文档必须使用UTF-8编码"); }
    return this.create(pid, { name: filename, text, folder, requestId: randomUUID() });
  }
  write(pid: string, id: string, input: unknown) {
    const spec = markdownWriteSchema.parse(input);
    const { asset } = this.read(pid, id, spec.expectedRevision), buffer = textBytes(spec.text);
    const hash = sha256(buffer), next: MarkdownAsset = { ...asset, revision: hash, contentHash: hash, byteLength: buffer.length, updatedAt: new Date().toISOString() };
    publishFiles(this.store, pid, [{ path: asset.file, bytes: buffer }, { path: this.store.metaPath(pid, id), bytes: bytes(next) }], { assetId: id });
    return this.read(pid, id);
  }
  references(pid: string, input: unknown) {
    return z.array(markdownReferenceSchema).max(3).parse(input).map(ref => {
      const { asset, text } = this.read(pid, ref.id, ref.revision);
      return { id: asset.id, revision: asset.revision, name: asset.name, text };
    });
  }
}
