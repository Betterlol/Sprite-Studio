import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type FixtureFrame = { x: number; y: number; width: number; height: number; color: string; durationUs: number };
export type QualityFixture = { id: string; split: "development" | "holdout"; category: "offset" | "scale" | "crop" | "duration" | "loop" | "boundary" | "normal-motion"; intent: string; expected: "failed" | "suspect"; loop: boolean; frames: FixtureFrame[] };
const frame = (x: number, y = 24, width = 20, height = 32, durationUs = 100_000, color = "#356ac3"): FixtureFrame => ({ x, y, width, height, color, durationUs });
const sequence = (middle: FixtureFrame): FixtureFrame[] => [frame(20), middle, frame(24)];
export const qualityFixtures: QualityFixture[] = [
  { id: "dev-offset", split: "development", category: "offset", intent: "中帧突移", expected: "suspect", loop: false, frames: sequence(frame(42)) },
  { id: "dev-scale", split: "development", category: "scale", intent: "中帧异常放大", expected: "suspect", loop: false, frames: sequence(frame(22, 18, 31, 42)) },
  { id: "dev-crop", split: "development", category: "crop", intent: "禁止裁切时越界", expected: "failed", loop: false, frames: sequence(frame(-8)) },
  { id: "dev-duration", split: "development", category: "duration", intent: "非法零时长", expected: "failed", loop: false, frames: sequence(frame(22, 24, 20, 32, 0)) },
  { id: "dev-loop", split: "development", category: "loop", intent: "循环末帧跳移", expected: "suspect", loop: true, frames: [frame(20), frame(22), frame(44)] },
  { id: "dev-boundary", split: "development", category: "boundary", intent: "动作交接位置突变", expected: "suspect", loop: false, frames: [frame(18), frame(20), frame(46)] },
  { id: "dev-jump", split: "development", category: "normal-motion", intent: "正确跳跃不可拉平", expected: "suspect", loop: false, frames: sequence(frame(22, 9)) },
  { id: "dev-cape", split: "development", category: "normal-motion", intent: "正确披风展开不可缩回", expected: "suspect", loop: false, frames: sequence(frame(18, 24, 34, 32)) },
  { id: "dev-hold", split: "development", category: "normal-motion", intent: "有意顿帧不可均分", expected: "suspect", loop: false, frames: sequence(frame(22, 24, 20, 32, 400_000)) },
  { id: "hold-offset", split: "holdout", category: "offset", intent: "中帧反方向突移", expected: "suspect", loop: false, frames: sequence(frame(2)) },
  { id: "hold-crop", split: "holdout", category: "crop", intent: "右侧禁止裁切时越界", expected: "failed", loop: false, frames: sequence(frame(56)) },
  { id: "hold-duration", split: "holdout", category: "duration", intent: "过长时长", expected: "failed", loop: false, frames: sequence(frame(22, 24, 20, 32, 60_000_001)) },
  { id: "hold-loop", split: "holdout", category: "loop", intent: "循环首尾高度不连续", expected: "suspect", loop: true, frames: [frame(20), frame(22), frame(24, 5)] },
  { id: "hold-jump", split: "holdout", category: "normal-motion", intent: "不同幅度正确跳跃", expected: "suspect", loop: false, frames: sequence(frame(21, 14)) },
  { id: "hold-cape", split: "holdout", category: "normal-motion", intent: "不同形态正确披风展开", expected: "suspect", loop: false, frames: sequence(frame(15, 20, 38, 36)) },
  { id: "hold-hold", split: "holdout", category: "normal-motion", intent: "有意短暂停留", expected: "suspect", loop: false, frames: sequence(frame(22, 24, 20, 32, 250_000)) },
];

/** Observations are blank until a real, independently assessed run is performed. */
export type QualityEvaluationRecord = {
  fixtureId: string; split: QualityFixture["split"]; model: string; modelVersion: string; inputForm: string;
  located: string | null; before: string | null; after: string | null; harmfulEdit: boolean | null;
  elapsedMs: number | null; blindHumanAssessment: string | null; notes: string;
};

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
/** Creates a fresh directory only under this worktree's .local or the system temp directory. */
export function writeQualityFixtures(output: string): void {
  if (!isAbsolute(output)) throw new Error("输出目录必须是绝对路径");
  const target = resolve(output), parent = realpathSync(dirname(target));
  const worktree = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const localPath = join(worktree, ".local"), temp = realpathSync(tmpdir());
  // Do not follow a worktree .local junction outside the trusted worktree.
  const local = existsSync(localPath) ? realpathSync(localPath) : undefined;
  const inLocal = !!local && inside(local, worktree) && (parent === local || inside(parent, local));
  // TEMP may itself be a subdirectory of a project; inspect every real ancestor.
  let directory = temp;
  let tempIsProject = false;
  while (true) {
    if (["project.json", "pipeline.json"].some(marker => existsSync(join(directory, marker)))) {
      tempIsProject = true;
      break;
    }
    const ancestor = dirname(directory);
    if (ancestor === directory) break;
    directory = ancestor;
  }
  const inTemp = parent === temp && !tempIsProject;
  if (!inLocal && !inTemp) throw new Error("输出目录必须位于脚本所属 worktree 的 .local 或系统临时目录的直接子目录");
  mkdirSync(target); // exclusive: never reuse or overwrite an existing directory
  const manifest = qualityFixtures.map(f => ({ ...f, frames: f.frames.map((item, index) => ({ ...item, file: `${f.id}-${index + 1}.svg` })) }));
  for (const fixture of manifest) for (const item of fixture.frames) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" fill="${item.color}"/><circle cx="${item.x + item.width / 2}" cy="${item.y + 7}" r="3" fill="#fff"/></svg>\n`;
    writeFileSync(join(target, item.file), svg, { flag: "wx" });
  }
  writeFileSync(join(target, "manifest.json"), JSON.stringify({ version: 1, note: "合成夹具不证明模型能力；expected 只代表人工定义的期望处理级别。", fixtures: manifest }, null, 2) + "\n", { flag: "wx" });
  const records: QualityEvaluationRecord[] = qualityFixtures.map(f => ({ fixtureId: f.id, split: f.split, model: "", modelVersion: "", inputForm: "", located: null, before: null, after: null, harmfulEdit: null, elapsedMs: null, blindHumanAssessment: null, notes: "未运行；不代表通过" }));
  writeFileSync(join(target, "evaluation-template.json"), JSON.stringify({ version: 1, records }, null, 2) + "\n", { flag: "wx" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output || process.argv.length !== 3) throw new Error("用法: node probes/quality-fixtures.ts <新绝对目录：所属 worktree 的 .local 下或系统临时目录直接子目录>");
  writeQualityFixtures(output);
  console.log(`已创建 ${qualityFixtures.length} 个合成夹具：${output}；未运行模型评估。`);
}
