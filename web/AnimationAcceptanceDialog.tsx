import { useEffect, useRef, useState } from "react";
import { Pause, Play, X } from "lucide-react";
import { snapshotFrameUrl, type AnimationApprovalPreview, type ClipSnapshot } from "../studio/model.ts";
import { api } from "./api.ts";
import { animationChangeSummary, animationDurationMs, animationFrameAt } from "./animation-playback.ts";

type Pair = { before: ClipSnapshot; after: ClipSnapshot };

function CandidatePlayback({ before, after }: Pair) {
  const [playing, setPlaying] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [restart, setRestart] = useState(0);
  const [compare, setCompare] = useState(before.clip.frames.length > 0);
  const [background, setBackground] = useState("checker");
  const [zoom, setZoom] = useState("fit");
  const [viewWidth, setViewWidth] = useState(600);
  const container = useRef<HTMLDivElement>(null);
  const clock = useRef(0);
  const snapshots = compare ? [before, after] : [after];
  const width = Math.max(1, ...[before, after].flatMap(snapshot => Object.values(snapshot.images).map(image => image.width)));
  const height = Math.max(1, ...[before, after].flatMap(snapshot => Object.values(snapshot.images).map(image => image.height)));
  const columns = compare && viewWidth >= 640 ? 2 : 1;
  const scale = zoom === "fit" ? Math.max(.02, Math.min((viewWidth / columns - 28) / width, 280 / height, 2)) : Number(zoom);
  const index = animationFrameAt(after, elapsed);
  const total = Math.max(animationDurationMs(before), animationDurationMs(after));

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setViewWidth(entry!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!playing || total <= 0) return;
    let raf = 0;
    const start = performance.now(), offset = clock.current;
    const tick = (now: number) => {
      clock.current = offset + now - start;
      setElapsed(clock.current);
      if (!snapshots.some(snapshot => snapshot.clip.frames.length && snapshot.clip.loop) && clock.current >= total) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, restart, before.id, after.id, total, compare]);
  function seek(frameIndex: number) {
    setPlaying(false);
    clock.current = after.clip.frames.slice(0, frameIndex).reduce((sum, frame) => sum + frame.durationUs, 0) / 1000;
    setElapsed(clock.current);
  }
  return <div className="acceptance-playback" ref={container}>
    <div className="acceptance-view-options">
      {before.clip.frames.length > 0 && <label><input type="checkbox" checked={compare} onChange={event => setCompare(event.target.checked)} />对比修改前</label>}
      <label>背景<select value={background} onChange={event => setBackground(event.target.value)}><option value="checker">棋盘格</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <label>统一比例<select value={zoom} onChange={event => setZoom(event.target.value)}><option value="fit">整体适应</option><option value="0.5">50%</option><option value="1">100%</option><option value="2">200%</option></select></label>
    </div>
    <div className="acceptance-panes" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {snapshots.map(snapshot => {
        const frameIndex = animationFrameAt(snapshot, elapsed), frame = snapshot.clip.frames[frameIndex];
        const image = frame && snapshot.images[frame.imageId];
        const candidate = snapshot.id === after.id;
        return <section key={candidate ? "after" : "before"} className="acceptance-pane">
          <strong>{candidate ? "候选动画" : "修改前"}</strong>
          <div className={`acceptance-stage acceptance-background-${background}`}>
            {frame && image ? <div className="acceptance-artboard" style={{ width: width * scale, height: height * scale }}>
              <img src={snapshotFrameUrl(snapshot.projectId, snapshot.id, frame.id)} alt={`${candidate ? "候选" : "修改前"}第 ${frameIndex + 1} 帧`} style={{ width: image.width * scale, height: image.height * scale }} />
            </div> : <span>无帧{candidate ? "（接受后动画将为空）" : ""}</span>}
          </div>
          <small>{frame ? `第 ${frameIndex + 1}/${snapshot.clip.frames.length} 帧 · ${frame.durationUs / 1000} ms` : "0 帧"} · {snapshot.clip.loop ? "循环" : "一次"}</small>
        </section>;
      })}
    </div>
    <div className="acceptance-controls">
      <button className="secondary" disabled={total <= 0} onClick={() => setPlaying(value => !value)}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "暂停" : "播放"}</button>
      <button className="secondary" onClick={() => { clock.current = 0; setElapsed(0); setRestart(value => value + 1); setPlaying(true); }}>从头播放</button>
      <button className="secondary" disabled={index <= 0} onClick={() => seek(index - 1)}>上一帧</button>
      <button className="secondary" disabled={index < 0 || index >= after.clip.frames.length - 1} onClick={() => seek(index + 1)}>下一帧</button>
      <span>原速 1×</span>
      <input aria-label="候选动画帧" type="range" min={0} max={Math.max(0, after.clip.frames.length - 1)} value={Math.max(0, index)} disabled={!after.clip.frames.length} onChange={event => seek(Number(event.target.value))} />
    </div>
  </div>;
}

export function AnimationAcceptanceDialog({ id, projectId, title, animations, parameters, feedback, onFeedback, busy, error, onDecide, onClose }: {
  id: string;
  projectId: string;
  title: string;
  animations: AnimationApprovalPreview[];
  parameters?: Record<string, unknown>;
  feedback: string;
  onFeedback: (text: string) => void;
  busy: boolean;
  error: string;
  onDecide: (accept: boolean) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pairs, setPairs] = useState<Pair[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [framesReady, setFramesReady] = useState(false);
  const [retry, setRetry] = useState(0);
  const pair = pairs?.[selected], animation = animations[selected]!;
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    setPairs(null); setLoadError(""); setSelected(0);
    void Promise.all(animations.map(async item => {
      const [before, after] = await Promise.all([item.beforeSnapshotId, item.previewSnapshotId].map(snapshotId => api<ClipSnapshot>(`/api/projects/${projectId}/snapshots/${snapshotId}`)));
      return { before: before!, after: after! };
    })).then(value => { if (active) setPairs(value); }).catch(error => { if (active) setLoadError(error.message); });
    return () => { active = false; };
  }, [id, retry]);
  useEffect(() => {
    let active = true;
    const images: HTMLImageElement[] = [];
    setFramesReady(false);
    if (!pair) return;
    const urls = new Set([pair.before, pair.after].flatMap(snapshot => snapshot.clip.frames.map(frame => snapshotFrameUrl(projectId, snapshot.id, frame.id))));
    void Promise.all([...urls].map(url => new Promise<void>((resolve, reject) => {
      const image = new Image(); images.push(image);
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("动画帧加载失败；请重试，或拒绝本次提交。"));
      image.src = url;
    }))).then(() => { if (active) setFramesReady(true); }).catch(error => { if (active) setLoadError(error.message); });
    return () => { active = false; for (const image of images) { image.onload = null; image.onerror = null; } };
  }, [pair]);
  const deliveryOnly = animations.every(item => item.deliveryOnly);
  return <dialog ref={dialog} className="animation-acceptance-dialog" aria-labelledby={`animation-acceptance-${id}`} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="acceptance-heading"><div><h2 id={`animation-acceptance-${id}`}>动画播放验收</h2><small>{title}</small></div><button className="icon-button" disabled={busy} aria-label="暂时收起动画验收" onClick={onClose}><X size={18} /></button></header>
    <div className="acceptance-body">
      <p>候选尚未应用。按实际速度查看后决定是否接受；关闭弹窗只会收起，助手仍等待本次决定。</p>
      {animations.length > 1 && <label>查看动画<select value={selected} onChange={event => { setFramesReady(false); setLoadError(""); setSelected(Number(event.target.value)); }}>{animations.map((item, index) => <option key={item.clipId} value={index}>{index + 1}. {item.clipName}</option>)}</select><small>一次决定整批 {animations.length} 个动画及同批配置。</small></label>}
      <h3>{animation.clipName}</h3>
      {pair && <ul className="acceptance-summary">{animationChangeSummary(pair.before, pair.after).map(text => <li key={text}>{text}</li>)}</ul>}
      {!loadError && (!pair || !framesReady) && <p role="status">正在加载固定版本动画帧…</p>}
      {pair && framesReady && !loadError && <CandidatePlayback key={pair.after.id} {...pair} />}
      {loadError && <div role="alert" className="interpolation-warning">{loadError}<button className="secondary" onClick={() => setRetry(value => value + 1)}>重新加载</button></div>}
      {!!animation.warnings.length && <details><summary>已有边界检查提示（{animation.warnings.length}）</summary><ul>{animation.warnings.map((warning, index) => <li key={index}>第 {warning.frameNumber} 帧：左/上/右/下超出 {Object.values(warning.overflow).join(" / ")} 像素</li>)}</ul></details>}
      {animation.deliveryOnly && <p>这是人工草稿的协作结果；接受只会交付待采用版本，不会直接覆盖人工草稿或正式动画。</p>}
      {parameters && <details><summary>本次提交参数（含同批配置）</summary><pre className="acceptance-parameters">{JSON.stringify(parameters, null, 2)}</pre></details>}
      <label className="acceptance-feedback">反馈意见（可选，接受和拒绝都会回传）<textarea aria-label="动画验收反馈意见" maxLength={2000} value={feedback} onChange={event => onFeedback(event.target.value)} /></label>
      {error && <p role="alert" className="interpolation-warning">{error}</p>}
    </div>
    <footer className="acceptance-actions"><button className="secondary" disabled={busy} onClick={() => onDecide(false)}>Deny · 不应用，返回意见</button><button className="primary" disabled={busy || !framesReady || !!loadError} onClick={() => onDecide(true)}>{busy ? "正在处理…" : deliveryOnly ? "Accept · 接受并交付待采用" : animations.length > 1 ? "Accept · 接受并保存整批" : "Accept · 接受并保存"}</button></footer>
  </dialog>;
}
