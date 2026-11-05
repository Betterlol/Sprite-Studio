import { useState } from "react";
import { api } from "./api.ts";
import type { Session } from "../studio/model.ts";
import type { FramePreview } from "./FrameAdjustmentPanel.tsx";

export function FrameSaveApprovals({
  sessions,
  onCompare,
  onRefresh,
}: {
  sessions: Session[];
  onCompare: (v: FramePreview) => void;
  onRefresh: () => Promise<void>;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  async function decide(session: Session, accept: boolean) {
    const a = session.frameSaveApproval!;
    setBusy(a.id);
    setError("");
    try {
      await api(`/api/sessions/${session.id}/frame-save`, {
        method: "POST",
        body: JSON.stringify({
          approvalId: a.id,
          accept,
          reason: reasons[a.id] || "",
        }),
      });
      await onRefresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="frame-save-approvals">
      {sessions
        .filter((s) => s.frameSaveApproval)
        .map((s) => {
          const a = s.frameSaveApproval!;
          return (
            <div className="frame-save-card" key={a.id}>
              <strong>助手请求保存动画帧调整</strong>
              <p>
                {a.clipName} · {a.frameChanges?.length || 1} 帧修改
              </p>
              {(
                a.frameChanges || [
                  {
                    frameId: a.draftId,
                    frameNumber: a.frameNumber,
                    before: a.before,
                    after: a.after,
                  },
                ]
              ).map((f) => (
                <small key={f.frameId}>
                  第 {f.frameNumber} 帧：缩放{" "}
                  {(f.before.transform?.scale || 1) * 100}% →{" "}
                  {(f.after.transform?.scale || 1) * 100}%<br />
                  位移 ({f.before.transform?.offsetX || 0},{" "}
                  {f.before.transform?.offsetY || 0}) → (
                  {f.after.transform?.offsetX || 0},{" "}
                  {f.after.transform?.offsetY || 0})<br />
                  时长 {f.before.durationUs / 1000} →{" "}
                  {f.after.durationUs / 1000} ms · 裁切{" "}
                  {f.before.transform?.clip ? "允许" : "禁止"} →{" "}
                  {f.after.transform?.clip ? "允许" : "禁止"}
                </small>
              ))}
              <button
                className="secondary"
                disabled={!!busy}
                onClick={() =>
                  void api<FramePreview>(
                    `/api/projects/${s.projectId}/frame-drafts/${a.draftId}/preview`,
                    {
                      method: "POST",
                      body: JSON.stringify({
                        documentRevision: a.documentRevision,
                      }),
                    },
                  )
                    .then(onCompare)
                    .catch((e) => setError(e.message))
                }
              >
                查看修改与播放对比
              </button>
              <label>
                拒绝理由（可选）
                <textarea
                  aria-label="帧调整保存拒绝理由"
                  value={reasons[a.id] || ""}
                  onChange={(e) =>
                    setReasons({ ...reasons, [a.id]: e.target.value })
                  }
                />
              </label>
              <div className="frame-draft-actions">
                <button
                  className="primary"
                  disabled={!!busy}
                  onClick={() => void decide(s, true)}
                >
                  Accept · 应用保存
                </button>
                <button
                  className="secondary"
                  disabled={!!busy}
                  onClick={() => void decide(s, false)}
                >
                  Deny · 返回修改
                </button>
              </div>
              <small>
                一次保存这份草稿中的全部帧调整；原图和未修改帧不变。
              </small>
            </div>
          );
        })}
      {error && (
        <p role="alert" className="interpolation-warning">
          {error}
        </p>
      )}
    </div>
  );
}
