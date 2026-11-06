import { useEffect, useRef, useState } from "react";
import { Play, Pause } from "lucide-react";
import { snapshotFrameUrl, type ClipSnapshot } from "../studio/model.ts";
/** A single view scale for the complete fixed snapshot; never fit each frame independently. */
export function SnapshotPlayer({snapshot,onClose}:{snapshot:ClipSnapshot;onClose:()=>void}) {
  const [index,setIndex]=useState(0),[playing,setPlaying]=useState(true),[zoom,setZoom]=useState<number|"fit">("fit");
  const [size,setSize]=useState({width:500,height:400});const stage=useRef<HTMLDivElement>(null);
  const frames=snapshot.clip.frames;const first=snapshot.images[frames[0]?.imageId || ""];
  const width=first?.width || 360,height=first?.height || 360;
  const inconsistent=Object.values(snapshot.images).some(i=>i.width!==width || i.height!==height);
  const scale=zoom==="fit"?Math.max(.02,Math.min(size.width/width,size.height/height,3)):zoom;
  useEffect(()=>{const el=stage.current;if(!el)return;const o=new ResizeObserver(([e])=>setSize({width:e!.contentRect.width,height:e!.contentRect.height}));o.observe(el);return()=>o.disconnect();},[]);
  useEffect(()=>{setIndex(0);setPlaying(true);},[snapshot.id]);
  useEffect(()=>{if(!playing||!frames.length)return;let current=index,elapsed=0,last=performance.now(),raf=0;const tick=(now:number)=>{elapsed+=Math.min(now-last,100);last=now;while(elapsed>=frames[current]!.durationUs/1000){elapsed-=frames[current]!.durationUs/1000;if(current===frames.length-1&&!snapshot.clip.loop){setPlaying(false);return;}current=(current+1)%frames.length;setIndex(current);}raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);},[snapshot.id,playing]);
  const frame=frames[index];const image=snapshot.images[frame?.imageId || ""];
  return <div className="snapshot-player"><div className="draft-toolbar"><strong>固定快照播放 · {snapshot.clip.name}</strong><button className="secondary" onClick={onClose}>返回工作对象</button></div>
    <small>快照 {snapshot.id} · 版本 {snapshot.clip.revision}</small>
    {inconsistent&&<p className="interpolation-warning">画布尺寸不一致：保留实际尺寸与统一视图比例，不自动逐帧 fit。请人工检查衔接。</p>}
    <div className="stage checker workflow-stage" ref={stage}><div className="artboard" style={{width:width*scale,height:height*scale}}>{frame&&image&&<img src={snapshotFrameUrl(snapshot.projectId,snapshot.id,frame.id)} alt={`固定快照第 ${index+1} 帧`} style={{width:image.width*scale,height:image.height*scale,maxWidth:"none",maxHeight:"none"}}/>}</div></div>
    <div className="snapshot-controls"><button className="secondary" onClick={()=>setPlaying(v=>!v)}>{playing?<Pause size={14}/>:<Play size={14}/>} {playing?"暂停":"播放"}</button><button onClick={()=>{setIndex(0);setPlaying(false);}}>回到首帧</button><input aria-label="快照播放帧" type="range" min={0} max={Math.max(0,frames.length-1)} value={index} onChange={e=>{setPlaying(false);setIndex(Number(e.target.value));}}/><span>{frames.length?index+1:0}/{frames.length} · {frame?.durationUs/1000 || 0} ms</span><label>统一视图比例<select value={zoom} onChange={e=>setZoom(e.target.value==="fit"?"fit":Number(e.target.value))}><option value="fit">整体适应</option><option value={.5}>50%</option><option value={1}>100%</option><option value={2}>200%</option></select></label></div>
  </div>;
}
