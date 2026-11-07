import test from "node:test";
import assert from "node:assert/strict";
import type { ClipAsset, FrameDraft, Session } from "../studio/model.ts";
import type { ProductionTask } from "../studio/workflow-model.ts";
import {
  directionMaterial, directionPayload, taskFeedbackPayload, taskConversation, ordinaryConversation, editingBlock,
  conversationDestination, assertConversation, reviewInspectionReducer, type ReviewInspection,
  type ReviewIdentity, legacyDraftsFor, legacyDerivation, finishFrameDrag, clipEdit,
} from "./workflow-state.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function task(overrides: Partial<ProductionTask> = {}): ProductionTask {
  return {
    id: id(1), projectId: id(2), sessionId: id(3), requestId: id(4), requestHash: "hash", revision: 7,
    intentVersion: 2, barrierVersion: 5, title: "task", description: "description", phase: "direction", status: "waiting",
    target: { assetId: id(5), revision: "input-image-v1", mode: "saved" }, referenceIds: [id(5)],
    contract: { roleReferenceIds: [], immutable: [], generationLimit: 1, repairLimit: 3, requiredChecks: ["static"] },
    attempts: [], directionHistory: [], findings: [], checks: [], acceptanceHistory: [], createdAt: "now", updatedAt: "now",
    ...overrides,
  };
}
function session(task: ProductionTask, generatedId = id(9)): Session {
  return {
    id: task.sessionId!, projectId: task.projectId, title: "bound", status: "running", messages: [], activities: [], createdAt: "now", updatedAt: "now",
    toolApproval: { id: id(8), tool: "save_image", label: "save", arguments: { generatedId, type: "resource", name: "result", folder: "work" }, createdAt: "now" },
  };
}
const attempt = { id: id(10), intentVersion: 2, status: "running" as const, generatedId: id(9), preflightVerified: false as const, unattendedAllowed: false as const, createdAt: "now", updatedAt: "now" };

test("I1 reference input is not combined with a pending generated direction result", () => {
  const value = task({ attempts: [attempt] }), bound = session(value);
  const payload = directionPayload(value, bound, true, "looks right");
  assert.deepEqual(directionMaterial(value, bound), { kind: "generated", generatedId: id(9) });
  assert.deepEqual(payload, { expectedRevision: 7, accept: true, feedback: "looks right", generatedId: id(9), toolApproval: { sessionId: id(3), approvalId: id(8) } });
  assert.equal("assetId" in payload, false); assert.equal("snapshotId" in payload, false);
});
test("I1 generated result does not inherit its input clip snapshot", () => {
  const value = task({ target: { clipId: id(11), snapshotId: id(12), revision: "clip-v1", mode: "saved" }, readySnapshotId: id(13), attempts: [attempt] });
  const payload = directionPayload(value, session(value), false, "wrong pose");
  assert.ok("generatedId" in payload);
  assert.equal(payload.generatedId, id(9)); assert.equal("snapshotId" in payload, false); assert.equal("assetId" in payload, false);
});
test("I1 frozen approval selects exactly the displayed generated artifact, not a previous saved attempt", () => {
  const value = task({ attempts: [{ ...attempt, generatedId: id(14), assetId: id(15), status: "completed" }] });
  const bound = session(value, id(16));
  assert.deepEqual(directionMaterial(value, bound), { kind: "generated", generatedId: id(16) });
  const payload = directionPayload(value, bound, true, "");
  assert.ok("generatedId" in payload); assert.equal(payload.generatedId, id(16));
  assert.equal("assetId" in directionPayload(value, bound, true, ""), false);
});
test("I1 saved image and existing snapshot directions use mutually exclusive result identities", () => {
  const imageTask = task({sessionId:undefined});
  const imagePayload = directionPayload(imageTask, undefined, true, "");
  assert.ok("assetId" in imagePayload); assert.equal(imagePayload.assetId, id(5));
  const clipTask = task({ target: { clipId: id(11), snapshotId: id(12), mode: "saved" } });
  const payload = directionPayload(clipTask, undefined, true, "");
  assert.ok("snapshotId" in payload);
  assert.equal(payload.snapshotId, id(12)); assert.equal("assetId" in payload, false); assert.equal("generatedId" in payload, false);
});
test("I1 unresolved current attempt cannot silently fall back to input or an older result", () => {
  const value = task({ attempts: [{ ...attempt, status: "completed" }, { ...attempt, id: id(17), status: "unknown", generatedId: undefined }] });
  assert.equal(directionMaterial(value), null);
  assert.throws(() => directionPayload(value, undefined, true, ""), /确切方向产物/);
});

test("R5 unknown retained artifact is explicit material, but failed/cancelled attempts never unlock direction", () => {
  const unknown = task({ attempts: [{ ...attempt, status: "unknown" }] });
  assert.deepEqual(directionMaterial(unknown), { kind: "generated", generatedId: id(9) });
  for (const status of ["failed", "cancelled", "reserved"] as const) {
    const ended = task({ attempts: [{ ...attempt, status }] });
    assert.equal(directionMaterial(ended), null);
    assert.equal(directionMaterial(ended, session(ended)), null);
  }
  const unknownWithoutArtifact = task({ attempts: [{ ...attempt, status: "unknown", generatedId: undefined }] });
  assert.equal(directionMaterial(unknownWithoutArtifact), null);
  assert.equal(directionMaterial(unknownWithoutArtifact, session(unknownWithoutArtifact)), null);
});

test("R2 acceptance omits blank optional feedback while rejection still requires a nonblank reason", () => {
  const value = task();
  assert.equal("feedback" in directionPayload(value, undefined, true, " \t\n"), false);
  assert.equal(directionPayload(value, undefined, true, "  looks right  ").feedback, "looks right");
  assert.throws(() => directionPayload(value, undefined, false, " \t"), /需要意见/);
});

test("I2 ordinary and new conversations atomically detach the previous task", () => {
  const value = task();
  const selected = taskConversation(value);
  assert.deepEqual(selected, { taskId: value.id, sessionId: value.sessionId });
  assert.deepEqual(ordinaryConversation([value], id(18)), { taskId: "", sessionId: id(18) });
  assert.deepEqual(ordinaryConversation([value], ""), { taskId: "", sessionId: "" });
  assert.deepEqual(ordinaryConversation([value], value.sessionId!), selected);
});
test("I2 newly returned task carries its bound session without waiting for task/session list refresh", () => {
  const returned = task({ id: id(19), sessionId: id(20) });
  const selected = taskConversation(returned);
  assert.deepEqual(conversationDestination([returned], selected), { taskId: id(19), sessionId: id(20), needsSession: false });
  assert.deepEqual(conversationDestination([], ordinaryConversation([], "")), { taskId: undefined, sessionId: "", needsSession: true });
});
test("I2 mismatched or missing task binding is rejected before message dispatch", () => {
  const value = task();
  assert.throws(() => assertConversation([value], { taskId: value.id, sessionId: id(21) }), /不匹配/);
  assert.throws(() => conversationDestination([], taskConversation(value)), /不匹配/);
  assert.doesNotThrow(() => assertConversation([value], taskConversation(value)));
});

const identity = (n: number): ReviewIdentity => ({ id: id(n), definitionId: id(30), projectId: id(2), snapshotId: id(n + 1) });
type Evidence = { sequence: ReviewIdentity; frames: number };
const empty = (): ReviewInspection<Evidence> => ({ selected: null, epoch: 0, evidence: null });
test("I3 capture/select S2 drops S1 evidence and cannot render its old coverage", () => {
  let state = reviewInspectionReducer(empty(), { type: "select", snapshot: identity(31) });
  state = reviewInspectionReducer(state, { type: "inspect", epoch: state.epoch, evidence: { sequence: identity(31), frames: 16 } });
  assert.equal(state.evidence?.frames, 16);
  const oldEpoch = state.epoch;
  state = reviewInspectionReducer(state, { type: "select", snapshot: identity(33) });
  assert.equal(state.evidence, null); assert.deepEqual(state.selected, identity(33));
  state = reviewInspectionReducer(state, { type: "inspect", epoch: oldEpoch, evidence: { sequence: identity(31), frames: 16 } });
  assert.equal(state.evidence, null);
  state = reviewInspectionReducer(state, { type: "inspect", epoch: state.epoch, evidence: { sequence: identity(33), frames: 32 } });
  assert.equal(state.evidence?.frames, 32);
});
test("I3 save/reset and selection ABA invalidate even same-snapshot late inspection", () => {
  let state = reviewInspectionReducer(empty(), { type: "select", snapshot: identity(31) });
  const before = state.epoch;
  state = reviewInspectionReducer(state, { type: "select", snapshot: null });
  assert.equal(state.evidence, null);
  state = reviewInspectionReducer(state, { type: "select", snapshot: identity(31) });
  state = reviewInspectionReducer(state, { type: "inspect", epoch: before, evidence: { sequence: identity(31), frames: 16 } });
  assert.equal(state.evidence, null);
});
test("I3 response must match project, definition, sequence and playback snapshot", () => {
  const state = reviewInspectionReducer(empty(), { type: "select", snapshot: identity(31) });
  for (const key of ["id", "snapshotId", "definitionId", "projectId"] as const) {
    const next = reviewInspectionReducer(state, { type: "inspect", epoch: state.epoch, evidence: { sequence: { ...identity(31), [key]: id(99) }, frames: 16 } });
    assert.equal(next.evidence, null);
  }
});

const clip: ClipAsset = { id: id(40), type: "clip", name: "clip", revision: "current-clip", loop: true, initialFps: 12, createdAt: "now", frames: [{ id: id(41), imageId: id(43), durationUs: 100000 }, { id: id(42), imageId: id(43), durationUs: 200000 }] };
function legacy(overrides: Partial<FrameDraft> = {}): FrameDraft {
  return { id: id(44), projectId: id(2), clipId: clip.id, frameId: id(41), baseSnapshotId: id(45), source: "human", status: "editing", createdAt: "now", documentRevision: "legacy-viewed-v2", text: "legacy body", ...overrides };
}
test("I4 legacy manual drafts remain discoverable by clip without exposing another clip", () => {
  const mine = legacy(), agent = legacy({ id: id(46), source: "agent", status: "pending" }), other = legacy({ id: id(47), clipId: id(48) });
  assert.deepEqual(legacyDraftsFor(clip.id, [mine, agent, other]), [mine, agent]);
});
test("I4 derivation uses viewed legacy revision, current clip CAS and a human destination", () => {
  const source = legacy();
  assert.deepEqual(legacyDerivation(clip, source), { clipId: clip.id, revision: "current-clip", source: "human", fromDraftId: source.id, expectedFromDocumentRevision: "legacy-viewed-v2" });
  assert.equal(source.status, "editing"); assert.equal(source.text, "legacy body");
});
test("I4 agent, finished and other-clip sources cannot use manual legacy derivation", () => {
  assert.throws(() => legacyDerivation(clip, legacy({ source: "agent" })), /未保存人工旧草稿/);
  assert.throws(() => legacyDerivation(clip, legacy({ status: "saved" })), /未保存人工旧草稿/);
  assert.throws(() => legacyDerivation(clip, legacy({ clipId: id(48) })), /未保存人工旧草稿/);
});
test("M1 drag commits only its starting frame, or cancels on frame change/deletion", () => {
  const before = clipEdit(clip), transform = { scale: 1.2, offsetX: 25, offsetY: -7, clip: false };
  const changed = finishFrameDrag(before, id(41), id(41), transform)!;
  assert.deepEqual(changed.frames[0]!.transform, transform);
  assert.equal(changed.frames[1]!.transform, undefined);
  assert.equal(finishFrameDrag(before, id(42), id(41), transform), null);
  assert.equal(finishFrameDrag({ ...before, frames: before.frames.slice(1) }, id(41), id(41), transform), null);
});

test("accepted delivery becoming stale does not reclaim manual editing without an active runtime", () => {
  const accepted = task({ phase: "delivery", status: "accepted", target: { clipId: clip.id, mode: "saved" }, acceptedSnapshotId: id(70), acceptanceHistory: [{ snapshotId: id(70), intentVersion: 2, createdAt: "now" }] });
  const idle = { id: accepted.sessionId!, status: "idle" as const };
  assert.equal(editingBlock([accepted], clip.id, {}, [idle]), undefined);
  const stale = { ...accepted, status: "blocked" as const, waitReason: "version_conflict" as const };
  assert.equal(editingBlock([stale], clip.id, {}, [idle]), undefined);
  assert.equal(editingBlock([{ ...stale, revision: stale.revision + 1 }], clip.id, {}, [idle]), undefined);
  assert.equal(editingBlock([{ ...stale, acceptedSnapshotId: undefined }], clip.id, {}, [idle]), undefined);
  assert.equal(editingBlock([stale], clip.id, {}, [{ ...idle, status: "running" }]), stale);
  assert.equal(editingBlock([stale], clip.id, {}, [{ ...idle, status: "starting" }]), stale);
  const unaccepted = { ...stale, acceptedSnapshotId: undefined, acceptanceHistory: [] };
  assert.equal(editingBlock([unaccepted], clip.id, {}, [idle]), unaccepted);
});

test("save-location is a machine action with frozen approval, not direction feedback or new save args", () => {
  const value = task({ attempts: [attempt] }), bound = session(value), before = structuredClone(value);
  assert.deepEqual(taskFeedbackPayload(value, "save-location", "save in another folder", bound), {
    expectedRevision: 7, action: "save-location", text: "save in another folder", toolApproval: { sessionId: id(3), approvalId: id(8) },
  });
  assert.deepEqual(value, before);
  assert.equal("feedbackKind" in taskFeedbackPayload(value, "save-location", "path", bound), false);
});
test("local feedback requires valid direction and sends explicit feedbackKind", () => {
  const value = task({ direction: { accept: true, intentVersion: 2, contentHash: "result-hash", createdAt: "now" } });
  assert.deepEqual(taskFeedbackPayload(value, "feedback", "offset only", undefined, "local"), { expectedRevision: 7, action: "feedback", text: "offset only", feedbackKind: "local" });
  const changedDirection = taskFeedbackPayload(value, "feedback", "new character", undefined, "direction");
  assert.ok("feedbackKind" in changedDirection); assert.equal(changedDirection.feedbackKind, "direction");
  assert.throws(() => taskFeedbackPayload(task(), "feedback", "local", undefined, "local"), /方向尚未认可/);
  assert.throws(() => taskFeedbackPayload({ ...value, intentVersion: 3 }, "feedback", "local", undefined, "local"), /方向尚未认可/);
});
