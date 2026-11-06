import { messageRecoveryNotice, type MessageRecovery } from "./message-recovery.ts";

export function MessageRecoveries({ records, activeRequestId, composerHasInput, onRestore, onDismiss }: {
  records: MessageRecovery[]; activeRequestId: string; composerHasInput: boolean;
  onRestore: (record: MessageRecovery) => void; onDismiss: (record: MessageRecovery) => void;
}) {
  if (!records.length) return null;
  return <details className="message-recoveries" open>
    <summary>此会话有 {records.length} 条消息输入恢复记录</summary>
    {records.map(record => <section key={record.requestId} aria-label="原会话消息恢复">
      <p role="status">{messageRecoveryNotice(record)}</p>
      <small>请求 {record.requestId} · {record.status} · {new Date(record.createdAt).toLocaleString()}</small>
      {record.error && <p className="interpolation-warning">{record.error}</p>}
      <label>原消息（只读，可复制）<textarea readOnly aria-label={`恢复消息 ${record.requestId.slice(0, 8)}`} value={record.input.text}/></label>
      <details><summary>原图片/动画引用与明确上下文</summary><pre>{JSON.stringify({
        assetIds: record.input.assetIds, clipReferences: record.input.clipReferences,
        context: record.input.context || null, contextFrozen: record.contextFrozen,
        taskId: record.input.taskId || null, feedbackKind: record.input.feedbackKind || null, model: record.input.model, outputFolder: record.input.outputFolder,
      }, null, 2)}</pre></details>
      <div className="task-actions">
        <button className="secondary" disabled={activeRequestId === record.requestId || composerHasInput} onClick={() => onRestore(record)}>恢复为草稿（不发送）</button>
        <button disabled={activeRequestId === record.requestId} onClick={() => onDismiss(record)}>移除恢复记录</button>
      </div>
      {composerHasInput && <small>当前已有输入，不会覆盖；此恢复记录仍保留，可先复制或处理当前草稿。</small>}
    </section>)}
  </details>;
}
