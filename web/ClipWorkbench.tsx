import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Play, Pause, Maximize2, ZoomIn, ZoomOut, Save, Undo2, Redo2 } from "lucide-react";
import { AnimationEditor } from "./AnimationEditor.tsx";
import { LegacyFrameDrafts } from "./LegacyFrameDrafts.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { api } from "./api.ts";
import { assetUrl, snapshotFrameUrl, type Asset, type ClipAsset, type FrameTransform, type FrameDraft } from "../studio/model.ts";
import { clipEditSchema, type ClipDraftDocument, type ClipDraftPreview, type ClipDraftSave, type EditingContext } from "../studio/workflow-model.ts";
import { clipEdit, contextFor, dependencyKey, dependencyConflicts, sameClipText, samePreview, DraftQueue, editorReducer, editorState, legacyDerivation, finishFrameDrag, offsetByDrag, shortcutAllowed, type EditorAction } from "./workflow-state.ts";

export type ClipEditorBridge = { clipId: string; stabilize: () => Promise<EditingContext> };
const defaults: FrameTransform = { scale: 1, offsetX: 0, offsetY: 0, clip: false };

export function ClipWorkbench({ projectId, clip, assets, frameIndex, onFrame, playing, onPlaying: setPlaying, propertiesHost, locked, onContext, onBridge, onSaved, onTool, legacyDrafts, onLegacyPreview }: {
  projectId: string; clip: ClipAsset; assets: Asset[]; frameIndex: number; onFrame: (index: number) => void;
  legacyDrafts: FrameDraft[]; onLegacyPreview: (snapshotId: string) => void;
  playing: boolean; onPlaying: (value: boolean) => void;
  propertiesHost: HTMLElement | null; locked?: string; onContext: (context: EditingContext) => void;
  onBridge: (bridge: ClipEditorBridge | null) => void; onSaved: () => Promise<void>; onTool: (tool: "interpolate" | "review") => void;
}) {
  const [editor, setEditor] = useState(() => editorState(clipEdit(clip)));
  const current = useRef(editor); current.current = editor;
  const [document, setDocument] = useState<ClipDraftDocument | null>(null);
  const queue = useRef<DraftQueue | null>(null);
  const [preview, setPreview] = useState<{ value: ClipDraftPreview; text: string; deps: string; revision: string } | null>(null);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [conflict, setConflict] = useState(false);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [size, setSize] = useState({ width: 500, height: 400 });
  const stage = useRef<HTMLDivElement>(null), generation = useRef(0), mounted = useRef(true);
  const latest = useRef({ clip, assets, locked, frameIndex }); latest.current = { clip, assets, locked, frameIndex };
  const storageKey = `studio.clip-draft.${projectId}.${clip.id}`;
  const baseRevision = useRef(clip.revision);
  const baseDependencies = useRef(dependencyKey(clipEdit(clip), assets));
  const assetVersions = useRef<Record<string,string>>(Object.fromEntries(clip.frames.map(frame => [frame.imageId, assets.find(asset => asset.id === frame.imageId)?.revision || "missing"])));
  const path = `/api/projects/${projectId}/clip-drafts`;
  const text = JSON.stringify(editor.present, null, 2);
  const deps = dependencyKey(editor.present, assets);
  const readonly = !!locked || !document || document.draft.source !== "human" || document.draft.status !== "editing" || conflict;
  const displayClip = { ...clip, ...editor.present, type: "clip" as const, revision: `${clip.revision}:${editor.version}` };
  const frame = editor.present.frames[frameIndex];
  const image = assets.find(a => a.id === frame?.imageId);
  const transform = { ...defaults, ...frame?.transform };
  const width = image?.type === "image" ? image.width : 360, height = image?.type === "image" ? image.height : 360;
  const scale = zoom === "fit" ? Math.max(0.02, Math.min(size.width / width, size.height / height, 3)) : zoom;
  const validPreview = preview && sameClipText(preview.text, text) && preview.deps === deps && preview.revision === document?.documentRevision ? preview.value : null;

  function act(action: EditorAction) {
    if (readonly || busy) return;
    try {
      const next = editorReducer(current.current, action);
      for (const frame of next.present.frames) if (!assetVersions.current[frame.imageId]) assetVersions.current[frame.imageId] = latest.current.assets.find(asset => asset.id === frame.imageId)?.revision || "missing";
      current.current = next; setEditor(next); setPlaying(false);
      queue.current?.enqueue(JSON.stringify(next.present, null, 2));
      setError("");
    } catch (error) { setError((error as Error).message); }
  }
  function patchFrame(change: Partial<typeof frame>) {
    if (!frame) return;
    act({ type: "edit", edit: { ...current.current.present, frames: current.current.present.frames.map(f => f.id === frame.id ? { ...f, ...change } : f) } });
  }
  async function open(fresh = false, fromDraft?: FrameDraft) {
    const token = ++generation.current;
    setBusy("载入草稿"); setError(""); setConflict(false); setPreview(null);
    try {
      const recovery = fresh ? null : JSON.parse(localStorage.getItem(storageKey) || "null") as { id: string; revision: string; baseRevision: string; text: string; dependencies?: string; assetVersions?: Record<string,string> } | null;
      const doc = recovery ? await api<ClipDraftDocument>(`${path}/${recovery.id}`) : await api<ClipDraftDocument>(path, { method: "POST", body: JSON.stringify(fromDraft ? legacyDerivation(latest.current.clip, fromDraft) : { clipId: clip.id, revision: latest.current.clip.revision, source: "human" }) });
      if (!mounted.current || token !== generation.current) return;
      const recoveredText = recovery?.text || doc.text;
      const edit = clipEditSchema.parse(JSON.parse(recoveredText));
      const next = editorState(edit); current.current = next; setEditor(next);
      setDocument(doc);
      const q = new DraftQueue(doc, (revision, text) => api<ClipDraftDocument>(`${path}/${doc.draft.id}`, { method: "PUT", body: JSON.stringify({ expectedDocumentRevision: revision, text }) }));
      queue.current = q;
      baseRevision.current = recovery?.baseRevision || latest.current.clip.revision;
      baseDependencies.current = recovery?.dependencies || dependencyKey(clipEdit(latest.current.clip), latest.current.assets);
      assetVersions.current = recovery?.assetVersions || Object.fromEntries(edit.frames.map(frame => [frame.imageId, latest.current.assets.find(asset => asset.id === frame.imageId)?.revision || "missing"]));
      if ((recovery && recovery.revision !== doc.documentRevision && !sameClipText(recovery.text, doc.text)) || (recovery && recovery.baseRevision !== latest.current.clip.revision) || dependencyConflicts(edit,latest.current.assets,assetVersions.current).length) {
        setConflict(true); setError("服务草稿已变化。本机未保存内容已保留，禁止自动覆盖；请复制内容后选择重新载入。");
      } else if (doc.draft.source !== "human") {
        setError("助手草稿只读。请先接手任务，再从当前保存版本建立自己的草稿。");
      } else if (doc.draft.status === "editing") q.enqueue(recoveredText);
    } catch (error) { if (token === generation.current) setError((error as Error).message); }
    finally { if (token === generation.current) setBusy(""); }
  }
  useEffect(() => {
    mounted.current = true;
    if (!locked) void open();
    return () => { mounted.current = false; generation.current++; };
  }, []);
  const previouslyLocked = useRef(!!locked);
  useEffect(() => { const unlocked = previouslyLocked.current && !locked; previouslyLocked.current = !!locked; if (unlocked && !document && !busy && !error) void open(); }, [locked]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      // contentRect already excludes padding: do not subtract it again for fit.
      setSize({ width: entry!.contentRect.width, height: entry!.contentRect.height });
    }); observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!document || document.draft.status !== "editing") return;
    if (clip.revision !== baseRevision.current) { setConflict(true); setError("动画保存版本发生变化，本机草稿保留。需要重新载入或先复制草稿内容，不能覆盖新版本。"); }
    if (dependencyKey(clipEdit(clip), assets) !== baseDependencies.current || dependencyConflicts(editor.present,assets,assetVersions.current).length) {
      // Guard newly referenced images too; an old preview never authorizes changed pixels.
      setConflict(true); setError("依赖图片版本发生变化，旧预览已失效。草稿已保留，请重新载入后核对。");
    }
  }, [clip.revision, assets.map(a => `${a.id}:${a.revision}`).join("|")]);
  useEffect(() => {
    if (!document || document.draft.status !== "editing" || document.draft.source !== "human") return;
    localStorage.setItem(storageKey, JSON.stringify({ id: document.draft.id, revision: queue.current?.document.documentRevision || document.documentRevision, baseRevision: baseRevision.current, text, dependencies: baseDependencies.current, assetVersions: assetVersions.current }));
  }, [text, document]);
  async function stabilize(): Promise<EditingContext> {
    const q = queue.current, token = generation.current;
    const frameId = current.current.present.frames[latest.current.frameIndex]?.id;
    if (conflict || dependencyConflicts(current.current.present,latest.current.assets,assetVersions.current).length || latest.current.clip.revision !== baseRevision.current) throw new Error("草稿存在版本/依赖冲突，不能把未核实的版本交给助手或保存");
    if (!q || q.document.draft.status !== "editing") return contextFor(latest.current.clip,frameId);
    if (q.document.draft.source !== "human") return contextFor(latest.current.clip,frameId,q.document);
    if (latest.current.locked) {
      if (!sameClipText(q.desired, q.document.text)) throw new Error("任务已持有此对象，请先接手后暂存人工草稿");
      return contextFor(latest.current.clip,frameId,q.document);
    }
    q.enqueue(JSON.stringify(current.current.present, null, 2));
    const doc = await q.flush();
    if (!mounted.current || token !== generation.current || q !== queue.current) throw new Error("工作对象/草稿已切换，请重新确认上下文");
    if (frameId && !current.current.present.frames.some(frame => frame.id === frameId)) throw new Error("发送前所选帧已移除，请重新确认上下文");
    setDocument(doc);
    return contextFor(latest.current.clip,frameId,doc);
  }
  useEffect(() => {
    onContext(contextFor(clip, frame?.id, document?.draft.status === "editing" ? document : undefined));
    onBridge({ clipId: clip.id, stabilize: async () => { if (busy) throw new Error("草稿正在载入或保存，请等待完成后发送"); return stabilize(); } });
    return () => onBridge(null);
  }, [document, frame?.id, readonly, text, busy]);
  useEffect(() => {
    if (readonly || busy) return;
    const token = generation.current;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const context = await stabilize();
          if (cancelled || !context.draftId) return;
          const q = queue.current!;
          const persistedText = q.document.text;
          const identity = {generation:token,documentRevision:context.documentRevision!,text:persistedText,dependencies:deps};
          const response = await api<ClipDraftPreview>(`${path}/${context.draftId}/preview`, { method: "POST", body: JSON.stringify({ documentRevision: context.documentRevision }) });
          if (!cancelled && mounted.current && samePreview(identity,{generation:generation.current,documentRevision:queue.current?.document.documentRevision || "",text:JSON.stringify(current.current.present,null,2),dependencies:dependencyKey(current.current.present,latest.current.assets)})) setPreview({ value: response, text: persistedText, deps, revision: context.documentRevision! });
        } catch (error) { if (!cancelled && mounted.current && token === generation.current) { setError((error as Error).message); if (queue.current?.error) setConflict(true); } }
      })();
    }, 240);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [text, deps, readonly, busy]);
  useEffect(() => {
    if (frameIndex >= editor.present.frames.length) onFrame(Math.max(0, editor.present.frames.length - 1));
  }, [editor.present.frames.length, frameIndex]);
  useEffect(() => {
    if (!playing || !editor.present.frames.length) return;
    let index = Math.min(frameIndex, editor.present.frames.length - 1), elapsed = 0, last = performance.now(), raf = 0;
    const tick = (time: number) => {
      elapsed += Math.min(time - last, 100); last = time;
      while (elapsed >= editor.present.frames[index]!.durationUs / 1000) {
        elapsed -= editor.present.frames[index]!.durationUs / 1000;
        if (index === editor.present.frames.length - 1 && !editor.present.loop) { setPlaying(false); return; }
        index = (index + 1) % editor.present.frames.length; onFrame(index);
      }
      raf = requestAnimationFrame(tick);
    }; raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [playing, text]);
  async function save() {
    if (readonly || busy) return;
    const token = generation.current;
    setBusy("保存动画"); setError("");
    try {
      const context = await stabilize();
      const result = await api<ClipDraftSave>(`${path}/${context.draftId}/save`, { method: "POST", body: JSON.stringify({ documentRevision: context.documentRevision }) });
      if (!mounted.current || token !== generation.current) return;
      localStorage.removeItem(storageKey);
      setDocument(doc => doc ? { ...doc, draft: { ...doc.draft, status: "saved" } } : doc);
      if (queue.current) queue.current.document.draft.status = "saved";
      baseRevision.current = result.clip.revision;
      await onSaved();
    } catch (error) { if (mounted.current) { setError((error as Error).message); setConflict(true); } }
    finally { if (mounted.current) setBusy(""); }
  }
  async function discard() {
    if (readonly || busy || !window.confirm("放弃这份人工动画草稿？尚未保存的编排和参数将丢弃，已保存动画保持不变。")) return;
    const token = generation.current;
    setBusy("放弃草稿"); setError("");
    try {
      const context = await stabilize();
      await api(`${path}/${context.draftId}/discard`, {method:"POST",body:JSON.stringify({documentRevision:context.documentRevision})});
      if (!mounted.current || token !== generation.current) return;
      localStorage.removeItem(storageKey);
      await open(true);
    } catch (error) { if (mounted.current && token === generation.current) setError((error as Error).message); }
    finally { if (mounted.current) setBusy(""); }
  }
  const hasUnifiedChanges = !sameClipText(text, JSON.stringify(clipEdit(clip)));
  const deriveDisabledReason = locked ? "请先成功接手此对象，旧草稿仍可只读查看。" : busy ? "请等待当前草稿操作完成。" : hasUnifiedChanges ? "当前统一草稿有未保存修改，请先保存或明确放弃，再派生旧草稿。" : undefined;
  async function deriveLegacy(draft: FrameDraft) {
    if (deriveDisabledReason) throw new Error(deriveDisabledReason);
    const token = generation.current;
    setBusy("派生旧草稿"); setError("");
    try {
      if (queue.current?.document.draft.status === "editing" && queue.current.document.draft.source === "human") await queue.current.flush();
      if (!mounted.current || token !== generation.current || latest.current.locked) return;
      await open(true, draft);
    } catch (error) { if (mounted.current && token === generation.current) setError((error as Error).message); }
    finally { if (mounted.current && token === generation.current) setBusy(""); }
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!shortcutAllowed(event.target) || globalThis.document.querySelector('.modal-backdrop,[role="dialog"],dialog[open]')) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      else if (modifier && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) { event.preventDefault(); act({ type: event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo" }); }
      else if (event.code === "Space") { event.preventDefault(); setPlaying(!playing); }
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); drag.current = null; setDragOffset(null); setPlaying(false); onFrame(Math.max(0, Math.min(editor.present.frames.length - 1, frameIndex + (event.key === "ArrowRight" ? 1 : -1)))); }
      else if (event.key === "Delete" && frame) { event.preventDefault(); act({ type: "edit", edit: { ...editor.present, frames: editor.present.frames.filter(f => f.id !== frame.id) } }); }
    }; window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  });
  const drag = useRef<{ frameId: string; x: number; y: number; transform: FrameTransform; scale: number; dx: number; dy: number } | null>(null);
  const [dragOffset, setDragOffset] = useState<{ offsetX: number; offsetY: number } | null>(null);
  useEffect(() => { drag.current = null; setDragOffset(null); }, [frame?.id]);
  const shownTransform = { ...transform, ...dragOffset };
  return <>
    <div className="draft-toolbar" role="status">
      <span title={error}>{locked || busy || (error ? "草稿未就绪 · 请查看属性中的错误" : document?.draft.status === "saved" ? "动画已保存" : conflict ? "草稿冲突 · 内容保留" : document?.draft.source === "agent" ? "助手草稿 · 只读" : validPreview ? "整份草稿 · 已暂存" : "整份草稿 · 等待暂存/预览")}</span>
      <button aria-label="撤销草稿" title="撤销 Ctrl+Z" disabled={readonly || !editor.past.length} onClick={() => act({ type: "undo" })}><Undo2 size={14}/></button>
      <button aria-label="重做草稿" title="重做 Ctrl+Shift+Z" disabled={readonly || !editor.future.length} onClick={() => act({ type: "redo" })}><Redo2 size={14}/></button>
      <button className="secondary" disabled={readonly || !!busy} onClick={() => void save()}><Save size={14}/>保存动画</button>
      {document?.draft.status === "saved" && !locked && <button disabled={!!busy} onClick={() => void open(true)}>继续编辑</button>}
    </div>
    <div className="stage checker workflow-stage" ref={stage} tabIndex={0} aria-label="动画画布，左右箭头切帧，空格播放">
      <div className="artboard" style={{ width: width * scale, height: height * scale, overflow: transform.clip ? "hidden" : "visible" }}
        onPointerDown={event => {
          if (readonly || busy || !frame || playing || event.button !== 0) return;
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { frameId: frame.id, x: event.clientX, y: event.clientY, transform, scale, dx: 0, dy: 0 };
        }}
        onPointerMove={event => { const d = drag.current; if (!d) return; if (d.frameId !== current.current.present.frames[latest.current.frameIndex]?.id) { drag.current = null; setDragOffset(null); return; } d.dx = event.clientX - d.x; d.dy = event.clientY - d.y; setDragOffset(offsetByDrag(d.transform.offsetX, d.transform.offsetY, d.dx, d.dy, d.scale)); }}
        onPointerUp={event => { const d = drag.current; drag.current = null; setDragOffset(null); if (d && !readonly) { const edit = finishFrameDrag(current.current.present, current.current.present.frames[latest.current.frameIndex]?.id, d.frameId, { ...d.transform, ...offsetByDrag(d.transform.offsetX, d.transform.offsetY, d.dx, d.dy, d.scale) }); if (edit) act({type:"edit",edit}); } if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { drag.current = null; setDragOffset(null); }}>
        {frame && image?.type === "image" ? <img draggable={false} alt={`${clip.name} 第 ${frameIndex + 1} 帧实例`} src={validPreview && !dragOffset ? snapshotFrameUrl(projectId, validPreview.preview.id, frame.id) : assetUrl(projectId, image.id, image.revision)}
          style={validPreview && !dragOffset ? undefined : { transform: `translate(${shownTransform.offsetX * scale}px, ${shownTransform.offsetY * scale}px) scale(${shownTransform.scale})` }}/>
          : <p className="adjust-note">从素材库拖入静态图片到时间轴；修改只进入当前动画草稿。</p>}
      </div>
      <div className="view-controls"><span>视图缩放</span><button aria-label="缩小视图" onClick={() => setZoom(Math.max(.05, scale / 1.25))}><ZoomOut size={15}/></button><button onClick={() => setZoom(1)}>{Math.round(scale * 100)}%</button><button aria-label="放大视图" onClick={() => setZoom(Math.min(8, scale * 1.25))}><ZoomIn size={15}/></button><button aria-label="适应画布" onClick={() => setZoom("fit")}><Maximize2 size={15}/></button></div>
    </div>
    <ResizeHandle name="动画编排高度" target=".animation-editor" variable="--timeline-height" reverse min={140} max={400}/>
    <AnimationEditor projectId={projectId} clip={displayClip} assets={assets} frameIndex={frameIndex} playing={playing} onPlaying={setPlaying} onFrame={onFrame} previewSnapshot={validPreview?.preview} onChange={next => act({ type: "edit", edit: clipEdit(next) })} onUndo={() => act({type:"undo"})} onRedo={() => act({type:"redo"})} canUndo={!!editor.past.length} canRedo={!!editor.future.length} onTool={onTool} disabled={readonly || !!busy}/>
    {propertiesHost && createPortal(<div className="workflow-properties">
      <h3>{clip.name} · {frame ? `第 ${frameIndex + 1} 帧实例` : "空动画"}</h3>
      <small>帧实例 {frame?.id || "无"}；不会修改共享源图。</small>
      {locked && <p className="interpolation-warning">{locked}；先在助手任务卡点击“我来接手”，成功后启用编辑。</p>}
      {frame && <fieldset disabled={readonly || !!busy}>
        <legend>同一动画草稿中的帧参数</legend>
        <label>素材缩放（不是视图缩放）<input aria-label="帧素材缩放百分比" type="number" min={5} max={400} value={Math.round(transform.scale * 100)} onChange={e => patchFrame({transform:{...transform,scale:Math.max(.05,Math.min(4,Number(e.target.value)/100))}})}/> %</label>
        {(["offsetX","offsetY"] as const).map(key => <label key={key}>{key === "offsetX" ? "水平偏移 X" : "垂直偏移 Y"}<input type="number" min={-4096} max={4096} value={transform[key]} onChange={e => patchFrame({transform:{...transform,[key]:Math.max(-4096,Math.min(4096,Number(e.target.value)))}})}/></label>)}
        <label>停留时长 ms<input type="number" min={1} max={60000} value={frame.durationUs / 1000} onChange={e => patchFrame({durationUs:Math.max(1000,Math.min(60000000,Math.round(Number(e.target.value)*1000)))})}/></label>
        <label><input type="checkbox" checked={transform.clip} onChange={e => patchFrame({transform:{...transform,clip:e.target.checked}})}/>允许裁切超出画布内容</label>
        <button className="secondary" onClick={() => patchFrame({transform:defaults})}>重置当前帧参数</button>
      </fieldset>}
      <button className="secondary" disabled={readonly || !!busy} onClick={() => void discard()}>放弃人工草稿，恢复保存版本</button>
      {validPreview?.warnings.map((warning,i) => <p key={i} className="interpolation-warning">第 {warning.frameNumber ?? "?"} 帧内容超出画布{warning.blocking ? "，保存受阻" : "，已允许裁切"}。</p>)}
      {error && <p role="alert" className="interpolation-warning">{error}</p>}
      {(conflict || error || document?.draft.source === "agent") && <><details><summary>保留的草稿正文（可复制）</summary><textarea aria-label="保留的草稿正文" readOnly value={text}/></details><button className="secondary" disabled={!!locked || !!busy} onClick={() => { if (window.confirm("从当前保存版本重建草稿？本机未保存内容请先复制。旧服务草稿仍保留。")) { localStorage.removeItem(storageKey); void open(true); } }}>从当前版本重新建立草稿</button></>}
      <LegacyFrameDrafts projectId={projectId} clipId={clip.id} drafts={legacyDrafts} deriveDisabledReason={deriveDisabledReason} onPreview={onLegacyPreview} onDerive={deriveLegacy}/>
      <p className="adjust-note">自动暂存不等于保存动画。拖动画布移动所选帧；左右箭头切帧，Space 播放，Ctrl+S 保存，Ctrl+Z / Ctrl+Shift+Z 撤销重做。</p>
    </div>, propertiesHost)}
  </>;
}
