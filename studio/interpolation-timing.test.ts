import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { interpolateFrames } from "./interpolation-timing.ts";
import { interpolationSchema, interpolationLayoutSchema, type ClipFrame } from "./model.ts";

const frame = (durationUs = 100001): ClipFrame => ({ id: randomUUID(), imageId: randomUUID(), durationUs });
const total = (frames: ClipFrame[]) => frames.reduce((n, f) => n + f.durationUs, 0);

test("default policies retain interior instances and pixels, and conserve exact interval duration", () => {
  const frames = [frame(), frame(123457), frame(180001), frame(54321), frame()];
  frames[1]!.transform = { scale: 1.2, offsetX: 3, offsetY: 0, clip: false };
  const added = [frame(), frame()];
  const result = interpolateFrames(frames, frames[1]!.id, frames[3]!.id, added, { fps: 8 });
  assert.equal(total(result), total(frames));
  assert.deepEqual(result.map(f => f.id), [frames[0]!.id, frames[1]!.id, ...added.map(f => f.id), frames[2]!.id, frames[3]!.id, frames[4]!.id]);
  assert.deepEqual(result[0], frames[0]);
  assert.deepEqual(result.slice(-2), frames.slice(-2));
  assert.deepEqual(result[1]!.transform, frames[1]!.transform);
  assert.equal(result[1]!.imageId, frames[1]!.imageId);
  const durations = result.slice(1, 5).map(f => f.durationUs);
  assert.deepEqual(durations, [75865, 75864, 75865, 75864]);
  assert.deepEqual(frames[1]!.durationUs, 123457);
});

test("explicit replace removes only interior frames, preserve-duration still retains total", () => {
  const frames = [frame(), frame(200003), frame(300001), frame(77777), frame()];
  const result = interpolateFrames(frames, frames[1]!.id, frames[3]!.id, [frame(), frame()], { interiorPolicy: "replace", fps: 8 });
  assert.equal(result.length, frames.length + 1);
  assert.equal(total(result), total(frames));
  assert.ok(!result.some(f => f.id === frames[2]!.id));
  assert.deepEqual(result.slice(-2), frames.slice(-2));
});

test("fps is explicit; retained originals keep timing and cumulative new durations do not drift", () => {
  const frames = [frame(), frame(), frame(), frame()];
  const added = Array.from({ length: 7 }, () => frame());
  const result = interpolateFrames(frames, frames[0]!.id, frames[3]!.id, added, { timingPolicy: "fps", fps: 7 });
  assert.equal(total(result) - total(frames), 1000000);
  assert.deepEqual(result.filter(f => frames.some(old => old.id === f.id)), frames);
  const replaced = interpolateFrames(frames, frames[0]!.id, frames[3]!.id, added, { timingPolicy: "fps", interiorPolicy: "replace", fps: 7 });
  assert.equal(total(replaced), frames[0]!.durationUs + 1000000 + frames[3]!.durationUs);
  assert.deepEqual(replaced[0], frames[0]);
  assert.deepEqual(replaced.at(-1), frames[3]);
});

test("minimum timing, stable endpoint order, and actual preserve/replace frame limits are enforced", () => {
  const tiny = [frame(1000), frame(1000)];
  assert.throws(() => interpolateFrames(tiny, tiny[0]!.id, tiny[1]!.id, [frame()], { fps: 8 }), /1000us/);
  assert.throws(() => interpolateFrames(tiny, tiny[1]!.id, tiny[0]!.id, [frame()], { fps: 8 }), /尾帧/);
  assert.throws(() => interpolateFrames(tiny, randomUUID(), tiny[1]!.id, [frame()], { fps: 8 }), /尾帧/);
  const full = Array.from({ length: 128 }, () => frame());
  assert.throws(() => interpolateFrames(full, full[0]!.id, full[127]!.id, [frame()], { fps: 8 }), /128/);
  assert.equal(interpolateFrames(full, full[0]!.id, full[127]!.id, [frame()], { fps: 8, interiorPolicy: "replace" }).length, 3);
  assert.throws(() => interpolateFrames(tiny, tiny[0]!.id, tiny[1]!.id, [frame()], { timingPolicy: "fps", fps: Infinity }), /fps/);
});

test("schemas default both preservation policies; optional layout fps never opts into timing change", () => {
  const spec = interpolationSchema.parse({ requestId: randomUUID(), clipId: randomUUID(), revision: "v1", startFrameId: randomUUID(), endFrameId: randomUUID(), count: 2, description: "transition" });
  assert.equal(spec.timingPolicy, "preserve-duration");
  assert.equal(spec.interiorPolicy, "preserve");
  const layout = interpolationLayoutSchema.parse({ columns: 2, rows: 2, fps: 60 });
  assert.equal(layout.timingPolicy, undefined);
  assert.equal(interpolationLayoutSchema.parse({ columns: 2, rows: 2 }).fps, undefined);
});
