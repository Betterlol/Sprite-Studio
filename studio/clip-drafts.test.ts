import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, renameSync, statSync, utimesSync } from "node:fs";
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

test("creation rejects preexisting external clip, config and metadata changes", async () => {
  const { store, pid, clip, drafts } = await fixture();
  try {
    writeFileSync(store.safePath(pid, clip.file! + ".config.json"), JSON.stringify({ schemaVersion: 1, type: "clip", frames: clip.frames, loop: clip.loop, initialFps: clip.initialFps || 12 }));
    for (const path of [clip.file!, clip.file! + ".config.json", store.metaPath(pid, clip.id)]) {
      const file = store.safePath(pid, path), original = readFileSync(file, "utf8"), changed = JSON.parse(original);
      if (path.endsWith(".config.json")) changed.loop = !changed.loop;
      else if (path.endsWith(".meta.json")) changed.name = "external";
      else changed.frames = [];
      writeFileSync(file, JSON.stringify(changed));
      assert.throws(() => drafts.create(pid, { clipId: clip.id, revision: clip.revision }, "human"), /外部修改/);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), changed);
      writeFileSync(file, original);
    }
    assert.ok(drafts.create(pid, { clipId: clip.id, revision: clip.revision }, "human"));
  } finally { store.worker.close(); }
});

test("legacy metadata defaults and pre-FPS clips load without trusting explicit wrong paths", async () => {
  const { store, pid, clip } = await fixture(); let restored: ProjectStore | undefined;
  try {
    const metaPath = store.safePath(pid, store.metaPath(pid, clip.id));
    const metadata = JSON.parse(readFileSync(metaPath, "utf8"));
    delete metadata.file; delete metadata.folder; delete metadata.initialFps;
    writeFileSync(metaPath, JSON.stringify(metadata));
    const oldPath = store.safePath(pid, clip.file!);
    const legacyPath = store.safePath(pid, `Assets/${clip.folder}/${clip.id}.clip.json`);
    const raw = JSON.parse(readFileSync(oldPath, "utf8")); delete raw.initialFps;
    writeFileSync(oldPath, JSON.stringify(raw)); renameSync(oldPath, legacyPath);
    restored = new ProjectStore(store.root);
    const loaded = restored.animation.clip(pid, clip.id), drafts = new ClipDrafts(restored);
    assert.equal(loaded.file, `Assets/${clip.folder}/${clip.id}.clip.json`);
    const doc = drafts.create(pid, { clipId: clip.id, revision: loaded.revision }, "human");
    assert.equal((await drafts.preview(pid, doc.documentId, doc.documentRevision)).preview.clip.frames.length, 3);
    const bad = { ...metadata, file: `Assets/${clip.folder}/wrong.clip.json` };
    writeFileSync(metaPath, JSON.stringify(bad));
    assert.throws(() => drafts.create(pid, { clipId: clip.id, revision: loaded.revision }, "human"), /外部修改/);
    assert.deepEqual(JSON.parse(readFileSync(metaPath, "utf8")), bad);
    writeFileSync(metaPath, JSON.stringify({ ...metadata, folder: "wrong" }));
    assert.throws(() => drafts.create(pid, { clipId: clip.id, revision: loaded.revision }, "human"), /外部修改/);
    writeFileSync(metaPath, JSON.stringify(metadata));
    const resumed = drafts.create(pid, { clipId: clip.id, revision: loaded.revision }, "human");
    assert.equal(resumed.documentId, doc.documentId);
    assert.equal((await drafts.save(pid, doc.documentId, doc.documentRevision)).clip.frames.length, 3);
  } finally { store.worker.close(); restored?.worker.close(); }
});

test("historical and discarded draft frame IDs stay reserved to their animation", async () => {
  const { store, pid, image, clip, drafts } = await fixture(); let restored: ProjectStore | undefined;
  try {
    const oldId = crypto.randomUUID();
    const other = store.createClip(pid, "other", [{ id: oldId, imageId: image.id, durationUs: 100000 }]);
    store.animation.capture(pid, other.id);
    store.updateClip(pid, other.id, { revision: other.revision, frames: [], loop: other.loop });
    let doc = drafts.create(pid, { clipId: clip.id, revision: clip.revision }, "human");
    assert.throws(() => update(drafts, pid, doc, v => { v.frames.push({ id: oldId, imageId: image.id, durationUs: 100000 }); }), /其他动画/);
    const currentOther = store.animation.clip(pid, other.id);
    let otherDoc = drafts.create(pid, { clipId: other.id, revision: currentOther.revision }, "human");
    const addedId = crypto.randomUUID();
    otherDoc = update(drafts, pid, otherDoc, v => { v.frames.push({ id: addedId, imageId: image.id, durationUs: 100000 }); });
    otherDoc = update(drafts, pid, otherDoc, v => { v.frames = []; });
    drafts.discard(pid, otherDoc.documentId, otherDoc.documentRevision);
    restored = new ProjectStore(store.root);
    const fresh = new ClipDrafts(restored); doc = fresh.read(pid, doc.documentId);
    assert.throws(() => update(fresh, pid, doc, v => { v.frames.push({ id: addedId, imageId: image.id, durationUs: 100000 }); }), /其他动画/);
  } finally { store.worker.close(); restored?.worker.close(); }
});

test("history created by updateClip is checked even with an unchanged directory timestamp", async () => {
  const { store, pid, clip, image, drafts } = await fixture();
  try {
    const id = crypto.randomUUID();
    const other = store.createClip(pid, "other", [{ id, imageId: image.id, durationUs: 100000 }]);
    const folder = store.safePath(pid, ".studio/history"), fixed = new Date("2020-01-01T00:00:00Z");
    utimesSync(folder, fixed, fixed);
    const stamp = statSync(folder).mtimeMs;
    const doc = drafts.create(pid, { clipId: clip.id, revision: clip.revision }, "human");
    assert.ok(![...store.animation.snapshots.values()].some(s => s.clip.id === other.id));
    store.updateClip(pid, other.id, { revision: other.revision, frames: [], loop: other.loop });
    utimesSync(folder, fixed, fixed);
    assert.equal(statSync(folder).mtimeMs, stamp);
    assert.throws(() => update(drafts, pid, doc, v => { v.frames.push({ id, imageId: image.id, durationUs: 100000 }); }), /其他动画/);
  } finally { store.worker.close(); }
});

test("discard from another service during render prevents the final save", async () => {
  const { store, pid, clip, drafts } = await fixture();
  try {
    let doc = drafts.create(pid, { clipId: clip.id, revision: clip.revision }, "human");
    doc = update(drafts, pid, doc, v => { v.loop = false; });
    const render = store.animation.renderFrame.bind(store.animation);
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { started = r; });
    store.animation.renderFrame = async (...args) => { started(); await waiting; return render(...args); };
    const pending = drafts.save(pid, doc.documentId, doc.documentRevision);
    await entered;
    new ClipDrafts(store).discard(pid, doc.documentId, doc.documentRevision);
    release();
    await assert.rejects(pending, /结束|改变/);
    assert.equal(drafts.read(pid, doc.documentId).draft.status, "discarded");
    assert.equal(store.animation.clip(pid, clip.id).revision, clip.revision);
  } finally { store.worker.close(); }
});

test("identity index updates across service instances after in-place draft writes", async () => {
  const { store, pid, clip, image, drafts } = await fixture();
  try {
    const other = store.createClip(pid, "other", []), peer = new ClipDrafts(store);
    const a = drafts.create(pid, { clipId: clip.id, revision: clip.revision }, "human");
    let b = peer.create(pid, { clipId: other.id, revision: other.revision }, "human");
    const reserved = crypto.randomUUID();
    b = update(peer, pid, b, v => { v.frames.push({ id: reserved, imageId: image.id, durationUs: 100000 }); });
    assert.throws(() => update(drafts, pid, a, v => { v.frames.push({ id: reserved, imageId: image.id, durationUs: 100000 }); }), /其他动画/);
    b = update(peer, pid, b, v => { v.frames = []; });
    assert.throws(() => update(drafts, pid, a, v => { v.frames.push({ id: reserved, imageId: image.id, durationUs: 100000 }); }), /其他动画/);
    peer.discard(pid, b.documentId, b.documentRevision);
    assert.throws(() => update(drafts, pid, a, v => { v.frames.push({ id: reserved, imageId: image.id, durationUs: 100000 }); }), /其他动画/);
  } finally { store.worker.close(); }
});

test("new image dependencies freeze at write and reject subsequent pixel changes", async () => {
  const { store, pid, clip, drafts, image } = await fixture();
  try {
    const added = await store.importImage(pid, "added.png", readFileSync(store.imagePath(pid, image.id)));
    let doc = drafts.create(pid, { clipId: clip.id, revision: clip.revision }, "human");
    doc = update(drafts, pid, doc, v => { v.frames.push({ id: crypto.randomUUID(), imageId: added.id, durationUs: 100000 }); });
    const preview = await drafts.preview(pid, doc.documentId, doc.documentRevision);
    assert.equal(preview.preview.images[added.id]!.contentHash, added.contentHash);
    writeFileSync(store.imagePath(pid, added.id), "external pixel change");
    await assert.rejects(drafts.preview(pid, doc.documentId, doc.documentRevision), /修改|变化/);
    await assert.rejects(drafts.save(pid, doc.documentId, doc.documentRevision), /修改|变化/);
    assert.equal(store.animation.clip(pid, clip.id).revision, clip.revision);
  } finally { store.worker.close(); }
});
