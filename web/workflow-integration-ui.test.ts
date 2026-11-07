import test from "node:test";
import assert from "node:assert/strict";
import type { EditingContext } from "../studio/workflow-model.ts";
import { ApiError } from "./api.ts";
import { setReviewArchived } from "./review-archive.ts";
import {
  assertReviewWritable, reviewArchivePayload, taskCreationTarget, taskTargetSummary,
  reviewInspectionReducer, type ArchivableReviewDefinition, type ReviewIdentity, type ReviewInspection,
} from "./workflow-state.ts";

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
function definition(overrides:Partial<ArchivableReviewDefinition>={}):ArchivableReviewDefinition {
  return {id:id(1),projectId:id(2),revision:"review-v1",name:"review",loop:true,segments:[{id:id(3),clipId:id(4),repeat:2,speed:1}],...overrides};
}
async function withFetch<T>(fetcher:typeof fetch,action:()=>Promise<T>) {
  const previous=globalThis.fetch;globalThis.fetch=fetcher;
  try{return await action();}finally{globalThis.fetch=previous;}
}
const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});

test("Review archive uses the exact reversible POST/CAS body and does not mutate resources or history",async()=>{
  const source=definition(),before=structuredClone(source),history=[{snapshotId:id(8),frameIds:[id(9)]}];
  const historyBefore=structuredClone(history);let calls=0;
  await withFetch(async(url,options)=>{
    calls++;assert.equal(String(url),`/api/projects/${source.projectId}/review-sequences/${source.id}/archive`);
    assert.equal(options?.method,"POST");assert.deepEqual(JSON.parse(String(options?.body)),{expectedRevision:"review-v1",archived:true});
    return json(200,{...source,revision:"review-v2",archived:true});
  },async()=>{
    const archived=await setReviewArchived(source.projectId,source,source.revision,false,true);
    assert.equal(archived.archived,true);assert.equal(archived.revision,"review-v2");
    assert.throws(()=>assertReviewWritable(archived),/不能编辑保存或捕获/);
  });
  assert.equal(calls,1);assert.deepEqual(source,before);assert.deepEqual(history,historyBefore);
});

test("Review restore remains available and historical snapshot inspection is independent of archive state",async()=>{
  const source=definition({revision:"review-v2",archived:true});
  const snapshot:ReviewIdentity={id:id(10),snapshotId:id(11),projectId:source.projectId,definitionId:source.id};
  type Evidence={sequence:ReviewIdentity;message:string};
  let inspection:ReviewInspection<Evidence>={selected:null,epoch:0,evidence:null};
  inspection=reviewInspectionReducer(inspection,{type:"select",snapshot});
  inspection=reviewInspectionReducer(inspection,{type:"inspect",epoch:inspection.epoch,evidence:{sequence:snapshot,message:"historical evidence"}});
  assert.equal(inspection.evidence?.message,"historical evidence");
  await withFetch(async(_url,options)=>{
    assert.deepEqual(JSON.parse(String(options?.body)),{expectedRevision:"review-v2",archived:false});
    return json(200,{...source,revision:"review-v3",archived:false});
  },async()=>{
    const restored=await setReviewArchived(source.projectId,source,source.revision,false,false);
    assert.doesNotThrow(()=>assertReviewWritable(restored));
    assert.equal(inspection.selected?.snapshotId,id(11));assert.equal(inspection.evidence?.message,"historical evidence");
  });
});

test("Review archive 409 keeps current definition fields/revision and does not publish an archived ack",async()=>{
  const source=definition(),form={name:source.name,loop:source.loop,segments:structuredClone(source.segments),revision:source.revision};
  const before=structuredClone(form);let published=false;
  await withFetch(async()=>json(409,{error:"活动任务仍要求此Review，请先终结任务"}),async()=>{
    await assert.rejects((async()=>{
      const next=await setReviewArchived(source.projectId,source,form.revision,false,true);
      published=true;form.revision=next.revision;
    })(),(error:unknown)=>error instanceof ApiError&&error.status===409&&/先终结任务/.test(error.message));
  });
  assert.equal(published,false);assert.deepEqual(form,before);assert.equal(source.archived,undefined);
});

test("Review archive/restore refuses unsaved edits or stale versions before POST without discarding input",async()=>{
  const source=definition(),form={name:"my unsaved name",segments:[...source.segments,{id:id(12),clipId:id(13),repeat:1,speed:2}]};
  const before=structuredClone(form);let posts=0;
  await withFetch(async()=>{posts++;throw new Error("must not POST");},async()=>{
    await assert.rejects(setReviewArchived(source.projectId,source,source.revision,true,true),/先保存或明确放弃/);
    await assert.rejects(setReviewArchived(source.projectId,{...source,archived:true},source.revision,true,false),/先保存或明确放弃/);
    await assert.rejects(setReviewArchived(source.projectId,source,"stale-review-v0",false,true),/版本已变化/);
  });
  assert.equal(posts,0);assert.deepEqual(form,before);
});

test("Review optional archived flag stays backward compatible and archive response identity is checked",async()=>{
  const source=definition();
  assert.doesNotThrow(()=>assertReviewWritable(source));assert.doesNotThrow(()=>assertReviewWritable(undefined));
  assert.deepEqual(reviewArchivePayload(source,source.revision,false,true),{expectedRevision:source.revision,archived:true});
  await withFetch(async()=>json(200,{...source,id:id(99),revision:"new",archived:true}),async()=>{
    await assert.rejects(setReviewArchived(source.projectId,source,source.revision,false,true),/响应身份/);
  });
});

const context:EditingContext={clipId:id(20),revision:"clip-v2",snapshotId:id(21),frameId:id(22),draftId:id(23),documentRevision:"draft-v4",mode:"draft"};
test("new task default preserves current frame instance and exact draft identity instead of becoming whole clip",()=>{
  const before=structuredClone(context),target=taskCreationTarget(context,"selection")!;
  assert.equal(target.frameId,id(22));assert.equal(target.draftId,id(23));assert.equal(target.documentRevision,"draft-v4");
  assert.match(taskTargetSummary(target),/当前帧实例/);assert.match(taskTargetSummary(target),/不是整个动画/);
  assert.deepEqual(context,before);
});
test("new task whole scope explicitly removes frame/range fields while keeping frozen source version",()=>{
  const selected={...context,startFrameId:id(24),endFrameId:id(25)},before=structuredClone(selected);
  const whole=taskCreationTarget(selected,"whole")!;
  assert.equal("frameId" in whole,false);assert.equal("startFrameId" in whole,false);assert.equal("endFrameId" in whole,false);
  assert.equal(whole.clipId,id(20));assert.equal(whole.snapshotId,id(21));assert.equal(whole.documentRevision,"draft-v4");
  assert.match(taskTargetSummary(whole),/整个当前动画/);assert.deepEqual(selected,before);
});
test("new task selection preserves an existing range and explicit frame choice narrows it",()=>{
  const selected={...context,startFrameId:id(24),endFrameId:id(25)};
  const range=taskCreationTarget(selected,"selection")!;
  assert.equal(range.startFrameId,id(24));assert.equal(range.endFrameId,id(25));assert.equal("frameId" in range,false);
  assert.match(taskTargetSummary(range),/当前区间/);assert.match(taskTargetSummary(range),/不扩大/);
  const frame=taskCreationTarget(selected,"frame")!;
  assert.equal(frame.frameId,id(22));assert.equal("startFrameId" in frame,false);assert.equal("endFrameId" in frame,false);
  assert.equal(taskCreationTarget({...context,startFrameId:id(24)},"selection")?.startFrameId,id(24));
});
test("new task missing frame cannot silently widen, while picture/no-target context remains unchanged",()=>{
  const {frameId,...withoutFrame}=context;
  assert.throws(()=>taskCreationTarget(withoutFrame,"frame"),/没有帧实例/);
  const image:EditingContext={assetId:id(30),revision:"image-v1",mode:"saved"};
  assert.deepEqual(taskCreationTarget(image,"whole"),image);
  assert.equal(taskCreationTarget(undefined,"selection"),undefined);
  assert.match(taskTargetSummary(undefined),/先明确范围/);
});
