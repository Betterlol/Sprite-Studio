import type { ClipFrame } from "./model.ts";
import { StudioError } from "./store.ts";

export type TimingPolicy = "preserve-duration" | "fps";
export type InteriorPolicy = "preserve" | "replace";
export type InterpolationTiming = {
  timingPolicy?: TimingPolicy;
  interiorPolicy?: InteriorPolicy;
  fps: number;
};

/** Keep original instance/pixel identity; only explicit replace removes interior frames. */
export function interpolateFrames(
  frames: ClipFrame[],
  startFrameId: string,
  endFrameId: string,
  inserted: ClipFrame[],
  options: InterpolationTiming,
): ClipFrame[] {
  const start = frames.findIndex(f => f.id === startFrameId);
  const end = frames.findIndex(f => f.id === endFrameId);
  if (start < 0 || end <= start) throw new StudioError("尾帧必须位于首帧之后");
  const interior = options.interiorPolicy === "replace" ? [] : frames.slice(start + 1, end);
  let interval = [frames[start]!, ...inserted, ...interior];
  if (frames.length - (end - start) + interval.length > 128)
    throw new StudioError("补帧后的动画不能超过 128 帧");
  if ((options.timingPolicy ?? "preserve-duration") === "preserve-duration") {
    const duration = frames.slice(start, end).reduce((total, f) => total + f.durationUs, 0);
    if (duration < interval.length * 1000)
      throw new StudioError("保持区间总时长时每步必须至少 1000us，请减少补帧数量");
    interval = interval.map((f, i) => ({
      ...f,
      durationUs: Math.round((i + 1) * duration / interval.length) - Math.round(i * duration / interval.length),
    }));
    if (interval.some(f => f.durationUs > 60_000_000))
      throw new StudioError("单帧时长不能超过 60 秒");
  } else {
    if (!Number.isFinite(options.fps) || options.fps < 1 || options.fps > 60)
      throw new StudioError("补帧 fps 必须在 1 至 60 之间");
    interval = [frames[start]!, ...inserted.map((f, i) => ({
      ...f,
      durationUs: Math.round((i + 1) * 1_000_000 / options.fps) - Math.round(i * 1_000_000 / options.fps),
    })), ...interior];
  }
  return [...frames.slice(0, start), ...interval, ...frames.slice(end)];
}
