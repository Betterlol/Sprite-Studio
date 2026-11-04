import { useEffect, useState } from "react";
import { Play, Pause, RotateCcw, X } from "lucide-react";
import { snapshotFrameUrl, type ClipSnapshot } from "../studio/model.ts";
export function ComparisonPlayer({
  before,
  after,
  onClose,
}: {
  before: ClipSnapshot;
  after: ClipSnapshot;
  onClose: () => void;
}) {
  const [playing, setPlaying] = useState(true),
    [elapsed, setElapsed] = useState(0),
    [run, setRun] = useState(0);
  const total = (snap: ClipSnapshot) =>
    snap.clip.frames.reduce((sum, frame) => sum + frame.durationUs, 0) / 1000;
  const max = Math.max(total(before), total(after));
  useEffect(() => {
    if (!playing) return;
    let request = 0,
      last = performance.now(),
      current = elapsed;
    const tick = (time: number) => {
      current += Math.min(time - last, 100);
      last = time;
      setElapsed(current);
      if (!before.clip.loop && !after.clip.loop && current >= max) {
        setPlaying(false);
        return;
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [playing, before.id, after.id, run]);
  const panel = (snapshot: ClipSnapshot, label: string) => {
    const duration = total(snapshot);
    let time = snapshot.clip.loop
        ? elapsed % duration
        : Math.min(elapsed, duration - 0.001),
      index = 0;
    while (
      index < snapshot.clip.frames.length - 1 &&
      time >= snapshot.clip.frames[index]!.durationUs / 1000
    ) {
      time -= snapshot.clip.frames[index]!.durationUs / 1000;
      index++;
    }
    const frame = snapshot.clip.frames[index]!;
    return (
      <div className="comparison-side">
        <div className="comparison-label">
          {label}
          <span>
            第 {index + 1} / {snapshot.clip.frames.length} 帧
          </span>
        </div>
        <div className="comparison-image">
          <img
            src={snapshotFrameUrl(snapshot.projectId, snapshot.id, frame.id)}
            alt={`${label}第 ${index + 1} 帧`}
            style={{
              maxWidth: snapshot.images[frame.imageId]!.width * 3,
              maxHeight: snapshot.images[frame.imageId]!.height * 3,
            }}
          />
        </div>
        <small>
          本帧 {frame.durationUs / 1000} ms · 总长{" "}
          {(duration / 1000).toFixed(3)} s
        </small>
      </div>
    );
  };
  return (
    <div className="comparison-player">
      <div className="comparison-heading">
        <strong>修改前后对比</strong>
        <span>同一时钟，按各自帧时长播放</span>
        <button className="text-button" onClick={onClose}>
          <X size={14} />
          回到单画布
        </button>
      </div>
      <div className="comparison-panes">
        {panel(before, "修改前")}
        {panel(after, "修改后")}
      </div>
      <div className="comparison-controls">
        <button
          className="secondary"
          aria-label={playing ? "暂停对比播放" : "开始对比播放"}
          onClick={() => setPlaying(!playing)}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}{" "}
          {playing ? "暂停" : "播放"}
        </button>
        <button
          className="text-button"
          onClick={() => {
            setElapsed(0);
            setRun((value) => value + 1);
            setPlaying(true);
          }}
        >
          <RotateCcw size={13} />
          从头播放
        </button>
        <span>{(elapsed / 1000).toFixed(2)} s</span>
        <small>每侧独立循环；时长改变会影响节奏。</small>
      </div>
    </div>
  );
}
