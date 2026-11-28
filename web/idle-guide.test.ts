import test from "node:test";
import assert from "node:assert/strict";
import { resolveIdleGuide } from "./idle-guide.ts";
import type { Asset } from "../studio/model.ts";

const image = (id: string, name: string, frameCount = 1) =>
  ({ id, type: "image", name, frameCount, width: 32, height: 32 }) as unknown as Asset;
const clip = (id: string, name: string, imageIds: string[]) =>
  ({
    id,
    type: "clip",
    name,
    frames: imageIds.map((imageId) => ({ id: crypto.randomUUID(), imageId, durationUs: 100000 })),
  }) as unknown as Asset;

test("an unset or unreachable IDLE guide resolves to not-configured", () => {
  const assets = [image("a", "待机帧"), clip("c", "idle", ["a"])];
  assert.equal(resolveIdleGuide(undefined, assets), null);
  assert.equal(resolveIdleGuide({ kind: "image", assetId: "missing", opacity: 0.2 }, assets), null);
  assert.equal(resolveIdleGuide({ kind: "clip", assetId: "missing", opacity: 0.2 }, assets), null);
  assert.equal(resolveIdleGuide({ kind: "clip", assetId: "a", opacity: 0.2 }, assets), null, "图片 ID 不能当作动画来源");
});

test("a clip guide follows its first frame and an image guide resolves directly", () => {
  const assets = [image("a", "待机帧"), image("b", "另一帧"), clip("c", "idle", ["b", "a"])];
  assert.deepEqual(resolveIdleGuide({ kind: "clip", assetId: "c", opacity: 0.3 }, assets), { imageId: "b", opacity: 0.3, label: "idle 首帧" });
  assert.deepEqual(resolveIdleGuide({ kind: "image", assetId: "a", opacity: 0.22 }, assets), { imageId: "a", opacity: 0.22, label: "待机帧" });
});

test("empty animations, missing first frames and animated images stay unconfigured", () => {
  const assets = [image("a", "待机帧"), clip("empty", "空动画", []), clip("stale", "断帧", ["gone"]), image("gif", "动图", 3)];
  assert.equal(resolveIdleGuide({ kind: "clip", assetId: "empty", opacity: 0.2 }, assets), null);
  assert.equal(resolveIdleGuide({ kind: "clip", assetId: "stale", opacity: 0.2 }, assets), null);
  assert.equal(resolveIdleGuide({ kind: "image", assetId: "gif", opacity: 0.2 }, assets), null, "多帧图片不能作为叠加基准");
});
