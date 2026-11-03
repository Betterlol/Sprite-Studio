import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { AppServer, assistantText } from './client.ts';
import type { ThreadStartParams } from '../.local/protocol/v2/ThreadStartParams.ts';
import type { TurnStartParams } from '../.local/protocol/v2/TurnStartParams.ts';
import { project, fixtureOverrides } from './settings.ts';

const server = new AppServer(project, fixtureOverrides);
const report: any = { observedAt: new Date().toISOString(), checks: {} };
mkdirSync('.local/reports', { recursive: true });
const save = () => writeFileSync('.local/reports/live.json', JSON.stringify(report, null, 2) + '\n');
const schema = { type: 'object', properties: { code: { type: 'string' }, diamonds: { type: 'integer' }, circle: { type: 'string' }, square: { type: 'string' } }, required: ['code', 'diamonds', 'circle', 'square'], additionalProperties: false };
const expected = JSON.parse(readFileSync('.local/expected.json', 'utf8'));
const text = (value: string) => ({ type: 'text' as const, text: value, text_elements: [] });
const imagePrompt = 'Inspect the actual image pixels. Return code as the four digits, diamonds as the number of yellow diamonds, and circle/square as top-left, top-right, bottom-left, or bottom-right. Do not read files or infer from filenames.';

async function turn(threadId: string, input: TurnStartParams['input'], extra: Partial<TurnStartParams> = {}) {
  const result = await server.request('turn/start', { threadId, input, effort: 'low', ...extra } satisfies TurnStartParams);
  const completed = await server.waitTurn(result.turn.id);
  return { turnId: result.turn.id, status: completed.status, error: completed.error, answer: assistantText(server, result.turn.id) };
}

try {
  await server.initialize();
  const started = await server.request('thread/start', {
    cwd: project, sandbox: 'read-only', approvalPolicy: 'never',
    developerInstructions: 'This is an authorized integration probe using synthetic fixtures only. Do exactly the requested bounded checks. Use only sprite_probe tools when tools are requested. The read-only shell policy does not forbid approved application MCP tools: sprite_probe.write_note and submit_job are explicitly authorized to write synthetic fixtures to Scratch through the host. Do not inspect any host config, credentials, or other user projects. Never request expanded permissions. Respond concisely.',
  } satisfies ThreadStartParams);
  const threadId = started.thread.id;
  report.threadId = threadId;
  report.effective = { model: started.model, provider: started.modelProvider, sandbox: started.sandbox, activePermissionProfile: started.activePermissionProfile };
  console.log('Started diagnostic thread.'); save();
  const direct = await turn(threadId, [text(imagePrompt), { type: 'localImage', path: join(project, 'Assets', 'asset-1.png') }], { outputSchema: schema });
  const parsed = JSON.parse(direct.answer);
  report.checks.directImage = { ...direct, expected: expected['1'], passed: Object.entries(expected['1']).every(([key, value]) => parsed[key] === value) };
  console.log('Direct image:', report.checks.directImage.passed); save();
  const inventory = await server.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', limit: 100 });
  report.mcpInventory = inventory.data.map((entry: any) => ({ name: entry.name, tools: Object.keys(entry.tools ?? {}), authStatus: entry.authStatus }));
  const unexpected = report.mcpInventory.filter((entry: any) => entry.name !== 'sprite_probe' && entry.tools.length > 0);
  report.checks.toolIsolation = { unexpectedActiveServers: unexpected.map((entry: any) => entry.name), passed: unexpected.length === 0 && inventory.nextCursor == null };
  save();
  if (!report.checks.toolIsolation.passed) throw new Error('Unexpected inherited tools are active; stopping before tool requests');
  const returned = await turn(threadId, [text('Call sprite_probe.get_image with asset=2, inspect the returned image, then: ' + imagePrompt)], { outputSchema: schema });
  const toolEvents = server.notifications.filter(message => message.method === 'item/completed' && message.params.turnId === returned.turnId && message.params.item.type === 'mcpToolCall');
  report.checks.toolImage = { ...returned, tools: toolEvents.map(message => ({ server: message.params.item.server, tool: message.params.item.tool, status: message.params.item.status, error: message.params.item.error, result: message.params.item.result?.isError ? message.params.item.result : undefined })) }; save();
  const parsedReturned = JSON.parse(returned.answer);
  report.checks.toolImage = { ...returned, expected: expected['2'], tools: toolEvents.map(message => ({ server: message.params.item.server, tool: message.params.item.tool, status: message.params.item.status })), passed: toolEvents.some(message => message.params.item.tool === 'get_image') && Object.entries(expected['2']).every(([key, value]) => parsedReturned[key] === value) };
  console.log('MCP image:', report.checks.toolImage.passed); save();
  const filename = `note-${Date.now()}.txt`;
  const note = await turn(threadId, [text(`Call sprite_probe.write_note with filename=${JSON.stringify(filename)} and text="SYNTHETIC-NOTE". Then report the relative path. Do not use shell or file tools.`)]);
  report.checks.toolWrite = { ...note, passed: existsSync(join(project, 'Scratch', filename)) && readFileSync(join(project, 'Scratch', filename), 'utf8') === 'SYNTHETIC-NOTE' };
  console.log('MCP write:', report.checks.toolWrite.passed); save();
  const rejected = await server.request('mcpServer/tool/call', { threadId, server: 'sprite_probe', tool: 'write_note', arguments: { filename: '../Assets/forbidden.txt', text: 'must not be written' } });
  report.checks.toolValidation = { isError: rejected.isError, content: rejected.content, passed: rejected.isError === true };
  console.log('Tool path rejection:', report.checks.toolValidation.passed); save();
  const beforeJobs = new Set(readdirSync(join(project, 'Scratch')));
  const submitted = await turn(threadId, [text('Call sprite_probe.submit_job exactly once. Return its jobId and finish this turn without polling or waiting. The host will later send a completion event.')]);
  const newJobs = readdirSync(join(project, 'Scratch')).filter(name => name.startsWith('synthetic-job-') && !beforeJobs.has(name));
  const submissionCalls = server.notifications.filter(message => message.method === 'item/completed' && message.params.turnId === submitted.turnId && message.params.item.type === 'mcpToolCall' && message.params.item.tool === 'submit_job' && message.params.item.status === 'completed');
  if (newJobs.length !== 1 || submissionCalls.length !== 1) throw new Error('Expected exactly one new synthetic task and one completed submit call');
  const jobFile = newJobs[0]!;
  const job = JSON.parse(readFileSync(join(project, 'Scratch', jobFile), 'utf8'));
  job.status = 'succeeded';
  writeFileSync(join(project, 'Scratch', jobFile), JSON.stringify(job));
  const completion = await turn(threadId, [], { toolOutput: { name: 'synthetic_job_completion', namespace: null, output: JSON.stringify({ ...job, receipt: 'COMPLETE-42', instruction: 'Report the receipt and get sprite_probe.get_image asset=2 to confirm the completed task output.' }) } });
  report.checks.taskContinuation = { submitted, completion, submissionCalls: submissionCalls.length, passed: completion.status === 'completed' && completion.answer.includes('COMPLETE-42') };
  console.log('Task continuation:', report.checks.taskContinuation.passed); save();
  const history = await server.request('thread/read', { threadId, includeTurns: true });
  report.checks.historyRead = { turnCount: history.thread.turns.length, passed: history.thread.turns.some((item: any) => item.id === completion.turnId) };
  save();
} catch (error) { report.error = String(error); report.stderrTail = server.stderrTail.slice(-1500); save(); console.error(report.error); process.exitCode = 1; }
finally { await server.close(); }
console.log(JSON.stringify(report, null, 2));
if (Object.values(report.checks).some((check: any) => check.passed === false)) process.exitCode = 1;
