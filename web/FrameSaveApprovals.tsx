import { useEffect, useState } from "react";
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
  const [policy, setPolicy] = useState("ask");
  useEffect(() => {
    void api<{ save_frame_draft: string }>("/api/tool-permissions")
      .then((v) => setPolicy(v.save_frame_draft))
      .catch((e) => setError(e.message));
  }, []);
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
              <strong>助手请求保存单帧配置</strong>
              <p>
                {a.clipName} · 第 {a.frameNumber} 帧
              </p>
              <small>
                缩放 {(a.before.transform?.scale || 1) * 100}% →{" "}
                {(a.after.transform?.scale || 1) * 100}%<br />
                位移 ({a.before.transform?.offsetX || 0},{" "}
                {a.before.transform?.offsetY || 0}) → (
                {a.after.transform?.offsetX || 0},{" "}
                {a.after.transform?.offsetY || 0})<br />
                时长 {a.before.durationUs / 1000} → {a.after.durationUs / 1000}{" "}
                ms · 裁切 {a.before.transform?.clip ? "允许" : "禁止"} →{" "}
                {a.after.transform?.clip ? "允许" : "禁止"}
              </small>
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
                  aria-label="单帧保存拒绝理由"
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
              <small>审批仅应用这份草稿；原图和其他帧不变。</small>
            </div>
          );
        })}
      <details className="frame-permissions">
        <summary>助手单帧保存权限</summary>
        <label>
          保存配置时
          <select
            aria-label="助手单帧保存权限"
            value={policy}
            onChange={(e) => {
              const next = e.target.value;
              void api<{ save_frame_draft: string }>("/api/tool-permissions", {
                method: "PUT",
                body: JSON.stringify({ save_frame_draft: next }),
              })
                .then((v) => setPolicy(v.save_frame_draft))
                .catch((e) => setError(e.message));
            }}
          >
            <option value="ask">每次审批</option>
            <option value="allow">允许直接保存</option>
            <option value="deny">禁止保存</option>
          </select>
        </label>
        <small>适用于之后发起的保存请求，当前待审批请求仍需处理。</small>
      </details>
      {error && (
        <p role="alert" className="interpolation-warning">
          {error}
        </p>
      )}
    </div>
  );
}
