import type { ClipSnapshot } from "../studio/model.ts";

export const animationDurationMs = (snapshot: ClipSnapshot) =>
  snapshot.clip.frames.reduce((sum, frame) => sum + frame.durationUs, 0) / 1000;

/** Shared wall clock, each clip's own timing. Empty clips have no frame. */
export function animationFrameAt(snapshot: ClipSnapshot, elapsedMs: number): number {
  const frames = snapshot.clip.frames, duration = animationDurationMs(snapshot);
  if (!frames.length || duration <= 0) return -1;
  let time = snapshot.clip.loop ? Math.max(0, elapsedMs) % duration : Math.min(Math.max(0, elapsedMs), duration);
  for (let index = 0; index < frames.length - 1; index++) {
    const length = frames[index]!.durationUs / 1000;
    if (time < length) return index;
    time -= length;
  }
  return frames.length - 1;
}

export function animationChangeSummary(before: ClipSnapshot, after: ClipSnapshot): string[] {
  const old = before.clip, next = after.clip;
  const summaries = [
    `帧数 ${old.frames.length} → ${next.frames.length}`,
    `总长 ${(animationDurationMs(before) / 1000).toFixed(3)} → ${(animationDurationMs(after) / 1000).toFixed(3)} 秒`,
    `播放 ${old.loop ? "循环" : "一次"} → ${next.loop ? "循环" : "一次"}`,
  ];
  const frameIds = (snapshot: ClipSnapshot) => snapshot.clip.frames.map(frame => frame.id).join(",");
  if (frameIds(before) !== frameIds(after)) summaries.push("帧编排已改变");
  const previous = new Map(old.frames.map(frame => [frame.id, frame]));
  const count = next.frames.filter(frame => {
    const base = previous.get(frame.id);
    return base && JSON.stringify(base) !== JSON.stringify(frame);
  }).length;
  if (count) summaries.push(`${count} 个保留帧的图片、变换或时长已改变`);
  return summaries;
}
