import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import type { AnimationApprovalPreview, Session, ToolApproval } from "../studio/model.ts";
import { AnimationAcceptanceDialog } from "./AnimationAcceptanceDialog.tsx";

type ApprovalRequest = {
  id: string;
  session: Session;
  tool?: ToolApproval;
  frame: boolean;
  label: string;
  animations: AnimationApprovalPreview[];
};
export function ToolApprovals({ sessions, onRefresh }: { sessions: Session[]; onRefresh: () => Promise<void> }) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState("");
  const seen = useRef(new Set<string>());
  const requests: ApprovalRequest[] = sessions.flatMap(session => {
    const list: ApprovalRequest[] = [];
    const tool = session.toolApproval, frame = session.frameSaveApproval;
    if (tool) list.push({ id: tool.id, session, tool, frame: false, label: tool.label, animations: tool.animations || [] });
    if (frame) list.push({ id: frame.id, session, frame: true, label: "保存动画帧调整", animations: [{
      clipId: frame.clipId || "", clipName: frame.clipName,
      beforeSnapshotId: frame.beforeSnapshotId, previewSnapshotId: frame.previewSnapshotId,
      draftId: frame.draftId, documentRevision: frame.documentRevision, warnings: [],
    }] });
    return list;
  });
  useEffect(() => {
    if (openId && requests.some(request => request.id === openId)) return;
    const next = requests.find(request => request.animations.length && !seen.current.has(request.id));
    if (next) { seen.current.add(next.id); setOpenId(next.id); setError(""); }
    else if (openId) setOpenId("");
  }, [sessions, openId]);
  const opened = requests.find(request => request.id === openId);
  async function decide(request: ApprovalRequest, accept: boolean) {
    setBusy(request.id); setError("");
    try {
      await api(`/api/sessions/${request.session.id}/${request.frame ? "frame-save" : "tool-approval"}`, {
        method: "POST", body: JSON.stringify({ approvalId: request.id, accept, reason: reasons[request.id] || "" }),
      });
      setOpenId("");
      await onRefresh();
    } catch (error: any) {
      setError(error.message);
      // An expired candidate is released by the server, not left waiting forever.
      await onRefresh().catch(() => {});
    } finally { setBusy(""); }
  }
  return <div className="frame-save-approvals">
    {requests.map(request => {
      const a = request.tool, animation = request.animations.length > 0;
      return <section className="frame-save-card" key={request.id} aria-label={animation ? "动画验收请求" : "工具审批"}>
        <strong>{animation ? "等待动画播放验收" : `等待审批 · ${request.label}`}</strong>
        <small>{request.session.title} · 助手等待你的决定，{animation ? "候选尚未应用。" : "操作尚未执行。"}</small>
        {animation ? <>
          <p>{request.animations.map(item => item.clipName).join("、")}</p>
          <button className="primary" disabled={!!busy} onClick={() => { setOpenId(request.id); setError(""); }}>打开播放验收</button>
        </> : a && <>
          {a.tool === "save_image" && typeof a.arguments.generatedId === "string" && <img className="approval-image" src={`/api/projects/${request.session.projectId}/generated/${a.arguments.generatedId}/image`} alt="此次请求保存的生成图片" />}
          {a.tool === "save_image" && <p>保存到：{a.arguments.type === "reference" ? "参考图" : "原图素材"}/{a.arguments.folder && a.arguments.folder !== "." ? String(a.arguments.folder) + "/" : ""}{String(a.arguments.name || "")}<br /><small>允许图片入库不代表接受后续动画效果。</small></p>}
          <details><summary>查看此次操作的完整参数</summary><pre>{JSON.stringify(a.arguments, null, 2)}</pre></details>
          <label>意见（可选，接受和拒绝都会回传）<textarea aria-label="工具审批反馈意见" maxLength={2000} value={reasons[request.id] || ""} onChange={event => setReasons({ ...reasons, [request.id]: event.target.value })} /></label>
          <div className="frame-draft-actions"><button className="primary" disabled={!!busy} onClick={() => void decide(request, true)}>Approve · 允许执行</button><button className="secondary" disabled={!!busy} onClick={() => void decide(request, false)}>Deny · 返回意见</button></div>
        </>}
      </section>;
    })}
    {opened && <AnimationAcceptanceDialog key={opened.id} id={opened.id} projectId={opened.session.projectId} title={opened.session.title}
      animations={opened.animations} parameters={opened.tool?.arguments || (opened.session.frameSaveApproval ? { draftId: opened.session.frameSaveApproval.draftId, documentRevision: opened.session.frameSaveApproval.documentRevision, frameChanges: opened.session.frameSaveApproval.frameChanges } : undefined)} feedback={reasons[opened.id] || ""} onFeedback={text => setReasons({ ...reasons, [opened.id]: text })}
      busy={!!busy} error={error} onDecide={accept => void decide(opened, accept)} onClose={() => setOpenId("")} />}
    {error && !opened && <p role="alert" className="interpolation-warning">{error}</p>}
  </div>;
}
