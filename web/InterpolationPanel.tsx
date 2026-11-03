import { useEffect, useState, useRef } from "react";
import {
  Sparkles,
  Play,
  Check,
  LoaderCircle,
  MessageSquare,
  ArrowRight,
} from "lucide-react";
import {
  assetUrl,
  interpolationGrid,
  type Asset,
  type ClipAsset,
  type Interpolation,
  type Session,
} from "../studio/model.ts";
import { api } from "./api.ts";

type Props = {
  projectId: string;
  clip: ClipAsset;
  assets: Asset[];
  jobs: Interpolation[];
  sessions: Session[];
  connected: boolean;
  busy: boolean;
  refresh: () => Promise<void>;
  onSession: (id: string) => void;
  onPreview: (clipId: string) => void;
};
const labels = {
  running: "正在生成",
  candidate: "候选待检查",
  preview: "预览待确认",
  applied: "已加入动画",
  failed: "生成未完成",
  interrupted: "任务已停止",
};
export function InterpolationPanel(props: Props) {
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const { projectId, clip, assets, jobs, sessions } = props;
  const related = jobs.filter((job) => job.clipId === clip.id);
  const [selectedJob, setSelectedJob] = useState(
    () =>
      localStorage.getItem(`studio.interpolation.${projectId}.${clip.id}`) ||
      "",
  );
  const job = related.find((job) => job.id === selectedJob) || related[0];
  const [start, setStart] = useState(
      Math.max(
        0,
        clip.frames.findIndex((frame) => frame.id === job?.start.frameId),
      ),
    ),
    [end, setEnd] = useState(
      job
        ? clip.frames.findIndex((frame) => frame.id === job.end.frameId)
        : clip.frames.length - 1,
    );
  const [count, setCount] = useState(job?.count || 2),
    [fps, setFps] = useState(
      job?.fps ||
        Math.max(
          1,
          Math.min(
            60,
            Math.round(1_000_000 / (clip.frames[0]?.durationUs || 83333)),
          ),
        ),
    );
  const [description, setDescription] = useState(
    job?.description ||
      "保持角色造型、大小和基准一致，让动作从首帧自然过渡到尾帧。",
  );
  const [columns, setColumns] = useState(2),
    [rows, setRows] = useState(2),
    [includesEndpoints, setIncludesEndpoints] = useState(true);
  const [layoutFps, setLayoutFps] = useState(12);
  const [operation, setOperation] = useState(""),
    [error, setError] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [requestKey, setRequestKey] = useState("");
  const sheet = assets.find((asset) => asset.id === job?.sheetId);
  const taskSession = sessions.find((session) => session.id === job?.sessionId);
  const taskActive =
    taskSession && ["starting", "running"].includes(taskSession.status);
  const stale =
    !!job && job.status !== "applied" && clip.revision !== job.clipRevision;
  const grid = interpolationGrid(count);
  useEffect(() => {
    if (!job) return;
    localStorage.setItem(
      `studio.interpolation.${projectId}.${clip.id}`,
      job.id,
    );
    setColumns(job.prepared?.spec.columns || job.columns);
    setRows(job.prepared?.spec.rows || job.rows);
    setIncludesEndpoints(job.prepared?.spec.includesEndpoints ?? true);
    setLayoutFps(job.prepared?.spec.fps || job.fps);
    setError("");
  }, [job?.id]);
  useEffect(() => {
    setStart((value) => Math.min(value, Math.max(0, clip.frames.length - 2)));
    setEnd((value) => Math.min(Math.max(1, value), clip.frames.length - 1));
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
  async function generate() {
    const body = {
      clipId: clip.id,
      revision: clip.revision,
      startFrameId: clip.frames[start]!.id,
      endFrameId: clip.frames[end]!.id,
      count,
      fps,
      description,
    };
    const key = JSON.stringify(body),
      id = requestKey === key ? requestId : crypto.randomUUID();
    setRequestKey(key);
    setRequestId(id);
    await run("正在提交", async () => {
      const created = await api<Interpolation>(
        `/api/projects/${projectId}/interpolations`,
        { method: "POST", body: JSON.stringify({ ...body, requestId: id }) },
      );
      setSelectedJob(created.id);
      await props.refresh();
      if (mounted.current) props.onSession(created.sessionId);
      setRequestKey("");
    });
  }
  const layoutMatches =
    !!job && columns * rows === job.count + (includesEndpoints ? 2 : 0);
  const previewCurrent =
    job?.prepared &&
    JSON.stringify(job.prepared.spec) ===
      JSON.stringify({ columns, rows, includesEndpoints, fps: layoutFps });
  async function prepare() {
    if (!job) return;
    await run("正在切割", async () => {
      const updated = await api<Interpolation>(
        `/api/projects/${projectId}/interpolations/${job.id}/prepare`,
        {
          method: "POST",
          body: JSON.stringify({
            columns,
            rows,
            includesEndpoints,
            fps: layoutFps,
          }),
        },
      );
      await props.refresh();
      if (mounted.current) props.onPreview(updated.prepared!.clipId);
    });
  }
  const endpoint = (index: number, label: string) => {
    const image = assets.find(
      (asset) => asset.id === clip.frames[index]?.imageId,
    );
    return (
      <div className="endpoint">
        <span>
          {image?.type === "image" && (
            <img
              src={assetUrl(projectId, image.id, image.revision)}
              alt={`${label}参考`}
            />
          )}
        </span>
        <label>
          {label}
          <select
            aria-label={`补帧${label}`}
            value={index}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (label === "首帧") {
                setStart(value);
                if (end <= value) setEnd(value + 1);
              } else setEnd(value);
            }}
          >
            {clip.frames.map((frame, i) => (
              <option
                key={frame.id}
                value={i}
                disabled={
                  label === "首帧" ? i === clip.frames.length - 1 : i <= start
                }
              >
                第 {i + 1} 帧
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  };
  if (clip.frames.length < 2)
    return (
      <div className="interpolation-panel">
        <p>需要至少两帧动画，才能选择首尾参考。</p>
      </div>
    );
  return (
    <div className="interpolation-panel">
      <div className="interpolation-create">
        <div className="endpoint-pair">
          {endpoint(start, "首帧")}
          <ArrowRight size={15} />
          {endpoint(end, "尾帧")}
          <label>
            补帧数
            <input
              aria-label="补帧数量"
              type="number"
              min="1"
              max="8"
              value={count}
              onChange={(event) =>
                setCount(Math.max(1, Math.min(8, Number(event.target.value))))
              }
            />
          </label>
          <label>
            新增帧率
            <input
              aria-label="补帧帧率"
              type="number"
              min="1"
              max="60"
              value={fps}
              onChange={(event) =>
                setFps(Math.max(1, Math.min(60, Number(event.target.value))))
              }
            />
          </label>
        </div>
        <div className="interpolation-description">
          <textarea
            aria-label="补帧动作描述"
            value={description}
            maxLength={2000}
            onChange={(event) => setDescription(event.target.value)}
          />
          <button
            className="secondary"
            disabled={
              !!operation ||
              props.busy ||
              !props.connected ||
              !description.trim()
            }
            onClick={() => void generate()}
          >
            {operation === "正在提交" ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Sparkles size={14} />
            )}
            引用首尾生成
          </button>
        </div>
        <p className="interpolation-note">
          生成 {grid.columns} 列 × {grid.rows} 行、含首尾的图集；原首尾保留。
          {end - start > 1
            ? `确认后替换区间内 ${end - start - 1} 帧，旧图片仍保留。`
            : "确认后将中间帧加入两帧之间。"}
        </p>
      </div>
      {job && (
        <div className="interpolation-result">
          <div className="interpolation-result-heading">
            <select
              aria-label="补帧任务记录"
              value={job.id}
              onChange={(event) => setSelectedJob(event.target.value)}
            >
              {related.map((item, i) => (
                <option key={item.id} value={item.id}>
                  {labels[item.status]} · {item.count} 帧 ·{" "}
                  {new Date(item.createdAt).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </option>
              ))}
            </select>
            <button
              className="text-button"
              onClick={() => props.onSession(job.sessionId)}
            >
              <MessageSquare size={13} />
              查看对话
            </button>
            {taskActive && (
              <button
                className="text-button"
                onClick={() =>
                  void run("停止补帧", async () => {
                    await api(`/api/sessions/${job.sessionId}/stop`, {
                      method: "POST",
                    });
                    await props.refresh();
                  })
                }
              >
                停止
              </button>
            )}
          </div>
          {job.error && <p className="interpolation-warning">{job.error}</p>}
          {stale && (
            <p className="interpolation-warning">
              原动画已修改。请根据当前动画重新发起补帧，旧候选保留。
            </p>
          )}
          {sheet?.type === "image" ? (
            <>
              <details className="interpolation-sheet">
                <summary>
                  <img
                    src={assetUrl(projectId, sheet.id, sheet.revision)}
                    alt="生成的补帧图集"
                  />
                  <span>
                    查看生成图集
                    <small>
                      {job.referencesVerified
                        ? "已确认首尾两张参考传入生成"
                        : "未确认完整参考"}{" "}
                      · 首尾格不会替代原帧
                    </small>
                  </span>
                </summary>
                <img
                  src={assetUrl(projectId, sheet.id, sheet.revision)}
                  alt="补帧图集完整预览"
                />
              </details>
              {job.status !== "applied" && (
                <div className="interpolation-layout">
                  <label>
                    列
                    <input
                      aria-label="候选图集列数"
                      type="number"
                      min="1"
                      max="10"
                      value={columns}
                      onChange={(event) =>
                        setColumns(
                          Math.max(1, Math.min(10, Number(event.target.value))),
                        )
                      }
                    />
                  </label>
                  <label>
                    行
                    <input
                      aria-label="候选图集行数"
                      type="number"
                      min="1"
                      max="10"
                      value={rows}
                      onChange={(event) =>
                        setRows(
                          Math.max(1, Math.min(10, Number(event.target.value))),
                        )
                      }
                    />
                  </label>
                  <label>
                    <input
                      aria-label="候选包含首尾帧"
                      type="checkbox"
                      checked={includesEndpoints}
                      onChange={(event) =>
                        setIncludesEndpoints(event.target.checked)
                      }
                    />
                    含首尾
                  </label>
                  <label>
                    fps
                    <input
                      aria-label="预览补帧帧率"
                      type="number"
                      min="1"
                      max="60"
                      value={layoutFps}
                      onChange={(event) =>
                        setLayoutFps(
                          Math.max(1, Math.min(60, Number(event.target.value))),
                        )
                      }
                    />
                  </label>
                  <button
                    className="secondary"
                    disabled={!!operation || !layoutMatches || stale}
                    onClick={() => void prepare()}
                  >
                    {operation === "正在切割" ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Play size={14} />
                    )}
                    切割并播放预览
                  </button>
                </div>
              )}
              {!layoutMatches && job.status !== "applied" && (
                <p className="interpolation-warning">
                  当前布局需恰好包含 {job.count + (includesEndpoints ? 2 : 0)}{" "}
                  格，请按实际生成结果调整。
                </p>
              )}
              {job.status === "preview" && (
                <div className="interpolation-apply">
                  <span>
                    中间 {job.count} 帧已统一到 {job.width} × {job.height}{" "}
                    画布，请播放检查动作。
                  </span>
                  <button
                    className="primary"
                    disabled={!!operation || stale || !previewCurrent}
                    onClick={() =>
                      void run("正在加入动画", async () => {
                        const updated = await api<ClipAsset>(
                          `/api/projects/${projectId}/interpolations/${job.id}/apply`,
                          {
                            method: "POST",
                            body: JSON.stringify({
                              previewRevision: (
                                assets.find(
                                  (asset) => asset.id === job.prepared?.clipId,
                                ) as ClipAsset | undefined
                              )?.revision,
                            }),
                          },
                        );
                        await props.refresh();
                        if (mounted.current) props.onPreview(updated.id);
                      })
                    }
                  >
                    <Check size={14} />
                    确认加入动画并播放
                  </button>
                </div>
              )}
              {job.status === "applied" && (
                <div className="interpolation-apply">
                  <span>
                    <Check size={13} />
                    已加入动画，原始首尾和旧图片保留。
                  </span>
                  <button
                    className="secondary"
                    onClick={() => props.onPreview(job.clipId)}
                  >
                    <Play size={14} />
                    播放完整动画
                  </button>
                </div>
              )}
            </>
          ) : job.status === "running" ? (
            <p className="interpolation-wait">
              <LoaderCircle size={14} className="spin" />
              正在使用两张首尾参考生成，刷新页面可继续查看。
            </p>
          ) : null}
        </div>
      )}
      {error && (
        <p className="interpolation-warning" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
