import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectStore } from "./store.ts";
import { ReviewSequences } from "./review-sequences.ts";
import type { ClipAsset } from "./model.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sprite-sequences-")), file = join(root, "image.png");
  const result = spawnSync(process.env.SPRITE_STUDIO_PYTHON || "python", ["-I", "-c", "from PIL import Image,ImageDraw; import sys; im=Image.new('RGBA',(32,32)); ImageDraw.Draw(im).rectangle((8,8,23,23),fill='red'); im.save(sys.argv[1])", file], { windowsHide: true });
  assert.equal(result.status, 0, result.stderr.toString());
  const store = new ProjectStore(join(root, "projects"));
  const pid = store.createProject("sequence test").id;
  const image = await store.importImage(pid, "one.png", readFileSync(file));
  const make = (name: string, durations: number[]) => store.createClip(pid, name, durations.map(durationUs => ({ id: randomUUID(), imageId: image.id, durationUs })));
  const a = make("a", [100001, 200003, 300001]), b = make("b", [123457, 76543]);
  const sequences = new ReviewSequences(store);
  const segment = (clip: ClipAsset, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), clipId: clip.id, ...extra });
  return { root, store, pid, image, a, b, make, sequences, segment };
}

test("multiple segments preserve order, duplicates, exact cumulative speed timing and source-instance mappings", async () => {
  const { store, pid, image, a, b, sequences, segment } = await fixture();
  try {
    const first = segment(a, { startFrameId: a.frames[1]!.id, repeat: 3, speed: 3 });
    const second = segment(b, { endFrameId: b.frames[0]!.id, speed: 2 });
    const definition = sequences.create(pid, { requestId: randomUUID(), name: "montage", loop: true, segments: [first, second] });
    const capture = sequences.capture(pid, definition.id), frozen = store.animation.snapshot(pid, capture.snapshotId);
    assert.equal(frozen.clip.frames.length, 7);
    assert.equal(new Set(frozen.clip.frames.map(f => f.id)).size, 7);
    assert.equal(Object.keys(frozen.images).length, 1);
    assert.equal(frozen.images[image.id]!.contentHash, image.contentHash);
    assert.deepEqual(capture.frameSources.map(f => f.sourceFrameId), [...Array.from({ length: 3 }, () => [a.frames[1]!.id, a.frames[2]!.id]).flat(), b.frames[0]!.id]);
    assert.deepEqual(capture.frameSources.map(f => f.repeatIndex), [0, 0, 1, 1, 2, 2, 0]);
    assert.deepEqual(capture.segments[0]!.frameIds, frozen.clip.frames.slice(0, 6).map(f => f.id));
    assert.equal(frozen.clip.frames.reduce((n, f) => n + f.durationUs, 0), Math.round((200003 + 300001) + 123457 / 2));
    assert.equal(readFileSync((await store.animation.renderFrame(pid, frozen.id, frozen.clip.frames[0]!.id)).path).length > 0, true);
    assert.equal(sequences.list(pid).length, 1);
    assert.equal(sequences.get(pid, definition.id).unresolved.length, 0);
  } finally { store.worker.close(); }
});

test("definition CAS, idempotent create and project ownership survive restart", async () => {
  const { root, store, pid, a, sequences, segment } = await fixture();
  let restored: ProjectStore | undefined;
  try {
    const input = { requestId: randomUUID(), name: "montage", loop: false, segments: [segment(a)] };
    const definition = sequences.create(pid, input);
    assert.equal(sequences.create(pid, input).revision, definition.revision);
    assert.throws(() => sequences.create(pid, { ...input, name: "different" }), /requestId/);
    const snapshot = sequences.capture(pid, definition.id);
    const updated = sequences.update(pid, definition.id, { expectedRevision: definition.revision, name: "renamed", loop: false, segments: definition.segments });
    assert.notEqual(updated.revision, definition.revision);
    assert.throws(() => sequences.update(pid, definition.id, { expectedRevision: definition.revision, name: "old", loop: false, segments: definition.segments }), /已修改/);
    const other = store.createProject("other").id;
    assert.throws(() => sequences.get(other, definition.id), /不存在/);
    assert.throws(() => sequences.create(other, { ...input, requestId: randomUUID() }), /不存在/);
    assert.throws(() => sequences.capture(other, definition.id), /不存在/);
    assert.throws(() => sequences.listSnapshots(other, definition.id), /不存在/);
    store.worker.close();
    restored = new ProjectStore(join(root, "projects"));
    const reload = new ReviewSequences(restored);
    assert.equal(reload.get(pid, definition.id).revision, updated.revision);
    assert.equal(reload.listSnapshots(pid, definition.id)[0]!.stale, false);
    const frozen = restored.animation.snapshot(pid, snapshot.snapshotId);
    assert.ok((await restored.animation.renderFrame(pid, frozen.id, frozen.clip.frames[0]!.id)).path);
    assert.equal(reload.create(pid, input).revision, updated.revision);
  } finally { store.worker.close(); restored?.worker.close(); }
});

test("renames and real folder moves do not invalidate pixels; dependency edits and removed boundaries do", async () => {
  const { store, pid, a, image, sequences, segment } = await fixture();
  try {
    const definition = sequences.create(pid, { requestId: randomUUID(), name: "sequence", loop: false, segments: [segment(a, { startFrameId: a.frames[1]!.id })] });
    const capture = sequences.capture(pid, definition.id);
    store.library.createFolder(pid, "动画", "moved", store.library.revision(pid));
    store.library.relocate(pid, { assetIds: [a.id], folders: [] }, "动画/moved", store.library.revision(pid), "renamed");
    store.library.relocate(pid, { assetIds: [image.id], folders: [] }, "参考图", store.library.revision(pid), "renamed.png");
    assert.equal(sequences.listSnapshots(pid, definition.id)[0]!.stale, false);
    const current = store.asset(pid, a.id) as ClipAsset;
    const updated = store.updateClip(pid, a.id, { revision: current.revision, loop: current.loop, frames: current.frames.filter(f => f.id !== a.frames[1]!.id) });
    assert.equal(updated.frames[1]!.id, a.frames[2]!.id);
    assert.equal(sequences.get(pid, definition.id).unresolved.length, 1);
    assert.throws(() => sequences.capture(pid, definition.id), /unresolved/);
    assert.equal(sequences.listSnapshots(pid, definition.id)[0]!.stale, true);
    assert.equal(store.animation.snapshot(pid, capture.snapshotId).clip.frames[0]!.imageId, image.id);
  } finally { store.worker.close(); }
});

test("pixel and definition changes mark snapshots stale, while old immutable pixels remain playable", async () => {
  const { store, pid, a, image, sequences, segment } = await fixture();
  try {
    const definition = sequences.create(pid, { requestId: randomUUID(), name: "sequence", loop: false, segments: [segment(a)] });
    const capture = sequences.capture(pid, definition.id), frozen = store.animation.snapshot(pid, capture.snapshotId);
    const original = readFileSync(store.imagePath(pid, image.id));
    writeFileSync(store.imagePath(pid, image.id), Buffer.from("external change"));
    assert.equal(sequences.listSnapshots(pid, definition.id)[0]!.stale, true);
    assert.deepEqual(readFileSync((await store.animation.renderFrame(pid, frozen.id, frozen.clip.frames[0]!.id)).path), original);
    writeFileSync(store.safePath(pid, image.file), original);
    assert.equal(sequences.listSnapshots(pid, definition.id)[0]!.stale, false);
    sequences.update(pid, definition.id, { expectedRevision: definition.revision, name: "sequence", loop: true, segments: definition.segments });
    assert.equal(sequences.listSnapshots(pid, definition.id)[0]!.stale, true);
  } finally { store.worker.close(); }
});

test("singleton loop inspection generates real worker self-pair and persisted onion evidence", async () => {
  const { store, pid, make, sequences, segment } = await fixture();
  try {
    const single = make("single", [123457]);
    const definition = sequences.create(pid, { requestId: randomUUID(), name: "single loop", loop: true, segments: [segment(single)] });
    const captured = sequences.capture(pid, definition.id);
    const result = await sequences.inspect(pid, definition.id, { snapshotId: captured.id });
    assert.deepEqual(result.pairs, [{ from: 0, to: 0, loopBoundary: true }]);
    assert.deepEqual(result.sequence.coverage.pairs, result.pairs);
    assert.deepEqual(result.sequence.coverage.boundaries, [{ from: 0, to: 0, kind: "loop", covered: true }]);
    assert.equal(result.sequence.coverage.complete, true);
    assert.deepEqual(store.animation.review(pid, result.id).pairs, result.pairs);
    for (const kind of ["contact", "onion"] as const)
      assert.ok(readFileSync(store.animation.evidence(pid, result.id, kind)).length > 100);
    const direct = await store.animation.inspect(pid, { clipId: single.id });
    assert.deepEqual(direct.pairs, [{ from: 0, to: 0, loopBoundary: true }]);
    const nonLoop = sequences.create(pid, { requestId: randomUUID(), name: "single hold", loop: false, segments: [segment(single)] });
    const hold = await sequences.inspect(pid, nonLoop.id);
    assert.deepEqual(hold.pairs, []);
    assert.equal(hold.sequence.coverage.complete, true);
  } finally { store.worker.close(); }
});

test("different same-canvas pixels and per-instance transforms retain exact source mapping and frozen playback", async () => {
  const { store, pid, image, a, sequences, segment } = await fixture();
  try {
    const different = await store.transform(pid, image.id, image.revision, { scale: 0.5 });
    assert.deepEqual([different.width, different.height], [image.width, image.height]);
    assert.notEqual(different.contentHash, image.contentHash);
    const b = store.createClip(pid, "different pixels and transforms", [
      { id: randomUUID(), imageId: different.id, durationUs: 180001, transform: { scale: 1, offsetX: 2, offsetY: 1, clip: false } },
      { id: randomUUID(), imageId: image.id, durationUs: 100003, transform: { scale: 0.5, offsetX: -3, offsetY: 0, clip: false } },
    ]);
    const first = segment(a, { endFrameId: a.frames[1]!.id });
    const second = segment(b, { repeat: 2 });
    const definition = sequences.create(pid, { requestId: randomUUID(), name: "varied montage", loop: true, segments: [first, second] });
    const captured = sequences.capture(pid, definition.id);
    const frozen = store.animation.snapshot(pid, captured.snapshotId);
    assert.equal(Object.keys(frozen.images).length, 2);
    assert.deepEqual(captured.frameSources.map(f => [f.clipId, f.sourceFrameId]), [
      [a.id, a.frames[0]!.id], [a.id, a.frames[1]!.id],
      ...Array.from({ length: 2 }, () => b.frames.map(f => [b.id, f.id])).flat(),
    ]);
    const rendered: Buffer[] = [];
    for (const [index, mapping] of captured.frameSources.entries()) {
      const dependency = captured.dependencies.find(d => d.clipId === mapping.clipId)!;
      const source = store.animation.snapshot(pid, dependency.snapshotId).clip.frames.find(f => f.id === mapping.sourceFrameId)!;
      assert.equal(frozen.clip.frames[index]!.imageId, source.imageId);
      assert.deepEqual(frozen.clip.frames[index]!.transform, source.transform);
      const actual = readFileSync((await store.animation.renderFrame(pid, frozen.id, mapping.frameId)).path);
      const expected = readFileSync((await store.animation.renderFrame(pid, dependency.snapshotId, source.id)).path);
      assert.deepEqual(actual, expected);
      rendered.push(actual);
    }
    assert.notDeepEqual(rendered[0], rendered[2]);
    assert.notDeepEqual(rendered[2], readFileSync(store.imagePath(pid, different.id)));
    const inspected = await sequences.inspect(pid, definition.id, { snapshotId: captured.id });
    assert.equal(inspected.sequence.coverage.complete, true);
    assert.ok(inspected.sequence.coverage.boundaries.every(b => b.covered));
    store.updateClip(pid, b.id, { revision: b.revision, frames: [...b.frames].reverse(), loop: false });
    writeFileSync(store.imagePath(pid, different.id), Buffer.from("changed live pixels"));
    assert.equal(sequences.listSnapshots(pid, definition.id)[0]!.stale, true);
    for (const [index, frame] of frozen.clip.frames.entries())
      assert.deepEqual(readFileSync((await store.animation.renderFrame(pid, frozen.id, frame.id)).path), rendered[index]);
  } finally { store.worker.close(); }
});

test("inspection of more than 16 frames covers every join, repeat and full-loop boundary using old evidence APIs", async () => {
  const { store, pid, a, b, sequences, segment } = await fixture();
  try {
    const definition = sequences.create(pid, { requestId: randomUUID(), name: "long montage", loop: true, segments: [segment(a, { repeat: 6 }), segment(b, { repeat: 3 })] });
    const capture = sequences.capture(pid, definition.id);
    const result = await sequences.inspect(pid, definition.id, { snapshotId: capture.id });
    const { coverage, reviews } = result.sequence;
    assert.equal(result.stale, false);
    assert.equal(result.snapshotId, capture.snapshotId);
    assert.equal(result.frames.length, 16);
    assert.equal(coverage.totalFrames, 24);
    assert.equal(new Set(coverage.frameIds).size, 24);
    assert.equal(coverage.complete, true);
    assert.deepEqual(coverage.ranges.map(r => [r.start, r.end]), [[0, 15], [16, 23]]);
    assert.equal(coverage.boundaries.filter(b => b.kind === "segment").length, 1);
    assert.equal(coverage.boundaries.filter(b => b.kind === "repeat").length, 7);
    assert.ok(coverage.boundaries.every(b => b.covered));
    assert.ok(coverage.pairs.some(p => p.from === 15 && p.to === 16));
    assert.ok(coverage.pairs.some(p => p.from === 23 && p.to === 0 && p.loopBoundary));
    for (const review of reviews) for (const kind of ["contact", "onion"] as const)
      assert.ok(readFileSync(store.animation.evidence(pid, review.id, kind)).length > 100);
    const retry = await sequences.inspect(pid, definition.id, { snapshotId: capture.snapshotId });
    assert.deepEqual(retry.sequence.reviews.map(r => r.id), reviews.map(r => r.id));
    const other = sequences.create(pid, { requestId: randomUUID(), name: "other", loop: false, segments: [segment(a)] });
    await assert.rejects(sequences.inspect(pid, other.id, { snapshotId: capture.id }), /不属于/);
  } finally { store.worker.close(); }
});

test("canvas mismatch, invalid ranges/repeats/speeds, duplicate segment IDs and expansion limits refuse rather than fit", async () => {
  const { store, pid, a, make, sequences, segment } = await fixture();
  try {
    const create = (segments: unknown[]) => sequences.create(pid, { requestId: randomUUID(), name: "bad", loop: false, segments });
    for (const repeat of [0, -1, 1.5, Infinity]) assert.throws(() => create([segment(a, { repeat })]));
    for (const speed of [0, -1, Infinity, NaN, 0.01, 11]) assert.throws(() => create([segment(a, { speed })]));
    const same = segment(a);
    assert.throws(() => create([same, same]), /身份不能重复/);
    assert.throws(() => create([segment(a, { startFrameId: randomUUID() })]), /unresolved/);
    assert.throws(() => create([segment(a, { repeat: 342 })]), /1024/);
    const slow = make("slow", [60_000_000]);
    assert.throws(() => create([segment(slow, { repeat: 11 })]), /10 分钟/);
    const resized = await store.transform(pid, a.frames[0]!.imageId, store.image(pid, a.frames[0]!.imageId).revision, { width: 64, height: 64 });
    const different = store.createClip(pid, "different", [{ id: randomUUID(), imageId: resized.id, durationUs: 100000 }]);
    assert.throws(() => create([segment(a), segment(different)]), /画布不一致.*fit/);
  } finally { store.worker.close(); }
});
