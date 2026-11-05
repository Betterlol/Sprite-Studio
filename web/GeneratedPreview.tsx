import { useState } from "react";
import type { GeneratedImageInfo } from "../studio/generated.ts";
import type { ImageAsset } from "../studio/model.ts";
import { api } from "./api.ts";
export function GeneratedPreview({
  projectId,
  image,
  onSaved,
}: {
  projectId: string;
  image: GeneratedImageInfo;
  onSaved: (asset: ImageAsset) => Promise<void>;
}) {
  const [name, setName] = useState("生成图.png"),
    [folder, setFolder] = useState(""),
    [type, setType] = useState<"reference" | "resource">("resource"),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  if (image.assetIds.length) return null;
  return (
    <div className="generated-preview">
      <img
        src={`/api/projects/${projectId}/generated/${image.id}/image`}
        alt="生成图片（尚未保存为项目资源）"
      />
      <span>生成图片 · 尚未保存</span>
      <button className="secondary" onClick={() => setOpen(!open)}>
        保存到项目…
      </button>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            void api<ImageAsset>(`/api/projects/${projectId}/generated/save`, {
              method: "POST",
              body: JSON.stringify({
                generatedId: image.id,
                type,
                name,
                folder,
                requestId,
              }),
            })
              .then(onSaved)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            分类
            <select
              aria-label="保存图片分类"
              value={type}
              onChange={(e) => {
                setType(e.target.value as typeof type);
                setRequestId(crypto.randomUUID());
              }}
            >
              <option value="resource">原图素材</option>
              <option value="reference">参考图</option>
            </select>
          </label>
          <label>
            文件名
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setRequestId(crypto.randomUUID());
              }}
              required
            />
          </label>
          <label>
            分类内目录
            <input
              value={folder}
              placeholder="留空或 . 保存到分类根目录"
              onChange={(e) => {
                setFolder(e.target.value);
                setRequestId(crypto.randomUUID());
              }}
            />
          </label>
          <button
            className="primary"
            disabled={busy || !name.trim()}
            type="submit"
          >
            {busy ? "保存中…" : "保存图片"}
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </div>
  );
}
