// Shared export vocabulary. This module is imported by both the HTTP service and
// the web client, so it must stay free of Node.js APIs.
export const exportFormats = [
  "all",
  "frames",
  "atlas",
  "webp",
  "gif",
  "review",
  "project",
] as const;
export type ExportFormat = (typeof exportFormats)[number];
export const exportFormatLabels: Record<ExportFormat, string> = {
  all: "完整动作资源 · 帧 + 图集 + WebP + GIF",
  frames: "PNG 帧序列",
  atlas: "PNG 图集 + TexturePacker JSON",
  webp: "展示动画 WebP",
  gif: "展示动画 GIF",
  review: "Review 序列 · WebP + GIF + 播放记录",
  project: "完整工程 · 资源 + 配置",
};
export const exportFormatDetails: Record<ExportFormat, string> = {
  all: "每个所选动画输出 PNG 帧、图集与展示动画，另附记录播放顺序的 JSON。",
  frames: "每个所选动画输出按游戏帧顺序编号的 PNG 帧。",
  atlas: "每个所选动画输出一张 PNG 图集和 TexturePacker JSON Hash。",
  webp: "按动画的停留时长和循环设置输出无损 WebP。",
  gif: "按动画的停留时长和循环设置输出 GIF，透明区域使用二值 alpha。",
  review: "把一个 Review 序列的完整播放（含重复与倍速）输出为 WebP、GIF 和播放记录。",
  project: "导出 Assets 下的全部资源文件、附属配置和工程信息，便于备份或换机。",
};
/** Formats that pack one or more selected animations. */
export const clipExportFormats: readonly ExportFormat[] = [
  "all",
  "frames",
  "atlas",
  "webp",
  "gif",
];
export const packingFormats: readonly ExportFormat[] = [
  "frames",
  "atlas",
  "webp",
  "gif",
];
export type ExportJobStatus = "running" | "completed" | "failed" | "cancelled";
export type ExportJob = {
  id: string;
  projectId: string;
  format: ExportFormat;
  status: ExportJobStatus;
  phase: string;
  completed: number;
  total: number;
  createdAt: string;
  finishedAt?: string;
  filename?: string;
  bytes?: number;
  error?: string;
  cancelled?: boolean;
};
export type ExportRecord = {
  filename: string;
  format?: ExportFormat;
  bytes: number;
  createdAt: string;
};
export type ExportListing = { records: ExportRecord[]; jobs: ExportJob[] };
