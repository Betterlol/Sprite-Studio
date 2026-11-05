import { useState } from "react";
import { api } from "./api.ts";
import type { Session } from "../studio/model.ts";
export function ToolApprovals({
  sessions,
  onRefresh,
}: {
  sessions: Session[];
  onRefresh: () => Promise<void>;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  async function decide(s: Session, accept: boolean) {
    const a = s.toolApproval!;
    setBusy(a.id);
    setError("");
    try {
      await api(`/api/sessions/${s.id}/tool-approval`, {
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
        .filter((s) => s.toolApproval)
        .map((s) => {
          const a = s.toolApproval!;
          return (
            <section
              className="frame-save-card"
              key={a.id}
              aria-label="工具审批"
            >
              <strong>等待审批 · {a.label}</strong>
              <small>{s.title} · 助手正在等待你的决定，操作尚未执行。</small>
              {a.tool === "save_image" &&
                typeof a.arguments.generatedId === "string" && (
                  <img
                    className="approval-image"
                    src={`/api/projects/${s.projectId}/generated/${a.arguments.generatedId}/image`}
                    alt="此次请求保存的生成图片"
                  />
                )}
              {a.tool === "save_image" && (
                <p>
                  保存到：
                  {a.arguments.type === "reference" ? "参考图" : "原图素材"}/
                  {a.arguments.folder && a.arguments.folder !== "."
                    ? String(a.arguments.folder) + "/"
                    : ""}
                  {String(a.arguments.name || "")}
                </p>
              )}
              <details>
                <summary>查看此次操作的完整参数</summary>
                <pre>{JSON.stringify(a.arguments, null, 2)}</pre>
              </details>
              <label>
                拒绝理由（可选）
                <textarea
                  aria-label="工具审批拒绝理由"
                  maxLength={2000}
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
                  Accept · 允许执行
                </button>
                <button
                  className="secondary"
                  disabled={!!busy}
                  onClick={() => void decide(s, false)}
                >
                  Deny · 返回理由
                </button>
              </div>
            </section>
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
