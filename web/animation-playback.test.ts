import test from "node:test";
import assert from "node:assert/strict";
import type { ClipSnapshot } from "../studio/model.ts";
import { animationChangeSummary, animationDurationMs, animationFrameAt } from "./animation-playback.ts";
const snapshot = (durations: number[], loop = true): ClipSnapshot => ({ id: "s", projectId: "p", createdAt: "", images: {}, clip: { id: "c", type: "clip", name: "idle", revision: "r", createdAt: "", loop, frames: durations.map((ms, index) => ({ id: `f${index}`, imageId: "i", durationUs: ms * 1000 })) } });
test("real frame durations, loop boundaries, one-shot end and empty clips", () => {
  const clip = snapshot([100, 300, 200]);
  assert.equal(animationDurationMs(clip), 600);
  assert.deepEqual([0, 99, 100, 399, 400, 599, 600, 1000].map(time => animationFrameAt(clip, time)), [0, 0, 1, 1, 2, 2, 0, 2]);
  assert.equal(animationFrameAt(snapshot([100, 300], false), 5000), 1);
  assert.equal(animationFrameAt(snapshot([]), 5000), -1);
  assert.equal(animationDurationMs(snapshot([])), 0);
});
test("same clock does not force different clip timings into matching frame indexes", () => {
  assert.equal(animationFrameAt(snapshot([100, 100]), 150), 1);
  assert.equal(animationFrameAt(snapshot([300, 100]), 150), 0);
  assert.match(animationChangeSummary(snapshot([100]), snapshot([600], false)).join(";"), /0.100 → 0.600/);
});
