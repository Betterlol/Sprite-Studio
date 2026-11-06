import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClipSnapshot, RenderWarning } from "./model.ts";
import { checkStaticQuality, decideDelivery, decideRepair, generationBudgetCapability, getQualityCapabilities, unverifiedTemporalCheck } from "./quality.ts";

const snapshot = { id: "snapshot", clip: { id: "clip", frames: [
  { id: "jump", imageId: "image", durationUs: 100_000 },
  { id: "cape", imageId: "image", durationUs: 100_000 },
  { id: "hold", imageId: "image", durationUs: 400_000 },
], loop: false }, images: { image: { id: "image", mime: "image/png", contentHash: "hash", width: 64, height: 64 } } } as unknown as ClipSnapshot;
const scope = { clipId: "clip" };
const base = { snapshot, scope, id: "check", createdAt: "2026-01-01T00:00:00Z", warnings: [] as RenderWarning[] };
const warning = (frameId: string, blocking: boolean): RenderWarning => ({ frameId, bounds: [-1, 0, 64, 64], overflow: { left: 1, top: 0, right: 0, bottom: 0 }, blocking });

test("normal jump cape and hold are only suspects, never repaired", () => {
  const check = checkStaticQuality({ ...base, observations: [
    { location: "jump", category: "center", evidence: "jump height" },
    { location: "cape", category: "size", evidence: "cape opens" },
    { location: "hold", category: "timing", evidence: "intentional pause" },
    { location: "cape", category: "color", evidence: "color difference" },
  ] });
  assert.equal(check.status, "suspect");
  assert.ok(check.findings.every(f => f.status === "suspect"));
  assert.equal(snapshot.clip.frames[2]!.durationUs, 400_000);
});
test("only deterministic violations block, respecting allowed clipping and range", () => {
  const invalid = structuredClone(snapshot);
  invalid.clip.frames[0]!.durationUs = 0;
  invalid.clip.frames[1]!.imageId = "missing";
  const check = checkStaticQuality({ ...base, snapshot: invalid, warnings: [warning("hold", true)] });
  assert.equal(check.status, "failed");
  assert.equal(check.findings.length, 3);
  assert.equal(checkStaticQuality({ ...base, warnings: [warning("hold", false)] }).status, "suspect");
  assert.equal(checkStaticQuality({ ...base, scope: { clipId: "clip", startFrameId: "jump", endFrameId: "cape" }, warnings: [warning("hold", true)] }).status, "passed");
  assert.throws(() => checkStaticQuality({ ...base, scope: { clipId: "other" } }));
});
test("missing renderer evidence is unverified and blocks delivery", () => {
  const incomplete = checkStaticQuality({ ...base, warnings: undefined, observations: [{ location: "jump", category: "center", evidence: "jump" }] });
  assert.equal(incomplete.status, "unverified");
  assert.ok(incomplete.findings.some(f => f.status === "unverified"));
  assert.equal(decideDelivery({ snapshotId: snapshot.id, checks: [incomplete], requiredChecks: ["static"] }).status, "blocked");
  assert.equal(checkStaticQuality(base).status, "passed");
  const invalid = structuredClone(snapshot);
  invalid.clip.frames[0]!.durationUs = 0;
  assert.equal(checkStaticQuality({ ...base, snapshot: invalid, warnings: undefined }).status, "failed");
});
test("frame observations outside the selected range are excluded", () => {
  const check = checkStaticQuality({ ...base, scope: { clipId: "clip", startFrameId: "jump", endFrameId: "cape" }, observations: [
    { location: "hold", category: "timing", evidence: "out of scope" },
    { location: "jump", category: "center", evidence: "in scope" },
  ] });
  assert.equal(check.status, "suspect");
  assert.deepEqual(check.findings.map(f => f.location), ["jump"]);
});
test("repair policy stops after two failures of same issue and at limit", () => {
  assert.deepEqual(decideRepair({ limit: 3, actionable: true, rounds: [{ issueId: "a", improved: false }, { issueId: "a", improved: false }] }), { stop: true, reason: "no-progress" });
  assert.equal(decideRepair({ limit: 3, actionable: true, rounds: [{ issueId: "a", improved: false }, { issueId: "a", improved: true }] }).stop, false);
  assert.equal(decideRepair({ limit: 2, actionable: true, rounds: [{ issueId: "a", improved: true }, { issueId: "b", improved: true }] }).reason, "limit");
  assert.equal(decideRepair({ limit: 3, actionable: true, rounds: [], conflict: true }).reason, "conflict");
  assert.equal(decideRepair({ limit: 3, actionable: true, rounds: [], capabilityAvailable: false }).reason, "capability");
});
test("temporal remains unverified and delivery separates blocking from human review", () => {
  assert.equal(getQualityCapabilities().temporal.verified, false);
  assert.equal(getQualityCapabilities().unattendedGeneration, false);
  const temporal = unverifiedTemporalCheck({ id: "temporal", snapshotId: snapshot.id, scope, createdAt: base.createdAt });
  const clean = checkStaticQuality(base);
  assert.equal(temporal.status, "unverified");
  assert.deepEqual(decideDelivery({ snapshotId: snapshot.id, checks: [clean, temporal], requiredChecks: ["static", "temporal"] }), { status: "ready", reasons: [], pendingHumanDynamicReview: true });
  assert.equal(decideDelivery({ snapshotId: snapshot.id, checks: [{ ...clean, status: "failed" }], requiredChecks: ["static"] }).status, "blocked");
  assert.equal(decideDelivery({ snapshotId: "new", checks: [clean], requiredChecks: ["static"] }).status, "blocked");
});
test("ledger never grants hard budget capability", () => {
  assert.equal(generationBudgetCapability().preflightHardControl, false);
  assert.equal(generationBudgetCapability().unattendedGeneration, false);
  assert.match(generationBudgetCapability().reason, /日志/);
});
