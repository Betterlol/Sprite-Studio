import test from "node:test";
import assert from "node:assert/strict";
import { clearSubmittedComposer, restoreMessageInput, sendMessageAttempt, messageRecoveries, type MessageInput, type RecoveryStore } from "./message-recovery.ts";
import { defaultAgentModel } from "../studio/model.ts";
const id = "00000000-0000-4000-8000-000000000001";
class Storage implements RecoveryStore {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] || null; }
  getItem(key: string) { return this.values.get(key) || null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const input = (): MessageInput => ({ text: "只规划", assetIds: [], clipReferences: [], markdownReferences: [{ id, revision: "v1" }], model: defaultAgentModel, outputFolder: "文档" });

test("Markdown references survive failed send and explicit restore, without replacing newer document choices", async () => {
  const store = new Storage(), original = input();
  await assert.rejects(sendMessageAttempt({ store, projectId: id, sessionId: id, requestId: id, input: original,
    prepare: async () => ({ sessionId: id, input: original }), onPrepared: () => {}, send: async () => { throw new Error("network failure"); },
  }));
  const record = messageRecoveries(store, id, id)[0]!;
  assert.deepEqual(record.input.markdownReferences, original.markdownReferences);
  assert.deepEqual(restoreMessageInput(record, { text: "", assetIds: [], clipReferences: [] }), original);
  assert.equal(restoreMessageInput(record, { text: "", assetIds: [], clipReferences: [], markdownReferences: [{ id, revision: "new" }] }), null);
  const newer = { ...original, markdownReferences: [{ id, revision: "new" }] };
  assert.equal(clearSubmittedComposer(newer, original), newer);
  assert.deepEqual(clearSubmittedComposer(original, original), { text: "", assetIds: [], clipReferences: [], markdownReferences: [] });
});

test("legacy message recoveries without Markdown fields remain compatible", async () => {
  const original = input(); delete original.markdownReferences;
  assert.deepEqual(clearSubmittedComposer(original, original), { text: "", assetIds: [], clipReferences: [] });
});
