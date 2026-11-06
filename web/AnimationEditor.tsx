import { useState, type DragEvent } from "react";
import {
  Film,
  Play,
  Pause,
  Plus,
  Trash2,
  Copy,
  Undo2,
  Redo2,
} from "lucide-react";
import {
  assetUrl,
  snapshotFrameUrl,
  type ClipSnapshot,
  type Asset,
  type ClipAsset,
  type ImageAsset,
} from "../studio/model.ts";

export function AnimationEditor({
  projectId,
  previewSnapshot,
  clip,
  assets,
  frameIndex,
  playing,
  onFrame,
  onPlaying,
  onChange,
  onUndo, onRedo, canUndo, canRedo,
  onTool,
  disabled,
}: {
  projectId: string;
  previewSnapshot?: ClipSnapshot;
  clip: ClipAsset;
  assets: Asset[];
  frameIndex: number;
  playing: boolean;
  onFrame: (index: number) => void;
  onPlaying: (value: boolean) => void;
  onChange: (clip: ClipAsset) => void;
  onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean;
  onTool: (tool: "interpolate" | "review") => void;
  disabled: boolean;
}) {
  const busy = false;
  const [error, setError] = useState(""), [picked, setPicked] = useState<string[]>([]), [search, setSearch] = useState("");
  const images = assets.filter(
    (asset): asset is ImageAsset =>
      asset.type === "image" && asset.frameCount === 1,
  );
  const current = clip.frames[frameIndex];
  function commit(next: ClipAsset, selectedId?: string) {
    if (disabled) return;
    setError("");
    onPlaying(false);
    try {
      onChange(next);
      onFrame(selectedId ? Math.max(0, next.frames.findIndex(f => f.id === selectedId)) : Math.max(0, Math.min(frameIndex, next.frames.length - 1)));
    } catch (error) { setError((error as Error).message); }
  }
  function add(ids: string[], at: number) {
    const frames = ids.map((id) => {
      const image = images.find((i) => i.id === id);
      if (!image) throw new Error("请选择静态图片");
      return {
        id: crypto.randomUUID(),
        imageId: id,
        durationUs: Math.round(1000000 / (clip.initialFps || 12)),
      };
    });
    if (!frames.length) return;
    const next = [...clip.frames];
    next.splice(at, 0, ...frames);
    void commit({ ...clip, frames: next }, frames[0]!.id);
    setPicked([]);
  }
  function accepts(event: DragEvent) {
    return (
      event.dataTransfer.types.includes("application/x-sprite-frame") ||
      event.dataTransfer.types.includes("application/x-sprite-asset")
    );
  }
  function dragOver(event: DragEvent) {
    if (accepts(event)) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
        "application/x-sprite-frame",
      )
        ? "move"
        : "link";
    }
  }
  function drop(event: DragEvent, at: number) {
    if (!accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (busy || disabled) return;
    try {
      const moved = event.dataTransfer.getData("application/x-sprite-frame");
      if (moved) {
        const value = JSON.parse(moved);
        if (value.clipId !== clip.id)
          throw new Error("跨动画添加请从素材库选择图片");
        const index = clip.frames.findIndex(
          (frame) => frame.id === value.frameId,
        );
        if (index < 0) throw new Error("拖动的帧已变化，请重试");
        const next = [...clip.frames],
          frame = next.splice(index, 1)[0]!;
        next.splice(at - (index < at ? 1 : 0), 0, frame);
        if (next.every((f, i) => f.id === clip.frames[i]?.id)) return;
        void commit({ ...clip, frames: next }, frame.id);
        return;
      }
      const multiple = event.dataTransfer.getData(
        "application/x-sprite-assets",
      );
      add(
        multiple
          ? JSON.parse(multiple)
          : [event.dataTransfer.getData("application/x-sprite-asset")],
        at,
      );
    } catch (e: any) {
      setError(e.message);
    }
  }
  return (
    <div className="timeline animation-editor" aria-label="动画编排">
      <div className="timeline-heading">
        <div className="playback">
          <button
            className="play-button"
            aria-label={playing ? "暂停动画" : "播放动画"}
            disabled={!clip.frames.length}
            onClick={() => onPlaying(!playing)}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <span>
            {clip.frames.length ? frameIndex + 1 : 0} / {clip.frames.length} 帧
          </span>
          <span>
            {(
              clip.frames.reduce((sum, f) => sum + f.durationUs, 0) / 1000000
            ).toFixed(2)}{" "}
            s
          </span>
        </div>
        <div className="timeline-options">
          <label>
            <input
              type="checkbox"
              checked={clip.loop}
              onChange={(e) => void commit({ ...clip, loop: e.target.checked })}
              disabled={busy || disabled}
            />
            循环
          </label>
          <label>
            默认帧率
            <input
              aria-label="动画默认帧率"
              type="number"
              min="1"
              max="60"
              defaultValue={clip.initialFps || 12}
              key={`${clip.revision}-${clip.initialFps}`}
              onBlur={(e) => {
                const fps = Number(e.target.value);
                if (fps >= 1 && fps <= 60 && fps !== (clip.initialFps || 12))
                  void commit({ ...clip, initialFps: fps });
              }}
            />
          </label>
        </div>
      </div>
      <div
        className="frame-strip animation-drop-strip"
        onDragOver={dragOver}
        onDrop={(e) => drop(e, clip.frames.length)}
      >
        {clip.frames.map((frame, index) => {
          const image = images.find((i) => i.id === frame.imageId);
          return (
            <button
              key={frame.id}
              className={`frame ${index === frameIndex ? "selected" : ""}`}
              draggable={!busy && !disabled}
              aria-label={`第${index + 1}帧 ${image?.name || "图片"}`}
              onClick={() => {
                onPlaying(false);
                onFrame(index);
              }}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData(
                  "application/x-sprite-frame",
                  JSON.stringify({ clipId: clip.id, frameId: frame.id }),
                );
              }}
              onDragOver={dragOver}
              onDrop={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                drop(e, index + (e.clientX > box.x + box.width / 2 ? 1 : 0));
              }}
            >
              <span className="frame-number">{index + 1}</span>
              {image && (
                <img
                  draggable={false}
                  src={
                    previewSnapshot
                      ? snapshotFrameUrl(
                          projectId,
                          previewSnapshot.id,
                          frame.id,
                        )
                      : assetUrl(projectId, image.id, image.revision)
                  }
                  alt={image.name}
                />
              )}
              <small>{frame.durationUs / 1000} ms</small>
            </button>
          );
        })}
        <div className="timeline-insert-hint">
          <Plus size={18} />
          <span>
            {clip.frames.length
              ? "拖入图片追加；拖到帧的左右侧插入"
              : "从素材库拖入图片，或使用下方“添加图片”"}
          </span>
        </div>
      </div>
      <div className="frame-settings">
        {([-1, 1] as const).map(direction => <button key={direction} disabled={!current || disabled || frameIndex + direction < 0 || frameIndex + direction >= clip.frames.length} onClick={() => { const frames = [...clip.frames]; [frames[frameIndex], frames[frameIndex + direction]] = [frames[frameIndex + direction]!, frames[frameIndex]!]; commit({...clip, frames}, current!.id); }}>{direction < 0 ? "前移帧" : "后移帧"}</button>)}
        <button
          className="secondary"
          disabled={!current || busy || disabled}
          onClick={() => {
            const frames = [...clip.frames],
              copy = { ...current!, id: crypto.randomUUID() };
            frames.splice(frameIndex + 1, 0, copy);
            void commit({ ...clip, frames }, copy.id);
          }}
        >
          <Copy size={13} />
          重复帧
        </button>
        <button
          className="secondary"
          disabled={!current || busy || disabled}
          onClick={() =>
            void commit({
              ...clip,
              frames: clip.frames.filter((f) => f.id !== current!.id),
            })
          }
        >
          <Trash2 size={13} />
          移除帧
        </button>
        <button
          title="撤销草稿"
          aria-label="撤销草稿"
          disabled={!canUndo || disabled}
          onClick={onUndo}
        >
          <Undo2 size={14} />
        </button>
        <button
          title="重做草稿"
          aria-label="重做草稿"
          disabled={!canRedo || disabled}
          onClick={onRedo}
        >
          <Redo2 size={14} />
        </button>
        {current && (
          <label>
            停留
            <input
              aria-label="当前帧停留毫秒"
              type="number"
              min="1"
              max="60000"
              defaultValue={current.durationUs / 1000}
              key={`${clip.revision}-${current.id}-${current.durationUs}`}
              onBlur={(e) => {
                const us = Math.round(Number(e.target.value) * 1000);
                if (us >= 1000 && us <= 60000000 && us !== current.durationUs)
                  void commit({
                    ...clip,
                    frames: clip.frames.map((f) =>
                      f.id === current.id ? { ...f, durationUs: us } : f,
                    ),
                  });
              }}
            />
            ms
          </label>
        )}
        <button
          className="secondary"
          disabled={clip.frames.length < 2}
          onClick={() => onTool("interpolate")}
        >
          首尾补帧
        </button>
        <button
          className="secondary"
          disabled={!clip.frames.length}
          onClick={() => onTool("review")}
        >
          动画检查
        </button>
      </div>
      <details className="animation-picker">
        <summary>
          <Film size={14} />
          添加图片（引用素材，不复制文件）
        </summary>
        <input
          aria-label="筛选可添加图片"
          placeholder="按名称筛选图片"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="animation-picker-list">
          {images
            .filter((image) =>
              image.name.toLowerCase().includes(search.toLowerCase()),
            )
            .sort((a, b) =>
              a.name.localeCompare(b.name, "zh-CN", { numeric: true }),
            )
            .map((image) => (
              <label key={image.id}>
                <input
                  type="checkbox"
                  checked={picked.includes(image.id)}
                  onChange={(e) =>
                    setPicked((old) =>
                      e.target.checked
                        ? [...old, image.id]
                        : old.filter((id) => id !== image.id),
                    )
                  }
                />
                <img
                  src={assetUrl(projectId, image.id, image.revision)}
                  draggable={false}
                  alt=""
                />
                <span>{image.name}</span>
              </label>
            ))}
        </div>
        <button
          className="secondary"
          disabled={!picked.length || busy || disabled}
          onClick={() => {
            try {
              add(picked, current ? frameIndex + 1 : 0);
            } catch (e: any) {
              setError(e.message);
            }
          }}
        >
          添加 {picked.length} 张到{current ? "当前帧之后" : "动画"}
        </button>
      </details>
      <p className="animation-hint">
        时间轴内拖动是移动；需要重复时点击“重复帧”。默认帧率仅影响新增帧。
      </p>
      {error && (
        <p className="interpolation-warning" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
