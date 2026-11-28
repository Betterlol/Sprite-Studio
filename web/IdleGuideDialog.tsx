import { useMemo, useState } from "react";
import { Images, LoaderCircle, X } from "lucide-react";
import { assetUrl, type Asset, type IdleGuide } from "../studio/model.ts";
import { api } from "./api.ts";
import { resolveIdleGuide } from "./idle-guide.ts";

/**
 * Configuration page for the character-level IDLE baseline. Reached from the
 * IDLE overlay toggle whenever the current guide is missing or unreachable.
 */
export function IdleGuideDialog({
  projectId,
  assets,
  guide,
  onClose,
  onSaved,
}: {
  projectId: string;
  assets: Asset[];
  guide?: IdleGuide;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const clips = useMemo(
      () => assets.filter((asset) => asset.type === "clip" && asset.frames.length > 0),
      [assets],
    ),
    images = useMemo(
      () => assets.filter((asset) => asset.type === "image" && asset.frameCount === 1),
      [assets],
    );
  const [kind, setKind] = useState<IdleGuide["kind"]>(
    guide?.kind ?? (clips.length ? "clip" : "image"),
  );
  const [assetId, setAssetId] = useState(guide?.assetId ?? "");
  const [opacity, setOpacity] = useState(Math.round((guide?.opacity ?? 0.22) * 100));
  const [busy, setBusy] = useState<"" | "save" | "clear">("");
  const [error, setError] = useState("");
  const options = kind === "clip" ? clips : images;
  const selectedId = options.some((option) => option.id === assetId)
    ? assetId
    : (options[0]?.id ?? "");
  const preview = resolveIdleGuide(
    selectedId ? { kind, assetId: selectedId, opacity: opacity / 100 } : undefined,
    assets,
  );
  const previewImage = preview
    ? assets.find((asset) => asset.id === preview.imageId)
    : undefined;
  async function submit(action: "save" | "clear") {
    setBusy(action);
    setError("");
    try {
      await api(`/api/projects/${projectId}/idle`, {
        method: action === "save" ? "PUT" : "DELETE",
        ...(action === "save"
          ? {
              body: JSON.stringify({
                kind,
                assetId: selectedId,
                opacity: opacity / 100,
              }),
            }
          : {}),
      });
      await onSaved();
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy("");
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="IDLE 基准图配置"
        onSubmit={(event) => {
          event.preventDefault();
          if (selectedId) void submit("save");
        }}
      >
        <div className="modal-heading">
          <h2>IDLE 基准图</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭 IDLE 基准图配置"
            disabled={!!busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <p>
          基准图只在画布上作为半透明叠图，用来对照比例和位置；不进入帧、检查图或导出。
        </p>
        {!clips.length && !images.length ? (
          <p role="status" className="adjust-note">
            素材库还没有可用的动画或静态图片。先导入、切割或建立一个动画，再来配置。
          </p>
        ) : (
          <>
            <label>
              基准来源
              <select
                aria-label="IDLE 基准来源类型"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as IdleGuide["kind"]);
                  setAssetId("");
                }}
              >
                <option value="clip" disabled={!clips.length}>
                  动画首帧（推荐）
                </option>
                <option value="image" disabled={!images.length}>
                  单张静态图片
                </option>
              </select>
            </label>
            <label>
              {kind === "clip" ? "选择 IDLE 动画" : "选择静态图片"}
              <select
                aria-label="IDLE 基准图对象"
                value={selectedId}
                onChange={(event) => setAssetId(event.target.value)}
                required
              >
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                    {option.type === "clip" ? `（${option.frames.length} 帧）` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              叠图透明度 {opacity}%
              <input
                aria-label="IDLE 叠图透明度"
                type="range"
                min="5"
                max="100"
                step="1"
                value={opacity}
                onChange={(event) => setOpacity(Number(event.target.value))}
              />
            </label>
            {previewImage?.type === "image" && (
              <div className="idle-guide-preview">
                <img
                  src={assetUrl(projectId, previewImage.id, previewImage.revision)}
                  alt={`IDLE 基准图预览：${previewImage.name}`}
                  style={{ opacity: opacity / 100 }}
                />
                <small>
                  {preview?.label} · {previewImage.width} × {previewImage.height}
                  {kind === "clip" ? "（动画首帧）" : ""}
                </small>
              </div>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="interpolation-warning">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            className="primary"
            type="submit"
            disabled={!!busy || !selectedId}
          >
            {busy === "save" ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Images size={15} />
            )}
            保存基准图
          </button>
          {guide && (
            <button
              type="button"
              className="secondary"
              disabled={!!busy}
              onClick={() => void submit("clear")}
            >
              清除基准图
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
