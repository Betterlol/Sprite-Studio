import { useState } from "react";
import { X, Film, LoaderCircle } from "lucide-react";
import { categoryFolder, type Asset, type ClipAsset } from "../studio/model.ts";
import { api } from "./api.ts";
export function NewClipDialog({
  projectId,
  folder,
  onClose,
  onCreated,
}: {
  projectId: string;
  folder: string;
  assets?: Asset[];
  initialImageId?: string;
  onClose: () => void;
  onCreated: (clip: ClipAsset) => Promise<void>;
}) {
  const [name, setName] = useState("新动画"),
    [fps, setFps] = useState(12),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="新建动画"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          void api<ClipAsset>(`/api/projects/${projectId}/clips`, {
            method: "POST",
            body: JSON.stringify({
              name,
              fps,
              folder: categoryFolder("动画", folder).slice(3),
              requestId,
            }),
          })
            .then(onCreated)
            .catch((e) => {
              setError(e.message);
              setBusy(false);
            });
        }}
      >
        <div className="modal-heading">
          <h2>新建动画</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭新建动画"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <p>
          创建后从素材库添加图片，拖动帧调整顺序；需要时再选择区间补帧或检查。
        </p>
        <p>保存到：{categoryFolder("动画", folder)}</p>
        <label>
          动画名称
          <input
            autoFocus
            aria-label="新动画名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
          />
        </label>
        <label>
          初始帧率
          <input
            aria-label="新动画初始帧率"
            type="number"
            min="1"
            max="60"
            value={fps}
            onChange={(e) => setFps(Number(e.target.value))}
            required
          />
        </label>
        {error && (
          <p role="alert" className="interpolation-warning">
            {error}
          </p>
        )}
        <button
          className="primary"
          type="submit"
          disabled={busy || !name.trim() || fps < 1 || fps > 60}
        >
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Film size={15} />
          )}
          创建动画
        </button>
      </form>
    </div>
  );
}
