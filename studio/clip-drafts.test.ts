import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ProjectStore } from "./store.ts";
import { ClipDrafts } from "./clip-drafts.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clip-draft-")), file = join(root, "source.png");
  const result = spawnSync(process.env.SPRITE_STUDIO_PYTHON || "python", ["-c", "from PIL import Image,ImageDraw;import sys;im=Image.new('RGBA',(64,64));ImageDraw.Draw(im).rectangle((16,16,47,47),fill='red');im.save(sys.argv[1])", file]);
  assert.equal(result.status, 0, result.stderr.toString());
  const store = new ProjectStore(join(root, "projects")), pid = store.createProject("draft").id;
  const image = await store.importImage(pid, "source.png", readFileSync(file));
  const clip = store.createClip(pid, "clip", [0, 1, 2].map(() => ({ id: crypto.randomUUID(), imageId: image.id, durationUs: 100000 })));
  return { store, pid, image, clip, drafts: new ClipDrafts(store) };
}
function update(drafts: ClipDrafts, pid: string, doc: ReturnType<ClipDrafts["read"]>, mutate: (v: any) => void) {
  const value = JSON.parse(doc.text); mutate(value);
  return drafts.write(pid, doc.documentId, { expectedDocumentRevision: doc.documentRevision, text: JSON.stringify(value) });
}
test("whole draft previews and commits arrangement, duration and shared images atomically with durable receipt", async () => {
  const { store, pid, image, clip, drafts } = await fixture();
  let restored: ProjectStore | undefined;
  try {
    const count = store.assets(pid).length;
    let doc = drafts.create(pid, { clipId: clip.id, revision: clip.revision }, "human");
    assert.equal(drafts.create(pid, { clipId: clip.id, revision: clip.revision, frameId: clip.frames[1]!.id }, "human").documentId, doc.documentId);
    assert.notEqual(drafts.create(pid, { clipId: clip.id, revision: clip.revision }, "agent", crypto.randomUUID()).documentId, doc.documentId);
    doc = update(drafts, pid, doc, v => {
      v.frames.forEach((f: any, i: number) => { f.durationUs += i * 1000; f.transform = { scale: 0.5, offsetX: i, offsetY: 0, clip: false }; });
      v.frames.reverse(); v.frames.push({ ...v.frames[0], id: crypto.randomUUID(), durationUs: 150000 }); v.loop = false; v.initialFps = 24;
    });
    const p = await drafts.preview(pid, doc.documentId, doc.documentRevision);
    assert.equal(p.modified, true); assert.equal(p.modifiedFrameIds.length, 4); assert.deepEqual(p.preview.clip.frames.map(f => f.id), JSON.parse(doc.text).frames.map((f: any) => f.id));
    assert.equal(p.warnings.length, 0); assert.equal(store.animation.clip(pid, clip.id).revision, clip.revision);
    let guarded = false;
    await assert.rejects(drafts.save(pid, doc.documentId, doc.documentRevision, () => { guarded = true; throw new Error("barrier changed"); }), /barrier changed/);
    assert.equal(guarded, true); assert.equal(store.animation.clip(pid, clip.id).revision, clip.revision); assert.equal(drafts.read(pid, doc.documentId).draft.status, "editing");
    const saved = await drafts.save(pid, doc.documentId, doc.documentRevision);
    assert.deepEqual(saved.clip.frames, p.preview.clip.frames); assert.equal(saved.clip.loop, false); assert.equal(saved.clip.initialFps, 24);
    assert.equal(store.assets(pid).length, count); assert.ok(saved.clip.frames.every(f => f.imageId === image.id));
    assert.deepEqual(store.animation.snapshot(pid, saved.afterSnapshotId).clip.frames, saved.clip.frames);
    assert.deepEqual(store.animation.snapshot(pid, saved.beforeSnapshotId).clip.frames, clip.frames);
    const current = store.animation.clip(pid, clip.id);
    store.updateClip(pid, clip.id, { revision: current.revision, frames: current.frames, loop: true });
    assert.deepEqual(await drafts.save(pid, doc.documentId, doc.documentRevision), saved);
    assert.equal(store.animation.clip(pid, clip.id).loop, true);
    restored = new ProjectStore(store.root);
    assert.deepEqual(await new ClipDrafts(restored).save(pid, doc.documentId, doc.documentRevision), saved);
    assert.equal(restored.animation.clip(pid, clip.id).loop, true);
  } finally { store.worker.close(); restored?.worker.close(); }
});
test("derive old v2 and new drafts without changing source; recover and enforce CAS", async () => {
  const { store, pid, clip, drafts } = await fixture(); let restored: ProjectStore | undefined;
  try {
    let legacy = store.frameDrafts.create(pid, { clipId: clip.id, revision: clip.revision, frameId: clip.frames[0]!.id }, "human");
    const config = JSON.parse(legacy.text); config.frames[0].transform.scale = 0.5; config.frames[1].durationUs = 140000;
    legacy = store.documents.write(pid, [{ documentId: legacy.documentId, expectedDocumentRevision: legacy.documentRevision, text: JSON.stringify(config) }])[0]!;
    const doc = drafts.create(pid, { clipId: clip.id, revision: clip.revision, fromDraftId: legacy.documentId }, "agent", crypto.randomUUID());
    const v = JSON.parse(doc.text); assert.equal(v.frames[0].transform.scale, 0.5); assert.equal(v.frames[1].durationUs, 140000);
    const child = drafts.create(pid, { clipId: clip.id, revision: clip.revision, fromDraftId: doc.documentId }, "human");
    assert.notEqual(child.documentId, doc.documentId); assert.equal(child.text, doc.text);
    assert.equal(store.frameDrafts.read(pid, legacy.documentId).text, legacy.text);
    assert.throws(() => drafts.write(pid, child.documentId, { expectedDocumentRevision: "stale", text: child.text }), /VERSION_CONFLICT/);
    restored = new ProjectStore(store.root); const recovered = new ClipDrafts(restored);
    assert.equal(recovered.read(pid, child.documentId).text, child.text); assert.ok(recovered.list(pid).some(d => d.id === child.documentId));
    assert.equal(recovered.discard(pid, child.documentId, child.documentRevision).draft.status, "discarded");
    assert.equal(recovered.read(pid, child.documentId).draft.status, "discarded");
  } finally { store.worker.close(); restored?.worker.close(); }
});
test("reject stale clip, changed pixels, overflow, invalid frames and cross-project references", async () => {
  const { store, pid, image, clip, drafts } = await fixture();
  try {
    let doc = drafts.create(pid, { clipId: clip.id, revision: clip.revision }, "human");
    const another = store.createClip(pid, "other", [{ id: crypto.randomUUID(), imageId: image.id, durationUs: 100000 }]);
    assert.throws(() => update(drafts, pid, doc, v => { v.frames[0].id = another.frames[0]!.id; }), /其他动画/);
    assert.throws(() => update(drafts, pid, doc, v => { v.frames[1].id = v.frames[0].id; }), /重复/);
    assert.throws(() => update(drafts, pid, doc, v => { v.frames[0].durationUs = 0; }), /无效/);
    const otherPid = store.createProject("other project").id;
    assert.throws(() => drafts.read(otherPid, doc.documentId), /不存在/);
    assert.throws(() => update(drafts, pid, doc, v => { v.frames[0].imageId = crypto.randomUUID(); }), /不存在/);
    doc = update(drafts, pid, doc, v => { v.frames[0].transform = { scale: 1, offsetX: 100, offsetY: 0, clip: false }; });
    assert.equal((await drafts.preview(pid, doc.documentId, doc.documentRevision)).warnings[0]!.blocking, true);
    await assert.rejects(drafts.save(pid, doc.documentId, doc.documentRevision), /超出画布/);
    store.updateClip(pid, clip.id, { revision: clip.revision, frames: clip.frames, loop: false });
    await assert.rejects(drafts.preview(pid, doc.documentId, doc.documentRevision), /版本已经改变/);
    const current = store.animation.clip(pid, clip.id); const next = drafts.create(pid, { clipId: clip.id, revision: current.revision }, "human");
    writeFileSync(store.imagePath(pid, image.id), "changed");
    await assert.rejects(drafts.preview(pid, next.documentId, next.documentRevision), /修改|变化/);
    await assert.rejects(drafts.save(pid, next.documentId, next.documentRevision), /修改|变化/);
  } finally { store.worker.close(); }
});
test("empty animations and deletion of all frames are supported", async () => {
  const { store, pid, clip, drafts } = await fixture();
  try {
    let doc = drafts.create(pid, { clipId: clip.id, revision: clip.revision }, "human");
    doc = update(drafts, pid, doc, v => { v.frames = []; });
    const preview = await drafts.preview(pid, doc.documentId, doc.documentRevision);
    assert.equal(preview.preview.clip.frames.length, 0); assert.equal(preview.modifiedFrameIds.length, 3);
    const save = await drafts.save(pid, doc.documentId, doc.documentRevision); assert.equal(save.clip.frames.length, 0);
    const empty = drafts.create(pid, { clipId: clip.id, revision: save.clip.revision }, "human");
    assert.equal((await drafts.preview(pid, empty.documentId, empty.documentRevision)).preview.clip.frames.length, 0);
    const path = store.safePath(pid, save.clip.file!);
    writeFileSync(path, readFileSync(path, "utf8") + " ");
    await assert.rejects(drafts.save(pid, empty.documentId, empty.documentRevision), /外部修改/);
  } finally { store.worker.close(); }
});
