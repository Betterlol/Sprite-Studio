import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { directionMaterial, directionPayload, taskFeedbackPayload, taskSaveApproval, taskCreationTarget, taskTargetSummary, taskReviewContract, type TaskCreationScope } from "./workflow-state.ts";
import { assetUrl, type Asset, type Session } from "../studio/model.ts";
import type { EditingContext, ProductionTask, QualityCapabilities, ClipDraft, ReviewSequenceDefinition } from "../studio/workflow-model.ts";
const phases = {direction:"方向确认",production:"制作中",delivery:"交付"};
const statuses = {running:"运行中",waiting:"等待",paused:"已暂停",blocked:"受阻",ready:"可验收",accepted:"已接受",stopped:"已停止",failed:"失败"};
const reasons = {direction:"等待方向决定",tool_approval:"等待工具审批",scope:"需要范围确认",version_conflict:"版本冲突",budget:"预算不足",capability:"能力尚未验证"};
export function QualityStatus({capabilities}:{capabilities?:QualityCapabilities}) {
  return <div className="quality-capabilities"><strong>检查能力边界</strong><p>静态检查：{capabilities?.static.verified ? capabilities.static.categories.join("、") || "可用" : "尚未验证"}。具体通过范围以快照证据为准。</p><p>动态时序：{capabilities?.temporal.verified ? `受控类别 ${capabilities.temporal.categories.join("、")}；仍需人工播放验收` : "未验证 · 待人工实际播放验收"}。</p><p>无人值守重生成不可用。{capabilities?.reason || "尚无已验证的生成调用前预算硬限制。"}</p></div>;
}
export function TaskCenter({projectId,tasks,sessions,assets,clipDrafts,reviewSequences,referenceIds,context:editingContext,selectedTaskId,onSelect,onCreated,onRefresh,onHandoff,stabilize,onPlay,onBrowse}: {
  projectId:string; tasks:ProductionTask[]; sessions:Session[]; assets:Asset[]; clipDrafts:ClipDraft[]; reviewSequences:ReviewSequenceDefinition[]; referenceIds:string[]; context?:EditingContext; selectedTaskId:string;
  onSelect:(id:string)=>void; onCreated:(task:ProductionTask)=>void; onRefresh:()=>Promise<void>; onHandoff:(task:ProductionTask)=>void;
  stabilize:()=>Promise<EditingContext | undefined>; onPlay:(snapshotId:string)=>void; onBrowse:(id:string)=>void;
}) {
  const [description,setDescription]=useState(""),[feedback,setFeedback]=useState<Record<string,string>>({}),[busy,setBusy]=useState(""),[errors,setErrors]=useState<Record<string,string>>({});
  const [feedbackKinds,setFeedbackKinds]=useState<Record<string,"local"|"direction">>({}),[locations,setLocations]=useState<Record<string,string>>({});
  const [reviewSequenceId,setReviewSequenceId]=useState("");
  const selectedReview=reviewSequences.find(definition=>definition.id===reviewSequenceId);
  const invalidReview=!!reviewSequenceId&&(!selectedReview||selectedReview.archived);
  const [creationScope,setCreationScope]=useState<TaskCreationScope>("selection");
  useEffect(()=>setCreationScope("selection"),[editingContext?.clipId,editingContext?.assetId]);
  const invalidScope=creationScope==="frame" && !!editingContext?.clipId && !editingContext.frameId;
  const scopePreview=invalidScope?undefined:taskCreationTarget(editingContext,creationScope);
  const request=useRef({key:"",id:crypto.randomUUID()}), mounted=useRef(true);
  useEffect(() => { mounted.current=true; return () => { mounted.current=false; }; },[]);
  const target=tasks.find(t=>t.id===selectedTaskId);
  const attention=tasks.filter(t=>t.phase==="direction"&&!(t.direction?.accept&&t.direction.intentVersion===t.intentVersion)&&sessions.some(s=>s.id===t.sessionId&&s.toolApproval?.tool==="save_image"));
  const cards=target?[target,...attention.filter(task=>task.id!==target.id)]:attention;
  async function run(key:string,action:()=>Promise<void>) { setBusy(key);setErrors(v=>({...v,[key]:""}));try{await action();}catch(error){setErrors(v=>({...v,[key]:(error as Error).message}));}finally{setBusy("");} }
  async function create() {
    await run("create",async()=>{
      const context=taskCreationTarget(await stabilize(),creationScope);
      const contract=taskReviewContract(reviewSequenceId,reviewSequences);
      const key=JSON.stringify({description,target:context,referenceIds,contract});
      if(request.current.key!==key)request.current={key,id:crypto.randomUUID()};
      const task=await api<ProductionTask>(`/api/projects/${projectId}/tasks`,{method:"POST",body:JSON.stringify({requestId:request.current.id,title:description.trim().slice(0,80),description:description.trim(),target:context,referenceIds,contract})});
      if (!mounted.current) return;
      onCreated(task);setDescription("");setCreationScope("selection");await onRefresh();
    });
  }
  async function action(task:ProductionTask,action:string) {
    await run(task.id,async()=>{
      const session=sessions.find(session=>session.id===task.sessionId);
      const kind=feedbackKinds[task.id] || (task.direction?.accept&&task.direction.intentVersion===task.intentVersion?"local":"direction");
      const body=action==="feedback" || action==="save-location" ? taskFeedbackPayload(task,action,action==="save-location"?locations[task.id] || "":feedback[task.id] || "",session,kind) : {expectedRevision:task.revision,action,...(action==="accept"?{snapshotId:task.readySnapshotId}:{})};
      const next=await api<ProductionTask>(`/api/projects/${projectId}/tasks/${task.id}/actions`,{method:"POST",body:JSON.stringify(body)});
      if (!mounted.current) return;
      if(action==="handoff")onHandoff(next);
      if(action==="feedback")setFeedback(v=>({...v,[task.id]:""}));
      if(action==="save-location")setLocations(v=>({...v,[task.id]:""}));
      await onRefresh();
    });
  }
  async function direction(task:ProductionTask,accept:boolean) {
    await run(task.id,async()=>{
      const session=sessions.find(s=>s.id===task.sessionId);
      await api<ProductionTask>(`/api/projects/${projectId}/tasks/${task.id}/direction`,{method:"POST",body:JSON.stringify(directionPayload(task,session,accept,feedback[task.id] || ""))});
      if (!mounted.current) return;
      setFeedback(v=>({...v,[task.id]:""}));await onRefresh();
    });
  }
  return <section className="task-center" aria-label="制作任务">
    <details><summary>从明确目标范围创建制作任务</summary>
      {editingContext?.clipId && <label>任务目标范围<select aria-label="新任务目标范围" disabled={!!busy} value={creationScope} onChange={event=>setCreationScope(event.target.value as TaskCreationScope)}><option value="selection">当前选择（有区间则保留区间）</option><option value="frame" disabled={!editingContext.frameId}>仅当前帧实例</option><option value="whole">整个动画（明确取消帧/区间限定）</option></select></label>}
      <p className="context-chip">{invalidScope?"当前帧已不可解析，请明确重选任务范围":taskTargetSummary(scopePreview)}</p>
      <label>明确必查的跨动作 Review<select aria-label="任务必查Review" value={reviewSequenceId} disabled={!!busy} onChange={event=>setReviewSequenceId(event.target.value)}><option value="">未指定跨动作关系</option>{reviewSequences.map(definition=><option key={definition.id} value={definition.id} disabled={definition.archived}>{definition.name}{definition.archived?" · 已归档":""}</option>)}</select></label>
      <p>{reviewSequenceId?`必查Review：${selectedReview?.name || reviewSequenceId}；全批次检查与来源依赖将纳入交付资格。`:"未指定跨动作关系：仅检查目标自身，不宣称已检查进入/退出关系。"}</p>
      <label>制作描述<textarea aria-label="新任务描述" disabled={!!busy} value={description} onChange={e=>setDescription(e.target.value)} maxLength={2000}/></label>
      <button className="secondary" disabled={!!busy || !description.trim() || invalidScope || !!invalidReview} onClick={()=>void create()}>按此明确范围创建任务</button>{errors.create&&<p role="alert">{errors.create}</p>}
    </details>
    <label>正在讨论的任务（浏览素材不改任务目标）<select value={selectedTaskId} onChange={e=>onSelect(e.target.value)}><option value="">普通对话 · 不关联任务</option>{tasks.map(task=><option key={task.id} value={task.id}>{task.title} · {statuses[task.status]}</option>)}</select></label>
    <div className="task-list">{tasks.map(task => <button className="text-button" key={task.id} onClick={() => onSelect(task.id)}>{task.title} · {phases[task.phase]} / {statuses[task.status]}{task.waitReason ? ` · ${reasons[task.waitReason]}` : ""}</button>)}</div>
    {cards.map(task=>{
      const session=sessions.find(s=>s.id===task.sessionId);
      const approval=taskSaveApproval(task,session);
      const material=directionMaterial(task,session);
      const result=material?.kind==="asset"?assets.find(a=>a.id===material.assetId):undefined;
      const frozenTarget=assets.find(a=>a.id===(task.target?.clipId || task.target?.assetId));
      const stale=!!task.target?.revision&&!!frozenTarget&&frozenTarget.revision!==task.target.revision;
      const hasDirection=task.direction?.accept&&task.direction.intentVersion===task.intentVersion;
      return <article className="task-card" key={task.id}>
        <strong>{task.title}</strong><p>{phases[task.phase]} · {statuses[task.status]}{task.waitReason?` · ${reasons[task.waitReason]}`:""}</p>
        <small>任务 v{task.revision} · 意图 {task.intentVersion} · 写入屏障 {task.barrierVersion}</small>
        <button className="text-button" disabled={!frozenTarget} onClick={()=>onBrowse(frozenTarget!.id)}>固定目标：{frozenTarget?.name || task.target?.clipId || task.target?.assetId || "未指定对象"}</button>
        <p>{task.description}</p>
        <p>{task.contract.reviewSequenceId?`必查跨动作Review：${reviewSequences.find(definition=>definition.id===task.contract.reviewSequenceId)?.name || task.contract.reviewSequenceId} · 进入ready/accept前核对完整证据及当前依赖。`:"未指定跨动作关系；本任务不宣称已检查进入/退出关系。"}</p>
        <details><summary>冻结范围、参考与制作约定</summary><pre>{JSON.stringify({target:task.target,referenceIds:task.referenceIds,contract:task.contract},null,2)}</pre></details>
        <p>生成上限 {task.contract.generationLimit} 次；无人值守重生成不可用，动态时序待人工播放验收。</p>
        {stale&&<p className="interpolation-warning">目标当前已修改；旧决定和验收仅指向原快照，需重新检查。</p>}
        {task.attempts.at(-1)?.status==="unknown" && material?.kind==="generated" && <p role="status" className="interpolation-warning">执行终态未知；下图是此请求已留存的确切产物。请人工检查已有产物后显式决定方向；此操作不会重发、重生成或自动核销未知请求。</p>}
        {material?.kind==="generated"&&<img className="approval-image" src={`/api/projects/${projectId}/generated/${material.generatedId}/image`} alt="此次方向决定对应的确切生成图集"/>}
        {result?.type==="image"&&<button onClick={()=>onBrowse(result.id)}><img className="approval-image" src={assetUrl(projectId,result.id,result.revision)} alt="已保存方向产物"/>查看已有图片</button>}
        {material?.kind==="snapshot"&&<button className="secondary" onClick={()=>onPlay(material.snapshotId)}>播放此次方向的固定粗动画</button>}
        {task.target?.snapshotId && material?.kind!=="snapshot"&&<button className="text-button" onClick={()=>onPlay(task.target!.snapshotId!)}>查看输入参考快照（不是此次方向产物）</button>}
        {approval && <details><summary>冻结的保存请求参数</summary><pre>{JSON.stringify(approval.arguments,null,2)}</pre></details>}
        {task.phase==="direction"&&!hasDirection&&<>
          <p>{approval?`方向通过将同时批准此冻结保存请求：${approval.arguments.type==="reference"?"参考图":"原图素材"}/${String(approval.arguments.folder || "")}/${String(approval.arguments.name || "")}`:"产物已保存或保存无需审批；方向决定独立记录，不表示动态验收通过。"}</p>
          <p>仅改保存位置请使用独立的位置意见入口；旧冻结请求会被拒绝，助手使用同一生成图重新提请保存，不重新生成，也不改变方向认可。</p>
          <button className="primary" disabled={!!busy || !material} onClick={()=>void direction(task,true)}>{approval?"方向通过并保存，继续制作":"方向通过，继续制作"}</button>
          <button className="secondary" disabled={!!busy || !material} onClick={()=>void direction(task,false)}>方向不对，返回意见</button>
        </>}
        {hasDirection&&<p>方向已通过；工具执行与保存结果另行记录。</p>}
        {task.attempts.map(a=><p key={a.id}>生成尝试：{a.status} {a.reason || ""}{a.status==="unknown"?" · 结果未知，不能自动重发":""}</p>)}
        <label>反馈类型<select aria-label="任务反馈类型" value={feedbackKinds[task.id] || (hasDirection?"local":"direction")} disabled={!!busy} onChange={e=>setFeedbackKinds(old=>({...old,[task.id]:e.target.value as "local"|"direction"}))}><option value="local" disabled={!hasDirection}>局部调整（保留方向）</option><option value="direction">改变方向（重新确认）</option></select></label>
        <label>调整意见<textarea aria-label="任务反馈" disabled={!!busy} value={feedback[task.id] || ""} onChange={e=>setFeedback(v=>({...v,[task.id]:e.target.value}))}/></label>
        {approval&&<fieldset disabled={!!busy}><legend>只修改保存位置（不重新生成）</legend><label>位置意见<textarea aria-label="保存位置意见" value={locations[task.id] || ""} onChange={e=>setLocations(old=>({...old,[task.id]:e.target.value}))}/></label><button disabled={!locations[task.id]?.trim()} onClick={()=>void action(task,"save-location")}>拒绝旧保存并提交位置意见</button><small>不会直接执行新位置；助手必须以新冻结请求重新提请保存。</small></fieldset>}
        <div className="task-actions">
          <button disabled={!!busy || !feedback[task.id]?.trim() || (feedbackKinds[task.id]==="local"&&!hasDirection)} onClick={()=>void action(task,"feedback")}>提交所选类型反馈</button>
          <button disabled={!!busy || task.status==="paused" || ["stopped","accepted"].includes(task.status)} onClick={()=>void action(task,"pause")}>暂停</button>
          <button disabled={!!busy || !["paused","blocked","waiting"].includes(task.status)} onClick={()=>void action(task,"resume")}>继续</button>
          <button disabled={!!busy || ["stopped","accepted"].includes(task.status)} onClick={()=>void action(task,"stop")}>停止</button>
          <button disabled={!!busy || ["accepted","stopped","failed"].includes(task.status)} onClick={()=>void action(task,"handoff")}>我来接手</button>
          <button disabled={!!busy || ["accepted","stopped","failed","ready"].includes(task.status)} onClick={()=>void action(task,"ready")}>请求标记可验收</button>
        </div>
        {clipDrafts.filter(draft => draft.delivery && task.drafts?.some(entry => entry.draftId === draft.id && entry.intentVersion === task.intentVersion)).map(draft => <section key={draft.id} aria-label="任务协作交付">
          <strong>助手结果待显式采用 · 尚未保存正式动画</strong><small>结果正文 {draft.delivery!.documentRevision}</small>
          <button onClick={() => onPlay(draft.delivery!.snapshotId)}>播放确切协作结果</button><button onClick={() => onBrowse(draft.clipId)}>返回来源动画，接手后采用到我的草稿</button>
          <p>采用只替换来源人工草稿，仍需人明确保存动画；该结果不能把旧正式版本标为可验收。</p>
        </section>)}
        {task.reviewEvidence?.map(evidence => <details key={evidence.id}><summary>必查 Review · {evidence.coverage.complete ? "全批次证据完整" : "覆盖不完整"} · 动态待人工验收</summary><p>关联意图 {evidence.intentVersion} · 目标快照 {evidence.targetSnapshotId}</p><p>覆盖 {evidence.coverage.frameIds.length}/{evidence.coverage.totalFrames} 帧，{evidence.coverage.reviewIds.length} 批；历史证据不自动授权新依赖。</p><button onClick={() => onPlay(evidence.snapshotId)}>播放必查 Review 固定快照</button><pre>{JSON.stringify(evidence,null,2)}</pre></details>)}
        {task.readySnapshotId&&<><button className="secondary" onClick={()=>onPlay(task.readySnapshotId!)}>播放交付快照</button><button className="primary" disabled={!!busy || task.status!=="ready"} onClick={()=>void action(task,"accept")}>接受当前交付版本</button><small>验收固定快照 {task.readySnapshotId}，不会接受后来修改。</small></>}
        {task.acceptedSnapshotId&&<p>已接受快照 {task.acceptedSnapshotId}；历史验收记录保留。</p>}
        {task.checks.map(check=><div key={check.id}><strong>{check.kind==="static"?"静态检查":"时序检查"} · {check.status}</strong><small>快照 {check.snapshotId}</small>{check.findings.map(f=><p key={f.id}>{f.status} · {f.location} · {f.message}{f.evidence&&` · 证据：${f.evidence}`}</p>)}</div>)}
        {task.findings.map(f=><p key={f.id}>{f.severity} · {f.message} · {f.resolution}</p>)}
        {(errors[task.id]||task.error)&&<p role="alert" className="interpolation-warning">{errors[task.id] || task.error}。输入已保留；刷新任务版本后再明确提交。</p>}
        {errors[task.id]&&<button onClick={()=>void onRefresh()}>刷新任务版本（保留输入）</button>}
      </article>;
    })}
  </section>;
}
