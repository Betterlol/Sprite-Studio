import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { AppServer, assistantText } from './client.ts';
import type { ThreadStartParams } from '../.local/protocol/v2/ThreadStartParams.ts';

const project = resolve('.local/project');
const reference = join(project, 'Assets', 'asset-1.png');
const output = join(project, 'Scratch', 'generated');
mkdirSync(output, { recursive: true });
mkdirSync('.local/reports', { recursive: true });
const attemptPath = '.local/reports/generation-attempt.json';
if (existsSync(attemptPath)) throw new Error('An image attempt is already recorded. Inspect it instead of automatically retrying or spending again.');
const report: any = {
  observedAt: new Date().toISOString(), status: 'prepared', maxImageCalls: 1,
  inputSha256: createHash('sha256').update(readFileSync(reference)).digest('hex'),
  imageEvents: [],
};
const save = () => writeFileSync(attemptPath, JSON.stringify(report, null, 2) + '\n');
writeFileSync(attemptPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
const server = new AppServer(project, ['features.shell_tool=false', 'features.unified_exec=false', 'features.view_image=false', 'features.image_generation=true']);
let startedCalls = 0;
server.on('notification', message => {
  if (message.params?.item?.type === 'imageGeneration' && ['item/started', 'item/completed'].includes(message.method!)) {
    const item = message.params.item;
    report.imageEvents.push({ event: message.method, id: item.id, status: item.status, savedPath: item.savedPath, inputImages: item.inputImages, failure: item.failure, hasInlineResult: typeof item.result === 'string' && item.result.length > 0, hasFileId: !!item.fileId });
    if (message.method === 'item/started' && ++startedCalls > 1) void server.request('turn/interrupt', { threadId: report.threadId, turnId: report.turnId });
    save();
  }
});

try {
  await server.initialize();
  const thread = await server.request('thread/start', {
    cwd: output, sandbox: 'workspace-write', approvalPolicy: 'never',
    developerInstructions: 'You are running one authorized diagnostic image generation, with a maximum of one built-in image_gen call. Use the actual supplied reference. Do not call shell, external MCP, paid API alternatives, or install anything. If the built-in image tool is unavailable or fails, report that and stop. Never retry generation.',
  } satisfies ThreadStartParams);
  report.threadId = thread.thread.id; report.model = thread.model; report.provider = thread.modelProvider;
  report.status = 'submitted'; save();
  const result = await server.request('turn/start', {
    threadId: thread.thread.id, effort: 'low',
    input: [
      { type: 'text', text: `Use the built-in image_gen exactly once to edit the attached reference into a clean flat geometric illustration. Preserve the magenta circle in the upper-left and the three yellow diamonds. Change the lower-right teal square to a blue star. Remove the black digits. Keep a white background. Actually pass this reference image to the generator (reference path: ${reference}); do not merely describe it. Save the resulting image if the tool supports it. This is a single diagnostic request, not an animation or sprite platform implementation. Stop after the first generation result or failure.`, text_elements: [] },
      { type: 'localImage', path: reference },
    ],
  });
  report.turnId = result.turn.id; save();
  const completion = await server.waitTurn(result.turn.id, 360_000);
  report.status = completion.status; report.error = completion.error; report.answer = assistantText(server, result.turn.id);
  for (const event of report.imageEvents.filter((item: any) => item.event === 'item/completed' && item.savedPath)) {
    const source = event.savedPath;
    if (existsSync(source)) {
      const target = join(output, `result-${report.outputs?.length ?? 0}.png`);
      copyFileSync(source, target);
      const bytes = readFileSync(target);
      report.outputs ??= [];
      report.outputs.push({ path: target, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  report.passed = startedCalls === 1 && report.imageEvents.some((item: any) => item.event === 'item/completed' && item.status === 'completed' && !item.failure && item.inputImages?.some((input: any) => input.sha256 === report.inputSha256)) && (report.outputs?.length ?? 0) > 0;
} catch (error) { report.status = 'unknown-or-failed'; report.error = String(error); process.exitCode = 1; }
finally { save(); await server.close(); }
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
