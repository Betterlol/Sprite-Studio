import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api } from "./api.ts";
import type {
  PermissionPolicy,
  ToolPolicies,
} from "../studio/tool-permissions.ts";

type Settings = {
  policies: ToolPolicies;
  tools: {
    name: keyof ToolPolicies;
    label: string;
    detail: string;
    writes: boolean;
  }[];
};
export function PermissionSettings({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<Settings | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    void api<Settings>("/api/tool-permissions")
      .then(setSettings)
      .catch((e) => setError(e.message));
  }, []);
  async function save(name: keyof ToolPolicies, policy: PermissionPolicy) {
    setBusy(true);
    setError("");
    try {
      setSettings(
        await api<Settings>("/api/tool-permissions", {
          method: "PUT",
          body: JSON.stringify({ [name]: policy }),
        }),
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="permission-dialog"
      aria-labelledby="permission-title"
      onCancel={onClose}
    >
      <header>
        <h2 id="permission-title">助手工具权限</h2>
        <button
          className="icon-button"
          aria-label="关闭权限设置"
          onClick={onClose}
          autoFocus
        >
          <X size={18} />
        </button>
      </header>
      <p>
        适用于所有工程的助手项目工具；网页手动操作直接执行。更改即时保存，当前待审批请求仍需处理。
      </p>
      <p>
        默认图片入库和动画保存需要审批，其余直接执行。已有显式设置不自动改写。
        动画 ask 会展示可播放候选；allow 只表示免确认保存，不表示你已验收。
      </p>
      {settings && <button className="secondary" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try { setSettings(await api<Settings>("/api/tool-permissions", { method: "PUT", body: JSON.stringify({ save_frame_draft: "ask", save_clip_draft: "ask" }) })); }
        catch (error: any) { setError(error.message); }
        finally { setBusy(false); }
      }}>启用动画播放验收</button>}
      {!settings && !error && <p role="status">读取设置…</p>}
      {settings &&
        [true, false].map((writes) => (
          <section key={String(writes)}>
            <h3>{writes ? "资源与配置操作" : "读取与预览"}</h3>
            {settings.tools
              .filter((t) => t.writes === writes)
              .map((t) => (
                <label className="permission-row" key={t.name}>
                  <span>
                    <strong>{t.label}</strong>
                    <small>{t.detail}</small>
                    <code>{t.name}</code>
                  </span>
                  <select
                    aria-label={t.label + "权限"}
                    value={settings.policies[t.name]}
                    disabled={busy}
                    onChange={(e) =>
                      void save(t.name, e.target.value as PermissionPolicy)
                    }
                  >
                    <option value="allow">Full access · 直接执行</option>
                    <option value="ask">Ask for approval · 每次审批</option>
                    <option value="deny">Deny · 禁止</option>
                  </select>
                </label>
              ))}
          </section>
        ))}
      {error && (
        <p role="alert" className="interpolation-warning">
          {error}
        </p>
      )}
    </dialog>
  );
}
