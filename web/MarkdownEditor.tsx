import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText, Save, Link2 } from "lucide-react";
import { api } from "./api.ts";
import type { MarkdownAsset, MarkdownDocument } from "../studio/model.ts";

export function MarkdownEditor({ projectId, asset, onDirty, onSaved, onReference }: {
  projectId: string; asset: MarkdownAsset; onDirty: (dirty: boolean) => void;
  onSaved: () => Promise<void>; onReference: (asset: MarkdownAsset) => void;
}) {
  const [document, setDocument] = useState<MarkdownDocument | null>(null);
  const [text, setText] = useState(""), [mode, setMode] = useState<"edit" | "preview">("edit");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const latest = useRef(text); latest.current = text;
  const dirty = !!document && text !== document.text;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const mounted = useRef(true);
  const revision = useRef("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onDirty(false); }; }, [onDirty]);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    if (dirty || busy) return;
    let cancelled = false;
    void api<MarkdownDocument>(`/api/projects/${projectId}/markdown/${asset.id}`).then(value => {
      if (cancelled || dirtyRef.current) return;
      revision.current = value.asset.revision;
      setDocument(value); setText(value.text); setError("");
    }).catch(reason => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, [projectId, asset.id, asset.revision, dirty, busy]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  async function save() {
    if (!document || busy || !dirty) return;
    const submitted = latest.current;
    setBusy(true); setError("");
    try {
      const value = await api<MarkdownDocument>(`/api/projects/${projectId}/markdown/${asset.id}`, { method: "PUT", body: JSON.stringify({ text: submitted, expectedRevision: revision.current }) });
      if (!mounted.current) return;
      revision.current = value.asset.revision;
      setDocument(value);
      // Preserve edits made while the request was in flight.
      if (latest.current === submitted) setText(value.text);
      await onSaved();
    } catch (reason) { if (mounted.current) setError((reason as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function reload() {
    if (dirty && !window.confirm("放弃当前未保存文字，载入最新文档？当前文字可以先复制保留。")) return;
    const before = latest.current;
    try {
      const value = await api<MarkdownDocument>(`/api/projects/${projectId}/markdown/${asset.id}`);
      if (!mounted.current) return;
      if (latest.current !== before) { setError("读取期间有新的输入，已保留；没有替换正文"); return; }
      revision.current = value.asset.revision;
      setDocument(value); setText(value.text); setError("");
    } catch (reason) { if (mounted.current) setError((reason as Error).message); }
  }
  return <section className="markdown-workbench" aria-label="Markdown文档编辑器" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
  }}>
    <div className="markdown-toolbar">
      <div className="markdown-tabs" role="tablist" aria-label="文档显示方式">
        <button role="tab" aria-selected={mode === "edit"} onClick={() => setMode("edit")}>编辑</button>
        <button role="tab" aria-selected={mode === "preview"} onClick={() => setMode("preview")}>预览</button>
      </div>
      <span role="status">{busy ? "正在保存…" : dirty ? "有未保存修改" : document ? "已保存" : "正在读取…"}</span>
      <button disabled={!document || dirty || busy} title={dirty ? "先保存正文再引用" : "引用已保存文档到对话"} onClick={() => document && onReference(document.asset)}><Link2 size={14}/>引用到对话</button>
      <button className="primary" disabled={!dirty || busy} onClick={() => void save()}><Save size={14}/>保存文档</button>
    </div>
    {document && asset.revision !== revision.current && <p className="markdown-notice" role="status">文档已有新版本；当前文字未被覆盖。保存将检查版本，请先复制或载入最新正文。</p>}
    {error && <div className="markdown-notice" role="alert">{error}。输入仍保留。<button onClick={() => void reload()} disabled={busy}>载入最新正文</button></div>}
    {mode === "edit" ? <textarea aria-label="Markdown正文" className="markdown-source" value={text} disabled={!document} onChange={event => setText(event.target.value)} spellCheck={false}/> :
      <article className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
        img: ({ alt }) => <span className="markdown-image-placeholder">[图片：{alt || "未加载"}；文档不会自动加载图片]</span>,
        a: ({ href, children }) => href && /^(https?:|mailto:|#)/i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
      }}>{text}</ReactMarkdown></article>}
    <small className="markdown-footer">UTF-8 Markdown · {new TextEncoder().encode(text).length.toLocaleString()} 字节 · Ctrl/⌘+S 保存 · 正文直接保存，不关联制作任务</small>
  </section>;
}

export function NewMarkdownDialog({ projectId, folder, onClose, onCreated }: {
  projectId: string; folder: string; onClose: () => void; onCreated: (asset: MarkdownAsset) => void;
}) {
  const [name, setName] = useState("新文档.md"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const form = useRef<HTMLFormElement>(null);
  const busyRef = useRef(busy), closeRef = useRef(onClose);
  busyRef.current = busy; closeRef.current = onClose;
  useEffect(() => {
    const previous = window.document.activeElement as HTMLElement | null;
    form.current?.querySelector<HTMLInputElement>("input")?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key === "Tab") {
        const controls = [...(form.current?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)") || [])];
        if (event.shiftKey && window.document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && window.document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
      }
    };
    window.document.addEventListener("keydown", keys);
    return () => { window.document.removeEventListener("keydown", keys); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop"><form ref={form} className="modal" role="dialog" aria-modal="true" aria-label="新建Markdown文档" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const value = await api<MarkdownDocument>(`/api/projects/${projectId}/markdown`, { method: "POST", body: JSON.stringify({ name, folder, text: "", requestId: requestId.current }) });
      onCreated(value.asset);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }}>
    <h2><FileText size={18}/>新建 Markdown 文档</h2>
    <label>文档名称<input autoFocus aria-label="文档名称" value={name} onChange={event => { setName(event.target.value); requestId.current = crypto.randomUUID(); }} disabled={busy} maxLength={100}/></label>
    <p>保存在 {folder || "文档"}，不会覆盖同名文件。</p>
    {error && <p role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy || !name.trim()}>{busy ? "正在新建…" : "新建文档"}</button></div>
  </form></div>;
}
