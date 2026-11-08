import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AgentHub } from "./agent.ts";
import { ProjectStore } from "./store.ts";

const text = (result: any) => JSON.parse(result.content[0].text);
const feedback = (result: any) => result.content.filter((item: any) => item.type === "text").map((item: any) => JSON.parse(item.text)).find((item: any) => item.userApproval)?.userApproval;
async function pending(session: any) {
  for (let i = 0; i < 200 && !session.toolApproval; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(session.toolApproval, "expected animation review");
  return session.toolApproval;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "animation-acceptance-")), file = join(root, "source.png");
  const made = spawnSync(process.env.SPRITE_STUDIO_PYTHON || "python", ["-I", "-c", "from PIL import Image;import sys;Image.new('RGBA',(32,32),'red').save(sys.argv[1])", file]);
  assert.equal(made.status, 0, made.stderr.toString());
  const store = new ProjectStore(join(root, "projects")), pid = store.createProject("review").id;
  const image = await store.importImage(pid, "source.png", readFileSync(file));
  const clip = store.createClip(pid, "idle", [{ id: randomUUID(), imageId: image.id, durationUs: 100000 }]);
  const session = store.createSession(pid);
  const hub: AgentHub = Object.assign(Object.create(AgentHub.prototype), { store, imports: new Map(), timers: new Map(), frameSaves: new Map(), clients: new Map(), prompts: new Map(), toolWaits: new Map(), toolTails: new Map(), toolEpochs: new Map() });
  const draft = () => {
    const doc = store.clipDrafts.create(pid, { clipId: clip.id, revision: store.animation.clip(pid, clip.id).revision }, "agent", session.id);
    const body = JSON.parse(doc.text); body.frames[0].durationUs = 600000;
    return store.clipDrafts.write(pid, doc.documentId, { expectedDocumentRevision: doc.documentRevision, text: JSON.stringify(body) });
  };
  const close = async () => { hub.cancelTools(session, "cleanup"); hub.cancelFrameSave(session, "cleanup"); await store.worker.close(); rmSync(root, { recursive: true, force: true }); };
  return { store, pid, session, hub, clip, image, draft, close };
}

test("full draft review freezes real playback; Deny retains draft, Accept returns feedback and saves exact frames", async () => {
  const f = await fixture();
  try {
    const doc = f.draft(), args = { draftId: doc.documentId, documentRevision: doc.documentRevision };
    let waiting = f.hub.tool(f.session.id, "save_clip_draft", args), approval = await pending(f.session);
    assert.equal(approval.animations.length, 1);
    const candidate = f.store.animation.snapshot(f.pid, approval.animations[0].previewSnapshotId);
    assert.equal(candidate.clip.frames[0]!.durationUs, 600000);
    assert.equal(f.store.animation.clip(f.pid, f.clip.id).revision, f.clip.revision);
    f.hub.resolveToolApproval(f.session.id, approval.id, false, "节奏太慢，请缩短时长");
    const denied = await waiting;
    assert.equal(text(denied).executed, false);
    assert.equal(denied.isError, undefined, "a visual rejection is a normal decision, not a broken tool");
    assert.equal(feedback(denied).accepted, false);
    assert.match(feedback(denied).feedback, /缩短时长/);
    assert.equal(f.store.clipDrafts.read(f.pid, doc.documentId).draft.status, "editing");
    waiting = f.hub.tool(f.session.id, "save_clip_draft", args); approval = await pending(f.session);
    f.hub.resolveToolApproval(f.session.id, approval.id, true, "先接受这版，后续保持角色一致");
    const saved = await waiting;
    assert.equal(text(saved).saved, true);
    assert.equal(feedback(saved).accepted, true);
    assert.match(feedback(saved).feedback, /保持角色一致/);
    assert.deepEqual(f.store.animation.clip(f.pid, f.clip.id).frames, candidate.clip.frames);
  } finally { await f.close(); }
});

test("direct clip writes cannot skip animation review; a multi-clip batch remains atomic and uses the previewed new frame IDs", async () => {
  const f = await fixture();
  try {
    const empty = f.store.createClip(f.pid, "new animation", []);
    const docs = [f.clip, empty].map(clip => {
      const doc = f.store.documents.read(f.pid, clip.id), body = JSON.parse(doc.text);
      body.frames = [{ imageId: f.image.id, durationUs: 250000 }];
      return { documentId: clip.id, expectedDocumentRevision: doc.documentRevision, text: JSON.stringify(body) };
    });
    let waiting = f.hub.tool(f.session.id, "write_documents", { documents: docs }), approval = await pending(f.session);
    assert.equal(approval.animations.length, 2);
    assert.equal(f.store.animation.clip(f.pid, empty.id).frames.length, 0);
    f.hub.resolveToolApproval(f.session.id, approval.id, false, "先修待机"); await waiting;
    assert.equal(f.store.animation.clip(f.pid, f.clip.id).revision, f.clip.revision);
    assert.equal(f.store.animation.clip(f.pid, empty.id).frames.length, 0);
    waiting = f.hub.tool(f.session.id, "write_documents", { documents: docs }); approval = await pending(f.session);
    const snapshots = approval.animations.map((item: any) => f.store.animation.snapshot(f.pid, item.previewSnapshotId));
    f.hub.resolveToolApproval(f.session.id, approval.id, true, "接受这两个动画");
    const saved = text(await waiting);
    assert.equal(saved.length, 2);
    for (const snapshot of snapshots) assert.deepEqual(f.store.animation.clip(f.pid, snapshot.clip.id).frames, snapshot.clip.frames);
  } finally { await f.close(); }
});

test("draft edits remain ordinary writes; stale review is released without publishing or fabricating visual rejection", async () => {
  const f = await fixture();
  try {
    let doc = f.draft(), body = JSON.parse(doc.text); body.frames[0].durationUs = 200000;
    const edited = text(await f.hub.tool(f.session.id, "write_documents", { documents: [{ documentId: doc.documentId, expectedDocumentRevision: doc.documentRevision, text: JSON.stringify(body) }] }))[0];
    assert.equal(f.session.toolApproval, undefined);
    const waiting = f.hub.tool(f.session.id, "save_clip_draft", { draftId: doc.documentId, documentRevision: edited.documentRevision });
    const approval = await pending(f.session);
    body.frames[0].durationUs = 300000;
    f.store.clipDrafts.write(f.pid, doc.documentId, { expectedDocumentRevision: edited.documentRevision, text: JSON.stringify(body) });
    assert.throws(() => f.hub.resolveToolApproval(f.session.id, approval.id, true), /改变|CONFLICT/);
    const stale = await waiting;
    assert.equal(text(stale).executed, false);
    assert.equal(feedback(stale), undefined);
    assert.equal(f.session.toolApproval, undefined);
    assert.equal(f.store.animation.clip(f.pid, f.clip.id).revision, f.clip.revision);
  } finally { await f.close(); }
});

test("changed image bytes invalidate acceptance; allow and deny do not impersonate user decisions", async () => {
  const f = await fixture();
  try {
    let doc = f.draft();
    f.store.permissions.write({ save_frame_draft: "deny", save_clip_draft: "allow" });
    assert.equal((await f.hub.tool(f.session.id, "save_clip_draft", { draftId: doc.documentId, documentRevision: doc.documentRevision })).isError, true);
    const official = f.store.documents.read(f.pid, f.clip.id);
    assert.equal((await f.hub.tool(f.session.id, "write_documents", { documents: [{ documentId: f.clip.id, expectedDocumentRevision: official.documentRevision, text: official.text }] })).isError, true);
    f.store.permissions.write({ save_frame_draft: "allow", save_clip_draft: "allow" });
    const automatic = await f.hub.tool(f.session.id, "save_clip_draft", { draftId: doc.documentId, documentRevision: doc.documentRevision });
    assert.equal(text(automatic).saved, true); assert.equal(feedback(automatic), undefined);
    f.store.permissions.write({ save_frame_draft: "ask", save_clip_draft: "ask" }); doc = f.draft();
    const waiting = f.hub.tool(f.session.id, "save_clip_draft", { draftId: doc.documentId, documentRevision: doc.documentRevision });
    const approval = await pending(f.session), before = f.store.animation.clip(f.pid, f.clip.id).revision;
    writeFileSync(f.store.imagePath(f.pid, f.image.id), "externally changed bytes");
    assert.throws(() => f.hub.resolveToolApproval(f.session.id, approval.id, true), /修改|改变|变化/);
    assert.equal(text(await waiting).executed, false);
    assert.equal(f.store.animation.clip(f.pid, f.clip.id).revision, before);
  } finally { await f.close(); }
});

test("human-source acceptance delivers for adoption, never directly saves the source draft", async () => {
  const f = await fixture();
  try {
    const human = f.store.clipDrafts.create(f.pid, { clipId: f.clip.id, revision: f.clip.revision }, "human");
    let doc = f.store.clipDrafts.create(f.pid, { clipId: f.clip.id, revision: f.clip.revision, fromDraftId: human.documentId }, "agent", f.session.id);
    const body = JSON.parse(doc.text); body.frames[0].durationUs = 400000;
    doc = f.store.clipDrafts.write(f.pid, doc.documentId, { expectedDocumentRevision: doc.documentRevision, text: JSON.stringify(body) });
    const waiting = f.hub.tool(f.session.id, "save_clip_draft", { draftId: doc.documentId, documentRevision: doc.documentRevision });
    const approval = await pending(f.session); assert.equal(approval.animations[0].deliveryOnly, true);
    f.hub.resolveToolApproval(f.session.id, approval.id, true, "交付后我再采用");
    const saved = text(await waiting);
    assert.equal(saved.saved, false); assert.equal(saved.pendingHumanAdoption, true);
    assert.equal(f.store.clipDrafts.read(f.pid, human.documentId).text, human.text);
    assert.equal(f.store.animation.clip(f.pid, f.clip.id).revision, f.clip.revision);
  } finally { await f.close(); }
});
