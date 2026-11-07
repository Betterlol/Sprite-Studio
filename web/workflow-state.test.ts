import test from "node:test";
import assert from "node:assert/strict";
import { clipEdit, editorReducer, editorState, DraftQueue, contextFor, dependencyKey, dependencyConflicts, editingBlock, offsetByDrag, sameClipText, samePreview, shortcutAllowed } from "./workflow-state.ts";
import type { ClipAsset, ImageAsset } from "../studio/model.ts";
import type { ClipDraftDocument, ProductionTask } from "../studio/workflow-model.ts";
const ids = Array.from({length:9},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`);
const clip: ClipAsset = { id:ids[0]!,type:"clip",name:"test",revision:"saved-1",createdAt:"now",loop:true,initialFps:12,frames:[{id:ids[1]!,imageId:ids[3]!,durationUs:100000},{id:ids[2]!,imageId:ids[3]!,durationUs:200000}] };
const image: ImageAsset = {id:ids[3]!,type:"image",name:"pixels",kind:"image",revision:"pixels-1",createdAt:"now",width:360,height:360,frameCount:1,mime:"image/png",file:"test.png",contentHash:"hash"};
function document(source:"human"|"agent"="human"): ClipDraftDocument {return {documentId:ids[4]!,documentRevision:"doc-1",text:"initial",draft:{id:ids[4]!,projectId:ids[5]!,clipId:clip.id,baseSnapshotId:ids[6]!,source,status:"editing",createdAt:"now"}};}
function task(): ProductionTask {return {id:ids[7]!,projectId:ids[5]!,requestId:ids[8]!,requestHash:"hash",revision:3,intentVersion:1,barrierVersion:4,title:"task",description:"description",phase:"production",status:"running",target:{clipId:clip.id,revision:clip.revision,mode:"saved"},referenceIds:[],contract:{roleReferenceIds:[],immutable:[],generationLimit:1,repairLimit:3,requiredChecks:["static"]},attempts:[],directionHistory:[],findings:[],checks:[],acceptanceHistory:[],createdAt:"now",updatedAt:"now"};}

test("one history covers frame transform, timing, order, loop and defaults",()=>{
  let state=editorState(clipEdit(clip));const before=structuredClone(state.present);
  const transformed={...state.present,frames:state.present.frames.map((f,i)=>i?f:{...f,durationUs:330000,transform:{scale:1.2,offsetX:9,offsetY:-4,clip:false}})};
  state=editorReducer(state,{type:"edit",edit:transformed});
  state=editorReducer(state,{type:"edit",edit:{...state.present,loop:false,initialFps:24,frames:[...state.present.frames].reverse()}});
  state=editorReducer(state,{type:"edit",edit:{...state.present,frames:state.present.frames.slice(1)}});
  const final=structuredClone(state.present);
  for(let i=0;i<3;i++)state=editorReducer(state,{type:"undo"});assert.deepEqual(state.present,before);
  for(let i=0;i<3;i++)state=editorReducer(state,{type:"redo"});assert.deepEqual(state.present,final);
  assert.equal(state.version,9);assert.equal(clip.frames[0]!.durationUs,100000);
});
test("repeated image usages retain distinct instance ids and redo branches reset",()=>{
  let state=editorState(clipEdit(clip));
  state=editorReducer(state,{type:"edit",edit:{...state.present,frames:state.present.frames.map((f,i)=>i?{...f,durationUs:70000}:f)}});
  assert.equal(state.present.frames[0]!.durationUs,100000);assert.equal(state.present.frames[0]!.imageId,state.present.frames[1]!.imageId);
  state=editorReducer(state,{type:"undo"});state=editorReducer(state,{type:"edit",edit:{...state.present,loop:false}});
  assert.equal(state.future.length,0);assert.equal(state.present.frames[1]!.durationUs,200000);
});
test("invalid edits do not enter history",()=>{
  const state=editorState(clipEdit(clip));
  assert.throws(()=>editorReducer(state,{type:"edit",edit:{...state.present,frames:[{...state.present.frames[0]!,durationUs:0}]}}));
  assert.equal(state.past.length,0);
});
test("equivalent JSON formatting, key order and explicit defaults do not issue PUT", async () => {
  const edit = clipEdit(clip);
  const initial = { ...document(), text: JSON.stringify(edit) };
  let calls = 0;
  const q = new DraftQueue(initial, async () => { calls++; throw new Error("unexpected PUT"); });
  const normalized = { initialFps: edit.initialFps, loop: edit.loop, frames: edit.frames.map(frame => ({ transform: { scale: 1, offsetX: 0, offsetY: 0, clip: false }, ...frame })), type: "clip-edit", schemaVersion: 1 };
  q.enqueue(JSON.stringify(normalized, null, 4) + "\n");
  assert.ok(sameClipText(initial.text, q.desired));
  assert.equal((await q.flush()).documentRevision, "doc-1");
  assert.equal(calls, 0);
});
test("canonicalized PUT text is the ack baseline without replacing user's latest text", async () => {
  const edit = { ...clipEdit(clip), loop: false };
  let calls = 0;
  const canonical = JSON.stringify(edit) + "\n";
  const q = new DraftQueue({ ...document(), text: JSON.stringify(clipEdit(clip)) }, async () => {
    calls++;
    return { ...document(), documentRevision: "canonical-2", text: canonical };
  });
  const mine = JSON.stringify(edit, null, 2);
  q.enqueue(mine);
  const ack = await q.flush();
  assert.equal(ack.text, canonical);
  assert.equal(ack.documentRevision, "canonical-2");
  assert.equal(q.desired, mine);
  q.enqueue(JSON.stringify(edit, null, 4));
  await q.flush();
  assert.equal(calls, 1);
  assert.equal(contextFor(clip, clip.frames[0]!.id, ack).documentRevision, "canonical-2");
});
test("normalized old ack cannot swallow a concurrent newer semantic edit", async () => {
  let release!: (value: ClipDraftDocument) => void;
  const gate = new Promise<ClipDraftDocument>(resolve => { release = resolve; });
  const before = clipEdit(clip), first = { ...before, loop: false }, latest = { ...first, initialFps: 24 };
  const calls: {revision: string; text: string}[] = [];
  const q = new DraftQueue({ ...document(), text: JSON.stringify(before) }, async (revision, text) => {
    calls.push({ revision, text });
    if (calls.length === 1) return gate;
    return { ...document(), text: JSON.stringify(latest) + "\n", documentRevision: "d3" };
  });
  q.enqueue(JSON.stringify(first, null, 2));
  const pending = q.flush();
  q.enqueue(JSON.stringify(latest, null, 4));
  release({ ...document(), text: JSON.stringify(first) + "\n", documentRevision: "d2" });
  const ack = await pending;
  assert.equal(ack.documentRevision, "d3");
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.revision, "d2");
  assert.ok(sameClipText(calls[1]!.text, JSON.stringify(latest)));
  assert.ok(sameClipText(q.desired, ack.text));
});
test("semantic response changes block the queue and document revision still expires same-content previews", async () => {
  const edit = clipEdit(clip);
  const q = new DraftQueue({ ...document(), text: JSON.stringify(edit) }, async () => ({ ...document(), text: JSON.stringify(edit), documentRevision: "wrong" }));
  q.enqueue(JSON.stringify({ ...edit, loop: false }));
  await assert.rejects(q.flush(), /语义不一致/);
  assert.equal(q.document.documentRevision, "doc-1");
  const identity = { generation: 1, text: JSON.stringify(edit), documentRevision: "d1", dependencies: "pixels" };
  assert.equal(samePreview(identity, { ...identity, text: JSON.stringify(edit, null, 2) }), true);
  assert.equal(samePreview(identity, { ...identity, text: JSON.stringify(edit, null, 2), documentRevision: "d2" }), false);
});
test("serial draft queue coalesces rapid edits and waits for precise latest revision",async()=>{
  let resolve!: (value: ClipDraftDocument) => void;
  const gate = { promise: new Promise<ClipDraftDocument>(done => { resolve = done; }), resolve: (value: ClipDraftDocument) => resolve(value) };const writes:{revision:string;text:string}[]=[];
  const original=document();const q=new DraftQueue(original,async(revision,text)=>{
    writes.push({revision,text});if(writes.length===1)return gate.promise;
    return {...original,text,documentRevision:"doc-3"};
  });
  q.enqueue("first");const first=q.flush();q.enqueue("middle");q.enqueue("latest");const second=q.flush();
  assert.deepEqual(writes,[{revision:"doc-1",text:"first"}]);
  gate.resolve({...original,text:"first",documentRevision:"doc-2"});
  const [a,b]=await Promise.all([first,second]);
  assert.deepEqual(writes,[{revision:"doc-1",text:"first"},{revision:"doc-2",text:"latest"}]);
  assert.equal(a.documentRevision,"doc-3");assert.equal(b.documentRevision,"doc-3");
  assert.equal(contextFor(clip,clip.frames[1]!.id,b).documentRevision,"doc-3");assert.equal(contextFor(clip,clip.frames[1]!.id,b).frameId,clip.frames[1]!.id);
  await q.flush();assert.equal(writes.length,2);
});
test("queue failure keeps newest input and never retries uncertain writes automatically",async()=>{
  let calls=0;const q=new DraftQueue(document(),async()=>{calls++;throw new Error("409 conflict");});
  q.enqueue("mine");await assert.rejects(q.flush(),/409 conflict/);q.enqueue("newer mine");
  await assert.rejects(q.flush(),/409 conflict/);assert.equal(calls,1);assert.equal(q.desired,"newer mine");assert.equal(q.document.documentRevision,"doc-1");
});
test("wrong response identity cannot replace active document",async()=>{
  const q=new DraftQueue(document(),async()=>({...document(),draft:{...document().draft,id:ids[8]!}}));q.enqueue("mine");
  await assert.rejects(q.flush(),/身份不一致/);assert.equal(q.document.draft.id,ids[4]);
});
test("agent source and ended human drafts stay readonly",()=>{
  const q=new DraftQueue(document("agent"),async()=>document());assert.throws(()=>q.enqueue("overwrite"),/只读/);
  const ended=document();ended.draft.status="saved";assert.throws(()=>new DraftQueue(ended,async()=>document()).enqueue("overwrite"),/只读/);
});
test("dependency version tracks referenced images, not unrelated browser assets",()=>{
  const edit=clipEdit(clip);const key=dependencyKey(edit,[image]);
  assert.equal(dependencyKey(edit,[image,{...image,id:ids[8]!,revision:"other"}]),key);
  assert.notEqual(dependencyKey(edit,[{...image,revision:"pixels-2"}]),key);
  assert.deepEqual(dependencyConflicts(edit,[{...image,revision:"pixels-2"}],{[image.id]:image.revision}),[image.id]);
  assert.deepEqual(dependencyConflicts(edit,[],{[image.id]:image.revision}),[image.id]);
});
test("newly appended image dependencies are checked too",()=>{
  const edit={...clipEdit(clip),frames:[...clip.frames,{id:ids[6]!,imageId:ids[8]!,durationUs:100000}]};
  const added={...image,id:ids[8]!,revision:"added-1"};
  assert.deepEqual(dependencyConflicts(edit,[image,added],{[image.id]:image.revision,[added.id]:added.revision}),[]);
  assert.deepEqual(dependencyConflicts(edit,[image,{...added,revision:"added-2"}],{[image.id]:image.revision,[added.id]:added.revision}),[added.id]);
});
test("handoff enables only the same object after success and current barrier",()=>{
  const t=task();assert.equal(editingBlock([t],clip.id,{}),t);assert.equal(editingBlock([t],image.id,{}),undefined);
  const paused={...t,status:"paused" as const};assert.equal(editingBlock([paused],clip.id,{}),paused);
  assert.equal(editingBlock([paused],clip.id,{[t.id]:t.barrierVersion}),undefined);
  const next={...paused,barrierVersion:5};assert.equal(editingBlock([next],clip.id,{[t.id]:4}),next);
  assert.equal(editingBlock([t],clip.id,{[t.id]:4}),t); // resume revokes same-barrier local permission
});
test("pending preview expires on draft, generation, dependency or content change",()=>{
  const identity={generation:3,documentRevision:"d4",text:"A",dependencies:"pixels-v1"};assert.ok(samePreview(identity,{...identity}));
  assert.equal(samePreview(identity,{...identity,generation:4}),false);assert.equal(samePreview(identity,{...identity,documentRevision:"d5"}),false);
  assert.equal(samePreview(identity,{...identity,text:"B"}),false);assert.equal(samePreview(identity,{...identity,dependencies:"pixels-v2"}),false);
});
test("drag uses actual view scale, clamps offsets, and saved context has no draft",()=>{
  assert.deepEqual(offsetByDrag(4,-3,25,-10,.5),{offsetX:54,offsetY:-23});assert.deepEqual(offsetByDrag(4090,-4090,100,-100,1),{offsetX:4096,offsetY:-4096});
  assert.deepEqual(contextFor(clip,clip.frames[0]!.id),{clipId:clip.id,revision:"saved-1",frameId:clip.frames[0]!.id,mode:"saved"});assert.equal(shortcutAllowed(null),true);
});
