import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function read(name: string): any {
  const path = `.local/reports/${name}.json`;
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}
const inspect = read('inspect');
const live = read('live');
const recovery = read('recovery');
const generation = read('generation-attempt');
const permissions = read('permissions');
const digest = (path: string) => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
const generatedInputsMatch = generation.imageEvents?.some((event: any) => event.event === 'item/completed' && event.inputImages?.some((input: any) => input.sha256 === generation.inputSha256 && digest(input.path) === input.sha256));
const generatedOutputsMatch = generation.outputs?.length > 0 && generation.outputs.every((output: any) => digest(output.path) === output.sha256);
const verdict = {
  observedAt: new Date().toISOString(),
  checks: {
    codexLogin: inspect.account?.type === 'chatgpt' && live.checks?.directImage?.status === 'completed',
    directImage: live.checks?.directImage?.passed === true,
    toolImage: live.checks?.toolImage?.passed === true,
    projectTools: live.checks?.toolIsolation?.passed === true && live.checks?.toolWrite?.passed === true && live.checks?.toolValidation?.passed === true,
    taskContinuation: live.checks?.taskContinuation?.passed === true,
    resumeAndInterrupt: recovery.checks?.resume?.passed === true && recovery.checks?.context?.passed === true && recovery.checks?.interrupt?.passed === true && recovery.checks?.reconnectWithoutResubmit?.passed === true,
    hostForm: recovery.checks?.form?.passed === true,
    referenceGeneration: generation.passed === true && generatedInputsMatch === true && generatedOutputsMatch === true,
    projectFilesystemIsolation: permissions.variants?.['restricted-profile']?.passed === true,
  },
  limits: [
    'No browser platform has been implemented; observer detachment was simulated at the protocol client.',
    'Only one static reference-image generation was tested; endpoints, animation continuity, generation cancellation and provider recovery are unverified.',
    'Project tool path checks do not prove an OS boundary around all built-in tools.',
  ],
};
const result = { ...verdict, passed: Object.values(verdict.checks).every(Boolean) };
writeFileSync('.local/reports/summary.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
