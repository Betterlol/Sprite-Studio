import { z } from "zod";
import { agentModelSchema, clipReferenceSchema, markdownReferenceSchema, type Session } from "../studio/model.ts";
import { editingContextSchema } from "../studio/workflow-model.ts";
import { api, ApiError } from "./api.ts";

const inputSchema = z.object({
  text: z.string(), assetIds: z.array(z.string()), clipReferences: z.array(clipReferenceSchema),
  markdownReferences: z.array(markdownReferenceSchema).max(3).optional(),
  context: editingContextSchema.optional(), taskId: z.string().optional(), feedbackKind: z.enum(["local", "direction"]).optional(),
  model: agentModelSchema, outputFolder: z.string(),
});
const recoverySchema = z.object({
  schemaVersion: z.literal(1), requestId: z.string(), projectId: z.string(), sessionId: z.string(),
  input: inputSchema, contextFrozen: z.boolean(), postStarted: z.boolean(),
  status: z.enum(["preparing", "sending", "failed", "unknown"]), error: z.string().optional(),
  createdAt: z.string(),
});
export type MessageInput = z.infer<typeof inputSchema>;
export type MessageRecovery = z.infer<typeof recoverySchema>;
export type RecoveryStore = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
export type ComposerInput = Pick<MessageInput, "text" | "assetIds" | "clipReferences"> & Partial<Omit<MessageInput, "text" | "assetIds" | "clipReferences">> & { recoverySourceId?: string };
const prefix = "studio.message-recovery.";
export const recoveryKey = (record: Pick<MessageRecovery, "projectId" | "sessionId" | "requestId">) =>
  `${prefix}${record.projectId}.${record.sessionId || "new"}.${record.requestId}`;

export function messageRecoveries(store: RecoveryStore, projectId: string, sessionId: string): MessageRecovery[] {
  const records: MessageRecovery[] = [];
  for (let index = 0; index < store.length; index++) {
    const key = store.key(index);
    if (!key?.startsWith(prefix)) continue;
    try {
      const parsed = recoverySchema.safeParse(JSON.parse(store.getItem(key) || "null"));
      if (parsed.success && parsed.data.projectId === projectId && parsed.data.sessionId === sessionId) records.push(parsed.data);
    } catch { /* Unrelated or invalid local records are not deleted. */ }
  }
  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
export function dismissMessageRecovery(store: RecoveryStore, record: MessageRecovery) {
  store.removeItem(recoveryKey(record));
}
export function sameMessageInput(left: MessageInput, right: MessageInput) {
  return JSON.stringify(inputSchema.parse(left)) === JSON.stringify(inputSchema.parse(right));
}
function contextScope(context: MessageInput["context"]) {
  return context ? [context.mode,context.clipId,context.assetId,context.snapshotId,context.frameId,context.startFrameId,context.endFrameId,context.draftId,context.mode === "saved" ? context.revision : undefined] : null;
}
export function clearSubmittedComposer(current: ComposerInput, submitted: ComposerInput): ComposerInput {
  if (current.text !== submitted.text || JSON.stringify(current.assetIds) !== JSON.stringify(submitted.assetIds) ||
    JSON.stringify(current.clipReferences) !== JSON.stringify(submitted.clipReferences) || JSON.stringify(current.markdownReferences || []) !== JSON.stringify(submitted.markdownReferences || [])) return current;
  for (const key of ["taskId", "model", "outputFolder", "feedbackKind", "recoverySourceId"] as const) if (key in current && current[key] !== submitted[key]) return current;
  // A draft's ack revision can advance automatically; a new target/instance or explicit intent cannot.
  if ("context" in current && JSON.stringify(contextScope(current.context)) !== JSON.stringify(contextScope(submitted.context))) return current;
  return { text: "", assetIds: [], clipReferences: [], ...("markdownReferences" in current ? { markdownReferences: [] } : {}) };
}
/** Explicit local restoration only. New input is never replaced or automatically submitted. */
export function restoreMessageInput(record: MessageRecovery, current: ComposerInput): MessageInput | null {
  if (current.text.length || current.assetIds.length || current.clipReferences.length || current.markdownReferences?.length || current.feedbackKind) return null;
  return structuredClone(record.input);
}
export function messageRecoveryNotice(record: MessageRecovery) {
  if (record.status === "failed" && !record.postStarted) return "消息接口尚未提交，完整输入已保留；恢复只回填草稿，不会自动发送。";
  if (record.status === "failed") return "消息接口拒绝了请求，完整输入已保留；恢复只回填草稿，不会自动发送。";
  return "发送结果尚未确认，可能已经发送。完整输入已保留；恢复只回填草稿，不会自动重发。";
}

export class MessageAttemptError extends Error {
  recovery: MessageRecovery;
  constructor(recovery: MessageRecovery, cause: unknown) {
    super(recovery.error || "消息结果未确认", { cause });
    this.name = "MessageAttemptError"; this.recovery = recovery;
  }
}

export function postMessageInput(record: MessageRecovery): Promise<Session> {
  return api<Session>(`/api/sessions/${record.sessionId}/messages`, {
    method: "POST", body: JSON.stringify({ ...record.input, text: record.input.text.trim(), requestId: record.requestId }),
  });
}

/** One user-initiated attempt, not a queue: persist before clearing, invoke POST once, never retry. */
export async function sendMessageAttempt<T>({ store, projectId, sessionId, requestId, input, prepare, onPrepared, send, onChange, recoveredFrom, initialContextFrozen = false }: {
  store: RecoveryStore; projectId: string; sessionId: string; requestId: string; input: MessageInput;
  prepare: () => Promise<{ sessionId: string; input: MessageInput }>;
  onPrepared: (record: MessageRecovery) => void;
  send: (record: MessageRecovery) => Promise<T>;
  onChange?: () => void; recoveredFrom?: MessageRecovery; initialContextFrozen?: boolean;
}): Promise<T> {
  let record: MessageRecovery = { schemaVersion: 1, projectId, sessionId, requestId, input: structuredClone(input), contextFrozen: initialContextFrozen, postStarted: false, status: "preparing", createdAt: new Date().toISOString() };
  // Failure here leaves the composer intact: onPrepared has not run and no POST was made.
  store.setItem(recoveryKey(record), JSON.stringify(record));
  onChange?.();
  try {
    const prepared = await prepare();
    const oldKey = recoveryKey(record);
    record = { ...record, sessionId: prepared.sessionId, input: structuredClone(prepared.input), contextFrozen: true, status: "sending" };
    store.setItem(recoveryKey(record), JSON.stringify(record));
    if (oldKey !== recoveryKey(record)) store.removeItem(oldKey);
    onPrepared(record);
    const posting = { ...record, postStarted: true };
    store.setItem(recoveryKey(posting), JSON.stringify(posting));
    record = posting;
    onChange?.();
    const result = await send(record);
    // Acknowledged POST success is not changed into an unknown send by local cleanup errors.
    try {
      dismissMessageRecovery(store, record);
      if (recoveredFrom && recoveredFrom.projectId === projectId && (recoveredFrom.sessionId === record.sessionId || (!sessionId && !recoveredFrom.sessionId)) && sameMessageInput(recoveredFrom.input, record.input)) dismissMessageRecovery(store, recoveredFrom);
    } catch { /* A retained slot remains conservative; never submit another POST here. */ }
    onChange?.();
    return result;
  } catch (error) {
    const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500;
    record = { ...record, status: !record.postStarted || rejected ? "failed" : "unknown", error: error instanceof Error ? error.message : String(error) };
    // The previously persisted full input remains even if a later storage update fails.
    try { store.setItem(recoveryKey(record), JSON.stringify(record)); } catch { /* Existing pending record still means unconfirmed, never safe to retry automatically. */ }
    onChange?.();
    throw new MessageAttemptError(record, error);
  }
}
