import { useState } from "react";
import { X, Film, LoaderCircle } from "lucide-react";
import {
  assetUrl,
  categoryFolder,
  type Asset,
  type ImageAsset,
  type ClipAsset,
} from "../studio/model.ts";
import { api } from "./api.ts";
export function NewClipDialog({
  projectId,
  assets,
  initialImageId,
  folder,
  onClose,
  onCreated,
}: {
  projectId: string;
  assets: Asset[];
  initialImageId?: string;
  folder: string;
  onClose: () => void;
  onCreated: (clip: ClipAsset) => Promise<void>;
}) {
  const images = assets.filter(
    (asset): asset is ImageAsset =>
      asset.type === "image" && asset.frameCount === 1,
  );
  const initial =
    images.find((image) => image.id === initialImageId) || images[0]!;
  const [first, setFirst] = useState(initial.id),
    [last, setLast] = useState(
      images.find(
        (image) =>
          image.id !== initial.id &&
          image.width === initial.width &&
          image.height === initial.height,
      )?.id || "",
    );
  const [name, setName] = useState("新动画"),
    [fps, setFps] = useState(8),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const source = images.find((image) => image.id === first)!;
  const matching = images.filter(
    (image) => image.width === source.width && image.height === source.height,
  );
  const picker = (
    label: string,
    value: string,
    onChange: (id: string) => void,
    options: ImageAsset[],
  ) => (
    <label>
      {label}
      <div className="clip-picker">
        {value && <img src={assetUrl(projectId, value)} alt={label} />}
        <select
          required
          aria-label={`新动画${label}`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="" disabled>
            选择图片
          </option>
          {options.map((image) => (
            <option key={image.id} value={image.id}>
              {image.name} · {image.width} × {image.height}
            </option>
          ))}
        </select>
      </div>
    </label>
  );
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="modal"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          void api<ClipAsset>(`/api/projects/${projectId}/clips`, {
            method: "POST",
            body: JSON.stringify({
              name,
              imageIds: [first, last],
              fps,
              folder,
            }),
          })
            .then(onCreated)
            .catch((error) => {
              setError(error.message);
              setBusy(false);
            });
        }}
      >
        <div className="modal-heading">
          <h2>从首尾图片创建动画</h2>
          <button
            className="icon-button"
            aria-label="关闭新建动画"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <p>选择相同画布的两张静态图片，创建后可在“首尾补帧”中生成过渡。</p>
        <p>保存到：{categoryFolder("动画", folder)}</p>
        <label>
          动画名称
          <input
            aria-label="新动画名称"
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {picker(
          "首帧",
          first,
          (id) => {
            setFirst(id);
            const image = images.find((image) => image.id === id);
            setLast(
              images.find(
                (other) =>
                  other.id !== id &&
                  other.width === image?.width &&
                  other.height === image?.height,
              )?.id || "",
            );
          },
          images,
        )}
        {picker("尾帧", last, setLast, matching)}
        <label>
          初始帧率
          <input
            aria-label="新动画初始帧率"
            type="number"
            min="1"
            max="60"
            value={fps}
            onChange={(event) =>
              setFps(Math.max(1, Math.min(60, Number(event.target.value))))
            }
          />
        </label>
        {error && (
          <p className="interpolation-warning" role="alert">
            {error}
          </p>
        )}
        <button
          className="primary"
          type="submit"
          disabled={busy || !first || !last || !name.trim()}
        >
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Film size={15} />
          )}
          创建动画并补帧
        </button>
      </form>
    </div>
  );
}
