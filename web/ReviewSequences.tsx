import { useEffect, useRef, useState } from "react";
import type { ClipAsset, ClipReview } from "../studio/model.ts";
import type { ReviewSegment, ReviewSequenceSnapshot } from "../studio/workflow-model.ts";
import { api } from "./api.ts";
import { setReviewArchived } from "./review-archive.ts";
import { reviewInspectionReducer, sameReviewIdentity, assertReviewWritable, type ArchivableReviewDefinition, type ReviewInspection, type ReviewInspectionAction } from "./workflow-state.ts";

type Evidence = ClipReview & {
  sequence: ReviewSequenceSnapshot & {
    reviews: ClipReview[];
    coverage: {
      totalFrames: number; frameIds: string[]; complete: boolean;
      ranges: { reviewId: string; start: number; end: number; frameIds: string[] }[];
      boundaries: { from: number; to: number; kind: string; covered: boolean }[];
    };
  };
};

export function ReviewSequences({ projectId, clips, definitions, onDefinition, onRefresh, onPlay }: {
  projectId: string; clips: ClipAsset[]; definitions: ArchivableReviewDefinition[];
  onDefinition: (definition: ArchivableReviewDefinition) => void;
  onRefresh: () => Promise<void>; onPlay: (id: string) => void;
}) {
  const [id, setId] = useState(""), [name, setName] = useState("动作 Review");
  const [loop, setLoop] = useState(true), [segments, setSegments] = useState<ReviewSegment[]>([]);
  const [revision, setRevision] = useState(""), [dirty, setDirty] = useState(false);
  const [snapshots, setSnapshots] = useState<ReviewSequenceSnapshot[]>([]);
  const [inspection, setInspection] = useState<ReviewInspection<Evidence>>({ selected: null, epoch: 0, evidence: null });
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const mounted = useRef(true), epoch = useRef(0), request = useRef({ key: "", id: crypto.randomUUID() });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);

  function inspectState(action: ReviewInspectionAction<Evidence>) {
    setInspection(old => reviewInspectionReducer(old, action));
  }
  async function run(label: string, action: () => Promise<void>) {
    setBusy(label); setError("");
    try { await action(); }
    catch (error) { if (mounted.current) setError((error as Error).message); }
    finally { if (mounted.current) setBusy(""); }
  }
  async function loadSnapshots(definitionId: string) {
    const token = ++epoch.current;
    const next = await api<ReviewSequenceSnapshot[]>(`/api/projects/${projectId}/review-sequences/${definitionId}/snapshots`);
    if (!mounted.current || token !== epoch.current) return;
    setSnapshots(next);
    setInspection(old => {
      if (old.selected && next.some(snapshot => sameReviewIdentity(old.selected, snapshot))) return old;
      return reviewInspectionReducer(old, { type: "select", snapshot: old.selected ? null : next[0] || null });
    });
  }
  function choose(nextId: string) {
    if (dirty && !window.confirm("切换会放弃未保存的 Review 定义输入，是否继续？")) return;
    epoch.current++; setId(nextId); setDirty(false); setSnapshots([]); setError("");
    inspectState({ type: "select", snapshot: null });
    const next = definitions.find(definition => definition.id === nextId);
    setName(next?.name || "动作 Review"); setLoop(next?.loop ?? true);
    setSegments(structuredClone(next?.segments || [])); setRevision(next?.revision || "");
    if (next) void run("载入快照", () => loadSnapshots(next.id));
  }
  const definition = definitions.find(definition => definition.id === id);
  const staleDefinition = !!definition && definition.revision !== revision;
  const archived = definition?.archived === true;
  const selected = snapshots.find(snapshot => sameReviewIdentity(inspection.selected, snapshot));
  const evidence = selected && inspection.evidence && sameReviewIdentity(selected, inspection.evidence.sequence) ? inspection.evidence : null;
  const isStale = (snapshot: ReviewSequenceSnapshot) => snapshot.stale ||
    snapshot.definitionRevision !== definitions.find(definition => definition.id === snapshot.definitionId)?.revision ||
    snapshot.dependencies.some(dependency => clips.find(clip => clip.id === dependency.clipId)?.revision !== dependency.revision);

  function update(index: number, patch: Partial<ReviewSegment>) {
    setDirty(true); setSegments(old => old.map((segment, i) => i === index ? { ...segment, ...patch } : segment));
  }
  async function save() {
    await run("保存定义", async () => {
      assertReviewWritable(definition);
      inspectState({ type: "select", snapshot: null });
      const body = { name, loop, segments }, key = JSON.stringify(body);
      if (request.current.key !== key) request.current = { key, id: crypto.randomUUID() };
      const next = await api<ArchivableReviewDefinition>(`/api/projects/${projectId}/review-sequences${id ? `/${id}` : ""}`, {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(id ? { ...body, expectedRevision: revision } : { ...body, requestId: request.current.id }),
      });
      if (!mounted.current) return;
      onDefinition(next);
      setId(next.id); setRevision(next.revision); setDirty(false);
      await onRefresh(); await loadSnapshots(next.id);
    });
  }
  async function capture() {
    await run("捕获快照", async () => {
      assertReviewWritable(definition);
      inspectState({ type: "select", snapshot: null });
      const next = await api<ReviewSequenceSnapshot>(`/api/projects/${projectId}/review-sequences/${id}/capture`, { method: "POST", body: "{}" });
      if (!mounted.current) return;
      setSnapshots(old => [next, ...old.filter(snapshot => snapshot.id !== next.id)]);
      inspectState({ type: "select", snapshot: next });
      await loadSnapshots(id);
      if (mounted.current) onPlay(next.snapshotId);
    });
  }
  async function changeArchive(archivedValue: boolean) {
    await run(archivedValue ? "归档定义" : "恢复定义", async () => {
      const next = await setReviewArchived(projectId, definition, revision, dirty, archivedValue);
      if (!mounted.current) return;
      // Publish the acknowledged flag before refresh; an older list must not briefly enable capture.
      onDefinition(next); setRevision(next.revision);
      await onRefresh();
    });
  }
  function discardDefinitionEdits() {
    if (!definition || !dirty || !window.confirm("明确放弃当前未保存的 Review 定义修改，恢复已保存定义？历史快照不会删除。")) return;
    setName(definition.name); setLoop(definition.loop); setSegments(structuredClone(definition.segments));
    setRevision(definition.revision); setDirty(false); setError("");
  }
  async function inspect() {
    if (!selected) return;
    const inspectedEpoch = inspection.epoch, requestedSnapshot = selected;
    await run("检查快照", async () => {
      const next = await api<Evidence>(`/api/projects/${projectId}/review-sequences/${id}/inspect`, {
        method: "POST", body: JSON.stringify({ snapshotId: requestedSnapshot.id }),
      });
      if (!mounted.current) return;
      if (!sameReviewIdentity(requestedSnapshot, next.sequence)) throw new Error("检查响应快照身份不匹配，未显示其证据");
      inspectState({ type: "inspect", epoch: inspectedEpoch, evidence: next });
    });
  }

  return <section className="review-sequences">
    <h3>多动作 Review</h3>
    <p>仅播放明确选择的动画与区间；不按文件名推断组合。保存定义后捕获固定依赖快照。</p>
    <label>Review 定义<select value={id} disabled={!!busy} onChange={event => choose(event.target.value)}>
      <option value="">新定义</option>{definitions.map(definition => <option key={definition.id} value={definition.id}>{definition.name}{definition.archived ? " · 已归档" : ""}</option>)}
    </select></label>
    {id && <div className="review-archive">
      <p role="status">{archived ? "已归档：定义只读，不能捕获新快照；历史快照、检查与播放仍可使用。" : "归档可恢复，不删除资源或历史快照；仍被活动任务要求时服务会拒绝归档。"}</p>
      <button className="secondary" disabled={!!busy || !definition || dirty || staleDefinition} onClick={() => void changeArchive(!archived)}>{archived ? "恢复 Review 定义" : "归档 Review 定义"}</button>
      {dirty && <><small>有未保存的定义修改，先保存或明确放弃，再归档/恢复。</small><button disabled={!!busy || !definition} onClick={discardDefinitionEdits}>明确放弃未保存定义修改</button></>}
    </div>}
    <fieldset disabled={!!busy || archived}><legend>Review 定义编排（与动画草稿分开）</legend>
      <label>名称<input value={name} maxLength={100} onChange={event => { setName(event.target.value); setDirty(true); }}/></label>
      <label><input type="checkbox" checked={loop} onChange={event => { setLoop(event.target.checked); setDirty(true); }}/>整个序列循环</label>
      {segments.map((segment, index) => {
        const clip = clips.find(clip => clip.id === segment.clipId);
        return <fieldset key={segment.id}><legend>片段 {index + 1}</legend>
          <label>动画<select value={segment.clipId} onChange={event => update(index, { clipId: event.target.value, startFrameId: undefined, endFrameId: undefined })}>
            {!clip && <option value={segment.clipId}>动画已移除</option>}{clips.map(clip => <option key={clip.id} value={clip.id}>{clip.name}</option>)}
          </select></label>
          {(["startFrameId", "endFrameId"] as const).map(key => <label key={key}>{key === "startFrameId" ? "起始帧" : "结束帧"}
            <select value={segment[key] || ""} onChange={event => update(index, { [key]: event.target.value || undefined })}>
              <option value="">{key === "startFrameId" ? "从首帧" : "到末帧"}</option>{clip?.frames.map((frame, i) => <option key={frame.id} value={frame.id}>第 {i + 1} 帧 · {frame.id.slice(0, 8)}</option>)}
            </select>
          </label>)}
          <label>重复次数<input type="number" min={1} max={128} value={segment.repeat} onChange={event => update(index, { repeat: Math.max(1, Math.round(Number(event.target.value))) })}/></label>
          <label>播放速度倍率<input type="number" min={.05} max={20} step={.1} value={segment.speed} onChange={event => update(index, { speed: Math.max(.05, Number(event.target.value)) })}/></label>
          <button disabled={index === 0} onClick={() => { setSegments(old => { const next = [...old]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next; }); setDirty(true); }}>上移片段</button>
          <button onClick={() => { setSegments(old => old.filter(item => item.id !== segment.id)); setDirty(true); }}>移除片段</button>
        </fieldset>;
      })}
      <div className="task-actions">
        <button disabled={!clips.length} onClick={() => { setSegments(old => [...old, { id: crypto.randomUUID(), clipId: clips[0]!.id, repeat: 1, speed: 1 }]); setDirty(true); }}>添加片段</button>
        <button className="secondary" disabled={!!busy || archived || !name.trim() || !segments.length || staleDefinition} onClick={() => void save()}>保存 Review 定义</button>
        <button className="secondary" disabled={!!busy || archived || !id || dirty || staleDefinition} onClick={() => void capture()}>捕获并播放固定快照</button>
      </div>
    </fieldset>
    {staleDefinition && <p className="interpolation-warning">定义版本已变化。输入保留，请复制后重新选择此定义，不能静默覆盖。</p>}
    {!!snapshots.length && <>
      <label>历史固定快照<select value={selected?.id || ""} disabled={!!busy} onChange={event => inspectState({ type: "select", snapshot: snapshots.find(snapshot => snapshot.id === event.target.value) || null })}>
        {!selected && <option value="">请选择固定快照</option>}{snapshots.map(snapshot => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.createdAt).toLocaleString()} · {isStale(snapshot) ? "依赖已过期" : "依赖当前"}</option>)}
      </select></label>
      <button disabled={!selected} onClick={() => selected && onPlay(selected.snapshotId)}>播放所选快照</button>
      <button disabled={!!busy || !selected} onClick={() => void inspect()}>查看此快照的检查证据</button>
      <button disabled={!!busy} onClick={() => void run("刷新依赖", () => loadSnapshots(id))}>刷新过期状态</button>
      {selected && <p>{isStale(selected) ? "依赖或定义已改变；此历史快照仍可播放，但不能证明当前成果。" : "此快照固定已保存的依赖，不包含人工尚未保存的动画草稿。"}</p>}
      <details><summary>依赖版本与区间映射</summary><pre>{JSON.stringify(selected, null, 2)}</pre></details>
    </>}
    {evidence && <div>
      <strong>静态证据 · 动态仍待人工验收</strong>
      <small>序列快照 {evidence.sequence.id} · 播放快照 {evidence.sequence.snapshotId}</small>
      <p>覆盖 {evidence.sequence.coverage.frameIds.length}/{evidence.sequence.coverage.totalFrames} 帧 · {evidence.sequence.coverage.complete ? "证据覆盖完整" : "证据覆盖不完整"}；衔接边界 {evidence.sequence.coverage.boundaries.filter(boundary => boundary.covered).length}/{evidence.sequence.coverage.boundaries.length}</p>
      {evidence.sequence.reviews.map(review => <details key={review.id}><summary>检查证据 {review.id} · {review.frames.length} 帧</summary>
        {(["contact", "onion"] as const).map(kind => <a key={kind} target="_blank" rel="noreferrer" href={`/api/projects/${projectId}/reviews/${review.id}/${kind}`}><img className="review-evidence-image" src={`/api/projects/${projectId}/reviews/${review.id}/${kind}`} alt={kind === "contact" ? "静态联系图证据" : "叠图证据"}/></a>)}
      </details>)}
    </div>}
    {(busy || error) && <p role={error ? "alert" : "status"} className={error ? "interpolation-warning" : ""}>{error || busy}</p>}
  </section>;
}
