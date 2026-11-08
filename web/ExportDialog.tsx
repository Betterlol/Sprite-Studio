import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, LoaderCircle, X } from "lucide-react";
import { api } from "./api.ts";
import type { ClipAsset } from "../studio/model.ts";
import type { ReviewSequenceDefinition } from "../studio/workflow-model.ts";
import {
  clipExportFormats,
  exportFormatDetails,
  exportFormatLabels,
  exportFormats,
  type ExportFormat,
  type ExportJob,
  type ExportListing,
  type ExportRecord,
} from "../studio/export-formats.ts";

const downloadUrl = (projectId: string, filename: string) =>
  `/api/projects/${projectId}/exports/files/${encodeURIComponent(filename)}`;
const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const formatTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
};

export function ExportDialog({
  projectId,
  clips,
  reviewSequences,
  onClose,
}: {
  projectId: string;
  clips: ClipAsset[];
  reviewSequences: ReviewSequenceDefinition[];
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [format, setFormat] = useState<ExportFormat>("all");
  const [selected, setSelected] = useState<string[]>(() =>
    clips.filter((clip) => clip.frames.length).map((clip) => clip.id),
  );
  const [sequenceId, setSequenceId] = useState(
    () => reviewSequences.find((sequence) => !sequence.archived)?.id || "",
  );
  const [records, setRecords] = useState<ExportRecord[]>([]);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const downloaded = useRef(new Set<string>());

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const load = useCallback(async () => {
    const listing = await api<ExportListing>(
      `/api/projects/${projectId}/exports`,
    );
    setRecords(listing.records);
    const running = listing.jobs.find((item) => item.status === "running");
    if (running) setJob(running);
  }, [projectId]);
  useEffect(() => {
    void load().catch((caught) => setError((caught as Error).message));
  }, [load]);

  // Poll only while a job runs; closing the dialog does not stop the server job.
  useEffect(() => {
    if (!job || job.status !== "running") return;
    let stopped = false;
    const timer = setInterval(() => {
      void api<ExportJob>(
        `/api/projects/${projectId}/exports/jobs/${job.id}`,
      )
        .then((next) => {
          if (stopped) return;
          setJob(next);
          if (next.status === "running") return;
          void load().catch(() => {});
          if (next.status === "failed" && next.error) setError(next.error);
          if (next.status === "cancelled") setError("导出已取消");
          if (
            next.status === "completed" &&
            next.filename &&
            !downloaded.current.has(next.id)
          ) {
            downloaded.current.add(next.id);
            const link = document.createElement("a");
            link.href = downloadUrl(projectId, next.filename);
            link.download = next.filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
          }
        })
        .catch((caught) => {
          if (!stopped) setError((caught as Error).message);
        });
    }, 700);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [job?.id, job?.status, projectId, load]);

  // Keep local selection in sync with deleted clips without resetting choices.
  const clipKey = clips.map((clip) => clip.id).join(",");
  useEffect(() => {
    const available = new Set(clipKey ? clipKey.split(",") : []);
    setSelected((old) => old.filter((id) => available.has(id)));
  }, [clipKey]);
  const chosen = useMemo(() => {
    const available = new Set(clips.map((clip) => clip.id));
    return selected.filter((id) => available.has(id));
  }, [clips, selected]);
  const packing = clipExportFormats.includes(format);
  const activeSequence = useMemo(
    () =>
      reviewSequences.find(
        (sequence) => sequence.id === sequenceId && !sequence.archived,
      ) ||
      reviewSequences.find((sequence) => !sequence.archived) ||
      null,
    [reviewSequences, sequenceId],
  );
  const running = job?.status === "running";

  async function start() {
    setError("");
    setBusy(true);
    try {
      const created = await api<ExportJob>(
        `/api/projects/${projectId}/exports`,
        {
          method: "POST",
          body: JSON.stringify({
            format,
            clipIds: packing ? chosen : [],
            reviewSequenceId:
              format === "review" ? activeSequence?.id : undefined,
          }),
        },
      );
      setJob(created);
      await load();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!job) return;
    try {
      setJob(
        await api<ExportJob>(
          `/api/projects/${projectId}/exports/jobs/${job.id}/cancel`,
          { method: "POST" },
        ),
      );
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="export-dialog"
      aria-labelledby="export-title"
      onCancel={onClose}
    >
      <header>
        <div>
          <h2 id="export-title">导出资源</h2>
          <p>
            使用当前已保存的动画生成文件，不会覆盖工程里的资源；完成后 ZIP 同时保留在工程的
            Exports 目录。
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="关闭导出"
          onClick={onClose}
          autoFocus
        >
          <X size={18} />
        </button>
      </header>

      <section className="export-section">
        <h3>导出格式</h3>
        <div className="export-formats">
          {exportFormats.map((value) => (
            <label className="export-choice" key={value}>
              <input
                type="radio"
                name="export-format"
                value={value}
                checked={format === value}
                disabled={busy || running}
                onChange={() => setFormat(value)}
              />
              <span>
                <strong>{exportFormatLabels[value]}</strong>
                <small>{exportFormatDetails[value]}</small>
              </span>
            </label>
          ))}
        </div>
      </section>

      {packing && (
        <section className="export-section">
          <div className="export-toolbar">
            <h3>
              导出动画 · 已选 {chosen.length}/{clips.length}
            </h3>
            <span className="export-links">
              <button
                type="button"
                className="text-button"
                disabled={busy || running}
                onClick={() =>
                  setSelected(
                    clips
                      .filter((clip) => clip.frames.length)
                      .map((clip) => clip.id),
                  )
                }
              >
                全选
              </button>
              <button
                type="button"
                className="text-button"
                disabled={busy || running}
                onClick={() => setSelected([])}
              >
                清空
              </button>
            </span>
          </div>
          {clips.length ? (
            <div className="export-clips">
              {clips.map((clip) => (
                <label key={clip.id}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(clip.id)}
                    disabled={busy || running || !clip.frames.length}
                    onChange={(event) =>
                      setSelected((old) =>
                        event.target.checked
                          ? [...new Set([...old, clip.id])]
                          : old.filter((id) => id !== clip.id),
                      )
                    }
                  />
                  <span title={clip.name}>{clip.name}</span>
                  <small>{clip.frames.length ? `${clip.frames.length} 帧` : "无帧"}</small>
                </label>
              ))}
            </div>
          ) : (
            <p role="status">工程里还没有动画。先创建动画并保存，再导出动作资源。</p>
          )}
        </section>
      )}

      {format === "review" && (
        <section className="export-section">
          <h3>Review 序列</h3>
          {activeSequence ? (
            <select
              aria-label="选择 Review 序列"
              value={activeSequence.id}
              disabled={busy || running}
              onChange={(event) => setSequenceId(event.target.value)}
            >
              {reviewSequences
                .filter((sequence) => !sequence.archived)
                .map((sequence) => (
                  <option key={sequence.id} value={sequence.id}>
                    {sequence.name} · {sequence.segments.length} 段
                  </option>
                ))}
            </select>
          ) : (
            <p role="status">
              还没有可用的 Review 序列。先创建 Review 并检查，再回到这里导出。
            </p>
          )}
          <p className="export-hint">
            导出使用序列当前的重复次数与倍速；已有未过期的检查快照会被复用，不重新生成图片。
          </p>
        </section>
      )}

      {error && (
        <p role="alert" className="export-error">
          {error}
        </p>
      )}

      <section className="export-section">
        <h3>生成</h3>
        {job ? (
          <div className="export-progress">
            <p role="status">
              {job.status === "running"
                ? `${job.phase} · ${job.completed}/${job.total || "?"}`
                : job.status === "completed"
                  ? "导出完成，ZIP 已保存"
                  : job.status === "cancelled"
                    ? "导出已取消"
                    : "导出失败"}
            </p>
            <progress value={job.completed} max={Math.max(job.total, 1)} />
            <div className="export-toolbar">
              {running && (
                <button
                  type="button"
                  disabled={job.cancelled}
                  onClick={() => void cancel()}
                >
                  {job.cancelled ? "正在取消…" : "取消生成"}
                </button>
              )}
              {job.status === "completed" && job.filename && (
                <a
                  className="primary"
                  href={downloadUrl(projectId, job.filename)}
                  download={job.filename}
                >
                  <Download size={15} />
                  下载 ZIP
                </a>
              )}
            </div>
          </div>
        ) : (
          <p>
            生成 ZIP 后自动下载。帧序列按动画的游戏帧顺序编号，图集附带 TexturePacker JSON
            Hash，WebP / GIF 使用动画自己的停留时长与循环设置。
          </p>
        )}
        <div className="export-toolbar">
          <button
            className="primary"
            type="button"
            disabled={
              busy ||
              running ||
              (packing && !chosen.length) ||
              (format === "review" && !activeSequence)
            }
            onClick={() => void start()}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Download size={15} />
            )}
            生成并下载 ZIP
          </button>
        </div>
      </section>

      <section className="export-section">
        <h3>导出记录</h3>
        {records.length ? (
          <div className="export-records">
            {records.map((record) => (
              <div className="export-record" key={record.filename}>
                <span>
                  <strong title={record.filename}>{record.filename}</strong>
                  <small>
                    {formatTime(record.createdAt)} · {formatBytes(record.bytes)}
                    {record.format
                      ? ` · ${exportFormatLabels[record.format]}`
                      : ""}
                  </small>
                </span>
                <a
                  className="icon-button"
                  href={downloadUrl(projectId, record.filename)}
                  download={record.filename}
                  title="下载这个导出"
                  aria-label={`下载 ${record.filename}`}
                >
                  <Download size={15} />
                </a>
              </div>
            ))}
          </div>
        ) : (
          <p role="status">还没有导出记录。生成一次后会列在这里。</p>
        )}
      </section>
    </dialog>
  );
}
