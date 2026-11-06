import { useEffect, useRef, useState } from "react";
import type { ClipAsset, ClipReview } from "../studio/model.ts";
import type { ReviewSegment, ReviewSequenceDefinition, ReviewSequenceSnapshot } from "../studio/workflow-model.ts";
import { api } from "./api.ts";
type Evidence = ClipReview & { sequence: ReviewSequenceSnapshot & { reviews: ClipReview[]; coverage: { totalFrames:number; frameIds:string[]; complete:boolean; ranges:{reviewId:string;start:number;end:number;frameIds:string[]}[]; boundaries:{from:number;to:number;kind:string;covered:boolean}[] } } };
export function ReviewSequences({projectId,clips,definitions,onRefresh,onPlay}:{projectId:string;clips:ClipAsset[];definitions:ReviewSequenceDefinition[];onRefresh:()=>Promise<void>;onPlay:(id:string)=>void}) {
  const [id,setId]=useState(""),[name,setName]=useState("动作 Review"),[loop,setLoop]=useState(true),[segments,setSegments]=useState<ReviewSegment[]>([]);
  const [revision,setRevision]=useState(""),[dirty,setDirty]=useState(false),[snapshots,setSnapshots]=useState<ReviewSequenceSnapshot[]>([]),[snapshotId,setSnapshotId]=useState("");
  const [evidence,setEvidence]=useState<Evidence|null>(null),[busy,setBusy]=useState(""),[error,setError]=useState("");
  const mounted=useRef(true),epoch=useRef(0),request=useRef({key:"",id:crypto.randomUUID()});
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;};},[]);
  async function run(label:string,action:()=>Promise<void>) {setBusy(label);setError("");try{await action();}catch(error){if(mounted.current)setError((error as Error).message);}finally{if(mounted.current)setBusy("");}}
  async function loadSnapshots(definitionId:string) { const token=++epoch.current;const next=await api<ReviewSequenceSnapshot[]>(`/api/projects/${projectId}/review-sequences/${definitionId}/snapshots`);if(mounted.current&&token===epoch.current)setSnapshots(next); }
  function choose(nextId:string) {
    if(dirty&&!window.confirm("切换会放弃未保存的 Review 定义输入，是否继续？"))return;
    epoch.current++;setId(nextId);setDirty(false);setEvidence(null);setSnapshots([]);setSnapshotId("");setError("");
    const next=definitions.find(d=>d.id===nextId);setName(next?.name || "动作 Review");setLoop(next?.loop ?? true);setSegments(structuredClone(next?.segments || []));setRevision(next?.revision || "");
    if(next)void run("载入快照",()=>loadSnapshots(next.id));
  }
  const definition=definitions.find(d=>d.id===id);
  const staleDefinition=!!definition&&definition.revision!==revision;
  function update(index:number,patch:Partial<ReviewSegment>) {setDirty(true);setSegments(old=>old.map((s,i)=>i===index?{...s,...patch}:s));}
  async function save() {await run("保存定义",async()=>{
    const body={name,loop,segments};const key=JSON.stringify(body);if(request.current.key!==key)request.current={key,id:crypto.randomUUID()};
    const next=await api<ReviewSequenceDefinition>(`/api/projects/${projectId}/review-sequences${id?`/${id}`:""}`,{method:id?"PUT":"POST",body:JSON.stringify(id?{...body,expectedRevision:revision}:{...body,requestId:request.current.id})});
    if(!mounted.current)return;setId(next.id);setRevision(next.revision);setDirty(false);await onRefresh();await loadSnapshots(next.id);
  });}
  const selected=snapshots.find(s=>s.id===snapshotId) || snapshots[0];
  const isStale = (snapshot: ReviewSequenceSnapshot) => snapshot.stale || snapshot.definitionRevision !== definitions.find(def => def.id === snapshot.definitionId)?.revision || snapshot.dependencies.some(dependency => clips.find(clip => clip.id === dependency.clipId)?.revision !== dependency.revision);
  return <section className="review-sequences"><h3>多动作 Review</h3><p>仅播放明确选择的动画与区间；不按文件名推断组合。保存定义后捕获固定依赖快照。</p>
    <label>Review 定义<select value={id} disabled={!!busy} onChange={e=>choose(e.target.value)}><option value="">新定义</option>{definitions.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
    <fieldset disabled={!!busy}><legend>Review 定义编排（与动画草稿分开）</legend>
    <label>名称<input value={name} maxLength={100} onChange={e=>{setName(e.target.value);setDirty(true);}}/></label><label><input type="checkbox" checked={loop} onChange={e=>{setLoop(e.target.checked);setDirty(true);}}/>整个序列循环</label>
    {segments.map((segment,index)=>{
      const clip=clips.find(c=>c.id===segment.clipId);
      return <fieldset key={segment.id}><legend>片段 {index+1}</legend><label>动画<select value={segment.clipId} onChange={e=>update(index,{clipId:e.target.value,startFrameId:undefined,endFrameId:undefined})}>{!clip&&<option value={segment.clipId}>动画已移除</option>}{clips.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        {(["startFrameId","endFrameId"] as const).map(key=><label key={key}>{key==="startFrameId"?"起始帧":"结束帧"}<select value={segment[key] || ""} onChange={e=>update(index,{[key]:e.target.value || undefined})}><option value="">{key==="startFrameId"?"从首帧":"到末帧"}</option>{clip?.frames.map((f,i)=><option key={f.id} value={f.id}>第 {i+1} 帧 · {f.id.slice(0,8)}</option>)}</select></label>)}
        <label>重复次数<input type="number" min={1} max={128} value={segment.repeat} onChange={e=>update(index,{repeat:Math.max(1,Math.round(Number(e.target.value)))})}/></label><label>播放速度倍率<input type="number" min={.05} max={20} step={.1} value={segment.speed} onChange={e=>update(index,{speed:Math.max(.05,Number(e.target.value))})}/></label>
        <button disabled={index===0} onClick={()=>{setSegments(old=>{const next=[...old];[next[index-1],next[index]]=[next[index]!,next[index-1]!];return next;});setDirty(true);}}>上移片段</button><button onClick={()=>{setSegments(old=>old.filter(s=>s.id!==segment.id));setDirty(true);}}>移除片段</button>
      </fieldset>;
    })}
    <div className="task-actions"><button disabled={!clips.length} onClick={()=>{setSegments(old=>[...old,{id:crypto.randomUUID(),clipId:clips[0]!.id,repeat:1,speed:1}]);setDirty(true);}}>添加片段</button><button className="secondary" disabled={!!busy || !name.trim() || !segments.length || staleDefinition} onClick={()=>void save()}>保存 Review 定义</button><button className="secondary" disabled={!!busy || !id || dirty || staleDefinition} onClick={()=>void run("捕获快照",async()=>{const next=await api<ReviewSequenceSnapshot>(`/api/projects/${projectId}/review-sequences/${id}/capture`,{method:"POST",body:"{}"});if(!mounted.current)return;setSnapshotId(next.id);await loadSnapshots(id);onPlay(next.snapshotId);})}>捕获并播放固定快照</button></div>
    </fieldset>
    {staleDefinition&&<p className="interpolation-warning">定义版本已变化。输入保留，请复制后重新选择此定义，不能静默覆盖。</p>}
    {!!snapshots.length&&<><label>历史固定快照<select value={selected?.id || ""} disabled={!!busy} onChange={e=>{setSnapshotId(e.target.value);setEvidence(null);}}>{snapshots.map(s=><option key={s.id} value={s.id}>{new Date(s.createdAt).toLocaleString()} · {isStale(s)?"依赖已过期":"依赖当前"}</option>)}</select></label>
      <button onClick={()=>selected&&onPlay(selected.snapshotId)}>播放所选快照</button><button disabled={!!busy || !selected} onClick={()=>void run("检查快照",async()=>{const next=await api<Evidence>(`/api/projects/${projectId}/review-sequences/${id}/inspect`,{method:"POST",body:JSON.stringify({snapshotId:selected!.id})});if(mounted.current)setEvidence(next);})}>查看此快照的检查证据</button><button disabled={!!busy} onClick={()=>void run("刷新依赖",()=>loadSnapshots(id))}>刷新过期状态</button>
      <p>{selected&&isStale(selected)?"依赖或定义已改变；此历史快照仍可播放，但不能证明当前成果。":"此快照固定已保存的依赖，不包含人工尚未保存的动画草稿。"}</p><details><summary>依赖版本与区间映射</summary><pre>{JSON.stringify(selected,null,2)}</pre></details>
    </>}
    {evidence&&<div><strong>静态证据 · 动态仍待人工验收</strong>{evidence.sequence.coverage&&<p>覆盖 {evidence.sequence.coverage.frameIds.length}/{evidence.sequence.coverage.totalFrames} 帧 · {evidence.sequence.coverage.complete?"证据覆盖完整":"证据覆盖不完整"}；衔接边界 {evidence.sequence.coverage.boundaries.filter(b=>b.covered).length}/{evidence.sequence.coverage.boundaries.length}</p>}
      {(evidence.sequence.reviews || [evidence]).map(review=><details key={review.id}><summary>检查证据 {review.id} · {review.frames.length} 帧</summary>{(["contact","onion"] as const).map(kind=><a key={kind} target="_blank" rel="noreferrer" href={`/api/projects/${projectId}/reviews/${review.id}/${kind}`}><img className="review-evidence-image" src={`/api/projects/${projectId}/reviews/${review.id}/${kind}`} alt={kind==="contact"?"静态联系图证据":"叠图证据"}/></a>)}</details>)}
    </div>}
    {(busy || error)&&<p role={error?"alert":"status"} className={error?"interpolation-warning":""}>{error || busy}</p>}
  </section>;
}
