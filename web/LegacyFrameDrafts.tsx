import { useEffect, useRef, useState } from "react";
import type { FrameDraft, ClipSnapshot } from "../studio/model.ts";
import { api } from "./api.ts";
import { legacyDraftsFor } from "./workflow-state.ts";

type LegacyDocument = { documentId: string; documentRevision: string; text: string; draft: FrameDraft };

/** Compatibility access only: no PUT, save, discard or legacy writable editor. */
export function LegacyFrameDrafts({ projectId, clipId, drafts, deriveDisabledReason, onPreview, onDerive }: {
  projectId: string; clipId: string; drafts: FrameDraft[]; deriveDisabledReason?: string;
  onPreview: (snapshotId: string) => void; onDerive: (draft: FrameDraft) => Promise<void>;
}) {
  const [document, setDocument] = useState<LegacyDocument | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const mounted = useRef(true), epoch = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  const related = legacyDraftsFor(clipId, drafts);
  if (!related.length) return null;

  async function open(draft: FrameDraft) {
    const token = ++epoch.current;
    setBusy(true); setError(""); setDocument(null);
    try {
      const value = await api<LegacyDocument>(`/api/projects/${projectId}/documents/${draft.id}`);
      if (!mounted.current || token !== epoch.current) return;
      if (value.draft.id !== draft.id || value.draft.projectId !== projectId || value.draft.clipId !== clipId) throw new Error("旧草稿响应身份不匹配，未打开");
      setDocument(value);
    } catch (error) { if (mounted.current && token === epoch.current) setError((error as Error).message); }
    finally { if (mounted.current && token === epoch.current) setBusy(false); }
  }
  async function preview() {
    if (!document) return;
    const token = epoch.current, viewed = document;
    setBusy(true); setError("");
    try {
      const value = await api<{ draft: FrameDraft; preview: ClipSnapshot }>(`/api/projects/${projectId}/frame-drafts/${viewed.draft.id}/preview`, {
        method: "POST", body: JSON.stringify({ documentRevision: viewed.documentRevision }),
      });
      if (!mounted.current || token !== epoch.current) return;
      if (value.draft.id !== viewed.draft.id || value.preview.projectId !== projectId) throw new Error("旧草稿预览身份不匹配，未播放");
      onPreview(value.preview.id);
    } catch (error) { if (mounted.current && token === epoch.current) setError((error as Error).message); }
    finally { if (mounted.current && token === epoch.current) setBusy(false); }
  }
  async function derive() {
    if (!document || deriveDisabledReason) return;
    setBusy(true); setError("");
    try { await onDerive({ ...document.draft, documentRevision: document.documentRevision, text: document.text }); }
    catch (error) { if (mounted.current) setError((error as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }

  return <details className="legacy-drafts">
    <summary>旧逐帧草稿与历史（{related.length}，只读）</summary>
    <p>旧人工成果不会自动迁移或丢弃。只读查看/播放后，可明确派生到统一动画草稿；旧草稿保持不变，不恢复旧的独立可写编辑器。</p>
    <div className="frame-draft-list">{related.map(draft => <button className="text-button" key={draft.id} disabled={busy} onClick={() => void open(draft)}>
      {draft.source === "human" ? "我的" : "助手"}旧草稿 · {draft.status} · {draft.id.slice(0, 8)}
    </button>)}</div>
    {document && <>
      <small>旧文档 {document.documentId} · 所看版本 {document.documentRevision} · {document.draft.source}</small>
      <label>旧草稿正文（只读，可复制）<textarea aria-label="旧草稿只读正文" readOnly value={document.text}/></label>
      <button className="secondary" disabled={busy} onClick={() => void preview()}>播放此旧草稿的固定预览</button>
      <button className="secondary" disabled={busy || !!deriveDisabledReason || document.draft.source !== "human" || !["editing", "pending"].includes(document.draft.status)} onClick={() => void derive()}>从所看版本派生统一动画草稿</button>
      {deriveDisabledReason && <p>{deriveDisabledReason}</p>}
    </>}
    {(busy || error) && <p role={error ? "alert" : "status"} className={error ? "interpolation-warning" : ""}>{error || "读取旧草稿…"}</p>}
  </details>;
}
