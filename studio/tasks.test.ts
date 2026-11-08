import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectStore } from "./store.ts";
import { ProductionTasks } from "./tasks.ts";
import type { QualityCheck } from "./workflow-model.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAk+Uzr4AAAAASUVORK5CYII=", "base64");
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "studio-tasks-")), store = new ProjectStore(join(root, "projects"), { tasksEnabled: true });
  const pid = store.createProject("A").id, other = store.createProject("B").id;
  const image = await store.importImage(pid, "one.png", png);
  const clip = store.createClip(pid, "clip", [{ id: randomUUID(), imageId: image.id, durationUs: 100000 }]);
  const snapshot = store.animation.capture(pid, clip.id);
  const tasks = new ProductionTasks(store);
  const input = { requestId: randomUUID(), title: "test", description: "make", target: { mode: "saved" as const, clipId: clip.id }, referenceIds: [image.id], contract: { scope: { clipId: clip.id }, requiredChecks: ["static", "temporal"] as ("static" | "temporal")[] } };
  return {root, store, pid, other, image, clip, snapshot, tasks, input};
}
function check(snapshotId: string, clipId: string, kind: "static" | "temporal", status: QualityCheck["status"]): QualityCheck {
  return { id: randomUUID(), kind, status, scope: { clipId }, snapshotId, findings: [], createdAt: new Date().toISOString() };
}
test("creation idempotence, ownership, CAS, direction and handoff barriers", async () => {
 const f = await fixture(); try {
  let t = f.tasks.create(f.pid, f.input);
  assert.equal(f.tasks.create(f.pid, f.input).id,t.id);
  assert.throws(() => f.tasks.create(f.pid,{...f.input,title:"other"}), /意图/);
  assert.throws(() => f.tasks.create(f.other,{...f.input,requestId:randomUUID()}));
  assert.throws(() => f.tasks.get(f.other,t.id));
  assert.throws(() => f.tasks.action(f.pid,t.id,{expectedRevision:99,action:"pause"}), /VERSION_CONFLICT/);
  assert.throws(() => f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:false,assetId:f.image.id}), /意见/);
  t = f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:false,feedback:"change",assetId:f.image.id});
  assert.equal(t.intentVersion,2); assert.equal(t.status,"waiting");
  t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"resume"}); assert.equal(t.phase,"direction");
  t = f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:true,assetId:f.image.id}); assert.equal(t.phase,"production");
  const barrier = t.barrierVersion; t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"handoff"}); assert.equal(t.barrierVersion,barrier+1);
  t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"feedback",text:"new intent"}); assert.equal(t.intentVersion,3); assert.equal(t.direction,undefined);
 } finally { f.store.worker.close(); rmSync(f.root,{recursive:true,force:true}); }
});
test("unknown attempts survive restart and never grant unattended retry", async () => {
 const f = await fixture(); let restored: ProjectStore | undefined; try {
  let t = f.tasks.create(f.pid,f.input); const aid = randomUUID();
  t = f.tasks.recordAttempt(f.pid,t.id,{expectedRevision:t.revision,id:aid,status:"reserved"});
  assert.equal(t.attempts[0]!.unattendedAllowed,false);
  t = f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:true,assetId:f.image.id});
  t = f.tasks.recordAttempt(f.pid,t.id,{expectedRevision:t.revision,id:aid,status:"running"});
  f.store.worker.close(); restored = new ProjectStore(join(f.root,"projects"), { tasksEnabled: true });
  const service = new ProductionTasks(restored); t = service.get(f.pid,t.id);
  assert.equal(t.status,"paused"); assert.match(t.error!,/interrupted/); assert.equal(t.attempts[0]!.status,"unknown");
  assert.throws(() => service.recordAttempt(f.pid,t.id,{expectedRevision:t.revision,id:aid,status:"running"}));
  assert.throws(() => service.recordAttempt(f.pid,t.id,{expectedRevision:t.revision,id:randomUUID(),status:"reserved"}));
 } finally { f.store.worker.close(); restored?.worker.close(); rmSync(f.root,{recursive:true,force:true}); }
});
test("readiness requires exact checks, rejects failures, acceptance expires on visual change", async () => {
 const f = await fixture(); try {
  let t = f.tasks.create(f.pid,f.input);
  t = f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:true,assetId:f.image.id});
  assert.throws(() => f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"ready",snapshotId:f.snapshot.id}),/检查/);
  t = f.tasks.recordCheck(f.pid,t.id,{expectedRevision:t.revision,check:check(f.snapshot.id,f.clip.id,"static","passed")});
  t = f.tasks.recordCheck(f.pid,t.id,{expectedRevision:t.revision,check:check(f.snapshot.id,f.clip.id,"temporal","unverified")});
  assert.throws(() => f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"accept",snapshotId:f.snapshot.id}));
  t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"ready",snapshotId:f.snapshot.id});
  assert.throws(() => f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"accept",snapshotId:randomUUID()}));
  t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"accept",snapshotId:f.snapshot.id}); assert.equal(t.acceptanceHistory.length,1);
  f.store.updateClip(f.pid,f.clip.id,{revision:f.clip.revision,frames:[{...f.clip.frames[0]!,durationUs:200000}],loop:f.clip.loop});
  t = f.tasks.get(f.pid,t.id); assert.equal(t.status,"blocked"); assert.equal(t.acceptedSnapshotId,f.snapshot.id); assert.equal(t.acceptanceHistory.length,1);
 } finally { f.store.worker.close(); rmSync(f.root,{recursive:true,force:true}); }
});
test("attempt results are idempotent and handoff freezes pending work", async () => {
 const f = await fixture(); try {
  let t = f.tasks.create(f.pid,{...f.input,contract:{...f.input.contract,generationLimit:3}});
  const id = randomUUID();
  t = f.tasks.recordAttempt(f.pid,t.id,{expectedRevision:t.revision,id,status:"reserved"});
  t = f.tasks.recordAttempt(f.pid,t.id,{expectedRevision:t.revision,id,status:"running"});
  t = f.tasks.recordAttempt(f.pid,t.id,{expectedRevision:t.revision,id,status:"completed",assetId:f.image.id});
  const duplicate = f.tasks.recordAttempt(f.pid,t.id,{expectedRevision:t.revision,id,status:"completed",assetId:f.image.id});
  assert.equal(duplicate.revision,t.revision); assert.equal(duplicate.attempts.length,1);
  const pending = randomUUID();
  t = f.tasks.recordAttempt(f.pid,t.id,{expectedRevision:t.revision,id:pending,status:"reserved"});
  t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"handoff"});
  assert.equal(t.attempts[1]!.status,"unknown");
  assert.throws(() => f.tasks.recordAttempt(f.pid,t.id,{expectedRevision:t.revision,id:randomUUID(),status:"reserved"}));
 } finally { f.store.worker.close(); rmSync(f.root,{recursive:true,force:true}); }
});
test("1 direction rejection invalidates in-flight attempts before a new reservation", async () => {
 const f = await fixture(); try {
  let t = f.tasks.create(f.pid,{...f.input,contract:{...f.input.contract,generationLimit:2}});
  const attempt = randomUUID();
  t = f.tasks.recordAttempt(f.pid,t.id,{expectedRevision:t.revision,id:attempt,status:"reserved"});
  t = f.tasks.recordAttempt(f.pid,t.id,{expectedRevision:t.revision,id:attempt,status:"running"});
  const barrier = t.barrierVersion;
  t = f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:false,feedback:"change",assetId:f.image.id});
  assert.equal(t.barrierVersion,barrier+1); assert.equal(t.attempts[0]!.status,"unknown");
  assert.throws(() => f.tasks.recordAttempt(f.pid,t.id,{expectedRevision:t.revision,id:randomUUID(),status:"reserved"}));
  assert.equal(new ProductionTasks(f.store).get(f.pid,t.id).attempts[0]!.status,"unknown");
 } finally { f.store.worker.close(); rmSync(f.root,{recursive:true,force:true}); }
});
test("2 pause and handoff require explicit resume before direction or ready", async () => {
 const f = await fixture(); try {
  let t = f.tasks.create(f.pid,f.input);
  t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"handoff"});
  assert.throws(() => f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:true,assetId:f.image.id}),/恢复/);
  assert.throws(() => f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"ready",snapshotId:f.snapshot.id}),/恢复/);
  t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"resume"});
  assert.equal(t.status,"waiting");
  assert.throws(() => f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"ready",snapshotId:f.snapshot.id}),/恢复/);
  t = f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:true,assetId:f.image.id});
  t = f.tasks.recordCheck(f.pid,t.id,{expectedRevision:t.revision,check:check(f.snapshot.id,f.clip.id,"static","passed")});
  t = f.tasks.recordCheck(f.pid,t.id,{expectedRevision:t.revision,check:check(f.snapshot.id,f.clip.id,"temporal","unverified")});
  t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"pause"});
  assert.throws(() => f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"ready",snapshotId:f.snapshot.id}),/恢复/);
  assert.throws(() => f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:true,assetId:f.image.id}),/恢复/);
  t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"resume"});
  t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"ready",snapshotId:f.snapshot.id}); assert.equal(t.status,"ready");
 } finally { f.store.worker.close(); rmSync(f.root,{recursive:true,force:true}); }
});
test("feedback after handoff or pause never resumes execution", async () => {
 const f = await fixture(); try {
  for (const action of ["handoff", "pause"] as const) {
   let t = f.tasks.create(f.pid,{...f.input,requestId:randomUUID()});
   t = f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:true,assetId:f.image.id});
   for (const c of [check(f.snapshot.id,f.clip.id,"static","passed"),check(f.snapshot.id,f.clip.id,"temporal","unverified")])
    t = f.tasks.recordCheck(f.pid,t.id,{expectedRevision:t.revision,check:c});
   t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action});
   const beforeIntent = t.intentVersion, beforeBarrier = t.barrierVersion, pauseReason = t.error;
   t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"feedback",text:"保留新的要求"});
   assert.equal(t.status,"paused"); assert.equal(t.phase,"direction"); assert.equal(t.error,pauseReason);
   assert.equal(t.intentVersion,beforeIntent+1); assert.equal(t.barrierVersion,beforeBarrier+1);
   assert.match(t.description,/保留新的要求/); assert.equal(t.checks.length,2); assert.equal(t.directionHistory.length,1);
   assert.throws(() => f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:true,assetId:f.image.id}),/恢复/);
   assert.throws(() => f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"ready",snapshotId:f.snapshot.id}),/恢复/);
   assert.equal(f.tasks.get(f.pid,t.id).status,"paused");
   t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"resume"});
   assert.equal(t.status,"waiting"); assert.equal(t.waitReason,"direction");
   t = f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:true,assetId:f.image.id});
   assert.equal(t.status,"running");
  }
 } finally { f.store.worker.close(); rmSync(f.root,{recursive:true,force:true}); }
});
test("3 derived blocked state resumes at the visible revision and preserves acceptance on restart", async () => {
 const f = await fixture(); let restored: ProjectStore | undefined; try {
  let t = f.tasks.create(f.pid,f.input);
  t = f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:true,assetId:f.image.id});
  for (const c of [check(f.snapshot.id,f.clip.id,"static","passed"),check(f.snapshot.id,f.clip.id,"temporal","unverified")]) t = f.tasks.recordCheck(f.pid,t.id,{expectedRevision:t.revision,check:c});
  t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"ready",snapshotId:f.snapshot.id});
  t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"accept",snapshotId:f.snapshot.id});
  f.store.updateClip(f.pid,f.clip.id,{revision:f.clip.revision,frames:[{...f.clip.frames[0]!,durationUs:200000}],loop:f.clip.loop});
  f.store.worker.close(); restored = new ProjectStore(join(f.root,"projects"), { tasksEnabled: true });
  const service = new ProductionTasks(restored); t = service.get(f.pid,t.id);
  assert.equal(t.status,"blocked"); assert.equal(service.list(f.pid)[0]!.status,"blocked");
  const revision = t.revision;
  t = service.action(f.pid,t.id,{expectedRevision:revision,action:"resume"});
  assert.equal(t.status,"running"); assert.equal(t.revision,revision+1);
  assert.equal(t.acceptanceHistory[0]!.snapshotId,f.snapshot.id); assert.equal(t.acceptedSnapshotId,f.snapshot.id);
 } finally { f.store.worker.close(); restored?.worker.close(); rmSync(f.root,{recursive:true,force:true}); }
});
test("4 feedback prevents earlier intent checks satisfying ready", async () => {
 const f = await fixture(); try {
  let t = f.tasks.create(f.pid,f.input);
  t = f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:true,assetId:f.image.id});
  for (const c of [check(f.snapshot.id,f.clip.id,"static","passed"),check(f.snapshot.id,f.clip.id,"temporal","unverified")]) t = f.tasks.recordCheck(f.pid,t.id,{expectedRevision:t.revision,check:c});
  t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"feedback",text:"保留角色特征"});
  t = f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:true,assetId:f.image.id});
  assert.equal(t.checks.length,2); assert.throws(() => f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"ready",snapshotId:f.snapshot.id}),/检查/);
  for (const c of [check(f.snapshot.id,f.clip.id,"static","passed"),check(f.snapshot.id,f.clip.id,"temporal","unverified")]) t = f.tasks.recordCheck(f.pid,t.id,{expectedRevision:t.revision,check:c});
  t = f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"ready",snapshotId:f.snapshot.id}); assert.equal(t.status,"ready"); assert.equal(t.checks.length,4);
 } finally { f.store.worker.close(); rmSync(f.root,{recursive:true,force:true}); }
});
test("5 snapshot-only revision and mixed draft targets are validated together", async () => {
 const f = await fixture(); try {
  const target = {mode:"saved" as const,snapshotId:f.snapshot.id,revision:f.clip.revision};
  assert.equal(f.tasks.create(f.pid,{...f.input,requestId:randomUUID(),target}).target?.snapshotId,f.snapshot.id);
  assert.throws(() => f.tasks.create(f.pid,{...f.input,requestId:randomUUID(),target:{...target,revision:"stale"}}),/版本/);
  const clipB = f.store.createClip(f.pid,"other",[{id:randomUUID(),imageId:f.image.id,durationUs:100000}]);
  const draft = f.store.frameDrafts.create(f.pid,{clipId:clipB.id,revision:clipB.revision,frameId:clipB.frames[0]!.id},"human").draft;
  assert.throws(() => f.tasks.create(f.pid,{...f.input,requestId:randomUUID(),target:{...target,draftId:draft.id}}),/不一致/);
  assert.throws(() => f.tasks.create(f.pid,{...f.input,requestId:randomUUID(),target:{mode:"draft",draftId:draft.id}}),/范围不一致/);
  assert.throws(() => f.tasks.create(f.other,{...f.input,requestId:randomUUID(),target}),/不存在/);
 } finally { f.store.worker.close(); rmSync(f.root,{recursive:true,force:true}); }
});
test("known failing checks cannot be disguised as ready", async () => {
 const f = await fixture(); try {
  let t = f.tasks.create(f.pid,f.input);
  t = f.tasks.decideDirection(f.pid,t.id,{expectedRevision:t.revision,accept:true,assetId:f.image.id});
  t = f.tasks.recordCheck(f.pid,t.id,{expectedRevision:t.revision,check:check(f.snapshot.id,f.clip.id,"static","failed")});
  t = f.tasks.recordCheck(f.pid,t.id,{expectedRevision:t.revision,check:check(f.snapshot.id,f.clip.id,"static","passed")});
  t = f.tasks.recordCheck(f.pid,t.id,{expectedRevision:t.revision,check:check(f.snapshot.id,f.clip.id,"temporal","unverified")});
  assert.throws(() => f.tasks.action(f.pid,t.id,{expectedRevision:t.revision,action:"ready",snapshotId:f.snapshot.id}),/失败/);
 } finally { f.store.worker.close(); rmSync(f.root,{recursive:true,force:true}); }
});
