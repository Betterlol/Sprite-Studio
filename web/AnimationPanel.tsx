import type { FramePreview } from "./FrameAdjustmentPanel.tsx";
import { useEffect, useState, useRef } from "react";
import {
  ScanEye,
  Link2,
  Play,
  Check,
  Undo2,
  X,
  SlidersHorizontal,
  LoaderCircle,
} from "lucide-react";
import {
  type Asset,
  type ClipAsset,
  type ClipReference,
  type ClipReview,
  type FrameChange,
} from "../studio/model.ts";
import { api } from "./api.ts";
type Props = {
  draftPreview?: FramePreview;
  focusReviewId?: string;
  focusChangeId?: string;
  projectId: string;
  clip: ClipAsset;
  assets: Asset[];
  reviews: ClipReview[];
  changes: FrameChange[];
  onRefresh: () => Promise<void>;
  onReference: (ref: ClipReference) => void;
  onFrame: (clipId: string, frameId: string) => void;
  onAdjust: () => void;
  onCompare: (id: string) => Promise<void>;
  onPreview: (id: string) => void;
};
const labels = {
  pending: "正在修改",
  applied: "已修改",
  reverted: "已撤回",
  archived: "历史记录",
};
export function AnimationPanel(props: Props) {
  const { projectId, clip, assets, reviews, changes } = props;
  const baseId = clip.id;
  const related = changes.filter((change) => change.clipId === clip.id);
  const evidence = reviews.filter((review) => review.clipId === clip.id);
  const [start, setStart] = useState(0),
    [end, setEnd] = useState(Math.min(clip.frames.length - 1, 15));
  const [reviewId, setReviewId] = useState(""),
    [changeId, setChangeId] = useState(""),
    [operation, setOperation] = useState(""),
    [error, setError] = useState(""),
    [kind, setKind] = useState<"contact" | "onion">("contact");
  const review =
      evidence.find((review) => review.id === reviewId) || evidence[0],
    change = related.find((change) => change.id === changeId) || related[0];
  useEffect(() => {
    if (
      props.focusReviewId &&
      evidence.some((review) => review.id === props.focusReviewId)
    )
      setReviewId(props.focusReviewId);
  }, [props.focusReviewId]);
  useEffect(() => {
    if (
      props.focusChangeId &&
      related.some((change) => change.id === props.focusChangeId)
    )
      setChangeId(props.focusChangeId);
  }, [props.focusChangeId]);
  const base = clip;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    setStart((value) => Math.min(value, clip.frames.length - 1));
    setEnd((value) => Math.min(Math.max(value, start), clip.frames.length - 1));
  }, [clip.frames.length]);
  async function run(label: string, action: () => Promise<void>) {
    setOperation(label);
    setError("");
    try {
      await action();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setOperation("");
    }
  }
  const selectedRef = () => ({
    clipId: clip.id,
    revision: clip.revision,
    startFrameId: clip.frames[start]!.id,
    endFrameId: clip.frames[end]!.id,
  });
  const rangeValid = end >= start && end - start < 16;
  if (!clip.frames.length)
    return <p className="adjust-note">先向动画添加图片，再选择检查区间。</p>;
  return (
    <div className="animation-panel">
      {props.draftPreview && (
        <p className="review-note">
          检查整份动画草稿（尚未保存），包含全部帧调整。
        </p>
      )}
      <div className="review-controls">
        <label>
          从
          <select
            aria-label="检查起始帧"
            value={start}
            onChange={(event) => {
              const value = Number(event.target.value);
              setStart(value);
              if (end < value || end - value > 15)
                setEnd(Math.min(clip.frames.length - 1, value + 15));
            }}
          >
            {clip.frames.map((frame, index) => (
              <option key={frame.id} value={index}>
                第 {index + 1} 帧
              </option>
            ))}
          </select>
        </label>
        <label>
          到
          <select
            aria-label="检查结束帧"
            value={end}
            onChange={(event) => setEnd(Number(event.target.value))}
          >
            {clip.frames.map((frame, index) => (
              <option
                key={frame.id}
                value={index}
                disabled={index < start || index - start > 15}
              >
                第 {index + 1} 帧
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary"
          disabled={!!operation || !rangeValid}
          onClick={() =>
            void run("检查动画", async () => {
              const result = await api<ClipReview>(
                `/api/projects/${projectId}/reviews`,
                {
                  method: "POST",
                  body: JSON.stringify({
                    ...selectedRef(),
                    snapshotId: props.draftPreview?.preview.id,
                    draftId: props.draftPreview?.draft.id,
                    documentRevision:
                      props.draftPreview?.draft.documentRevision,
                  }),
                },
              );
              setReviewId(result.id);
              await props.onRefresh();
            })
          }
        >
          {operation === "检查动画" ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <ScanEye size={14} />
          )}
          检查选定区间
        </button>
        <button
          className="text-button"
          disabled={!rangeValid}
          onClick={() => props.onReference(selectedRef())}
        >
          <Link2 size={14} />
          引用区间到对话
        </button>
        <button className="text-button" onClick={props.onAdjust}>
          <SlidersHorizontal size={13} />
          修正当前帧
        </button>
      </div>
      {review && (
        <div className="review-evidence">
          <div className="review-heading">
            <select
              aria-label="动画检查记录"
              value={review.id}
              onChange={(event) => setReviewId(event.target.value)}
            >
              {evidence.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.clipId === baseId ? "当前动画" : "历史动画"} · 第{" "}
                  {item.frames[0]!.index + 1}–{item.frames.at(-1)!.index + 1} 帧
                  {item.stale ? " · 已过期" : ""}
                </option>
              ))}
            </select>
            <button
              className={kind === "contact" ? "active" : ""}
              onClick={() => setKind("contact")}
            >
              逐帧并排
            </button>
            <button
              className={kind === "onion" ? "active" : ""}
              onClick={() => setKind("onion")}
            >
              相邻叠图 / 循环
            </button>
          </div>
          {review.stale && (
            <p className="interpolation-warning">
              动画已有修改，以下是旧快照证据，请重新检查当前版本。
            </p>
          )}
          <details className="review-image" open={!change}>
            <summary>
              {kind === "contact"
                ? "实际帧图与停留时间"
                : "红色为前帧，青色为后帧；LOOP 为首尾循环边界"}
            </summary>
            <a
              href={`/api/projects/${projectId}/reviews/${review.id}/${kind}`}
              target="_blank"
              rel="noreferrer"
            >
              <img
                src={`/api/projects/${projectId}/reviews/${review.id}/${kind}`}
                alt={
                  kind === "contact" ? "动画逐帧检查图" : "相邻帧与循环边界叠图"
                }
              />
            </a>
          </details>
          <div className="review-frame-links">
            {review.frames.map((frame) => (
              <button
                key={frame.frameId}
                title={`可见范围 ${frame.width} × ${frame.height}，点击定位；范围变化不等于动作错误`}
                onClick={() => props.onFrame(review.clipId, frame.frameId)}
              >
                第 {frame.index + 1} 帧
                <span>
                  {frame.width}×{frame.height} · {frame.durationUs / 1000} ms
                </span>
              </button>
            ))}
          </div>
          <p className="review-note">
            静态证据可辅助定位大小和位置变化；动作节奏请结合实际播放判断。
          </p>
        </div>
      )}
      {change && (
        <div className="frame-change">
          <div className="review-heading">
            <strong>修改历史</strong>
            <select
              aria-label="单帧修改记录"
              value={change.id}
              onChange={(event) => setChangeId(event.target.value)}
            >
              {related.map((item) => (
                <option key={item.id} value={item.id}>
                  {labels[item.status]} ·{" "}
                  {new Date(item.createdAt).toLocaleTimeString("zh-CN")} ·{" "}
                  {item.source === "agent" ? "助手" : "手动"}
                </option>
              ))}
            </select>
          </div>
          <div className="change-actions">
            <button
              className="secondary"
              disabled={
                !!operation || (!change.afterSnapshotId && !change.legacyClipId)
              }
              onClick={() =>
                void run("载入对比", () => props.onCompare(change.id))
              }
            >
              <Play size={14} />
              播放修改前后对比
            </button>
            {change.status === "applied" && (
              <button
                className="secondary"
                disabled={!!operation}
                onClick={() =>
                  void run("撤回修改", async () => {
                    const result = await api<ClipAsset>(
                      `/api/projects/${projectId}/frame-changes/${change.id}/revert`,
                      {
                        method: "POST",
                        body: JSON.stringify({ revision: base.revision }),
                      },
                    );
                    await props.onRefresh();
                    if (mounted.current)
                      props.onFrame(result.id, change.frameId);
                  })
                }
              >
                <Undo2 size={14} />
                撤回此次修改
              </button>
            )}
            {change.status === "reverted" && (
              <span className="review-note">此次修改已撤回。</span>
            )}
          </div>
        </div>
      )}
      {!review && !change && (
        <p className="review-note">
          检查动画或引用给助手。单帧调整先预览草稿，保存后更新动画，并保留比较与撤回记录。
        </p>
      )}
      {error && (
        <p className="interpolation-warning" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
