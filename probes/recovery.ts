import { readFileSync, writeFileSync } from 'node:fs';
import { AppServer, assistantText, type Message } from './client.ts';
import { project, fixtureOverrides } from './settings.ts';

const previous = JSON.parse(readFileSync('.local/reports/live.json', 'utf8'));
if (!previous.checks.taskContinuation?.passed) throw new Error('Complete the live probe before recovery checks.');
const server = new AppServer(project, fixtureOverrides);
const report: any = { observedAt: new Date().toISOString(), checks: {}, threadId: previous.threadId, serverRequests: [] };
const save = () => writeFileSync('.local/reports/recovery.json', JSON.stringify(report, null, 2) + '\n');
server.serverRequest = async message => {
  report.serverRequests.push({ method: message.method }); save();
  if (message.method === 'mcpServer/elicitation/request' && message.params.serverName === 'sprite_probe') return { action: 'accept', content: { choice: 'keep' } };
  return { decision: 'decline' };
};
const input = (value: string) => [{ type: 'text', text: value, text_elements: [] }];
try {
  await server.initialize();
  await server.request('thread/resume', { threadId: previous.threadId, cwd: project, sandbox: 'read-only', approvalPolicy: 'on-request', excludeTurns: true });
  const turns = await server.request('thread/turns/list', { threadId: previous.threadId, limit: 100, itemsView: 'notLoaded' });
  report.checks.resume = { foundTurnIds: turns.data.map((turn: any) => turn.id), passed: turns.data.some((turn: any) => turn.id === previous.checks.taskContinuation.completion.turnId) };
  console.log('Resume after process restart:', report.checks.resume.passed); save();
  const context = await server.request('turn/start', { threadId: previous.threadId, effort: 'low', input: input('Without calling any tool or resubmitting any task, report the receipt from the last synthetic job completion.') });
  await server.waitTurn(context.turn.id);
  const answer = assistantText(server, context.turn.id);
  report.checks.context = { answer, passed: answer.includes('COMPLETE-42') };
  console.log('Restored context:', report.checks.context.passed); save();
  const choice = await server.request('turn/start', { threadId: previous.threadId, effort: 'low', input: input('Call sprite_probe.ask_choice exactly once, let the host handle the diagnostic form, and report the returned choice.') });
  await server.waitTurn(choice.turn.id);
  const choiceAnswer = assistantText(server, choice.turn.id);
  report.checks.form = { answer: choiceAnswer, passed: choiceAnswer.includes('keep') && report.serverRequests.some((request: any) => request.method === 'mcpServer/elicitation/request') };
  console.log('Host form:', report.checks.form.passed); save();
  // Detach the simulated UI observer while the host retains its App Server process.
  let uiObserved = 0;
  const uiListener = () => { uiObserved++; };
  server.on('notification', uiListener);
  const waiting = await server.request('turn/start', { threadId: previous.threadId, effort: 'low', input: input('Call sprite_probe.hold exactly once. Wait for its result, then report it. This is a synthetic cancellation test.') });
  server.off('notification', uiListener);
  const holdStarted = await new Promise<boolean>(resolve => {
    const listener = (message: Message) => { if (message.method === 'item/started' && message.params.turnId === waiting.turn.id && message.params.item.type === 'mcpToolCall' && message.params.item.tool === 'hold') finish(true); };
    const finish = (value: boolean) => { clearTimeout(timer); server.off('notification', listener); resolve(value); };
    const timer = setTimeout(() => finish(false), 20000);
    server.on('notification', listener);
    if (server.notifications.some(message => message.method === 'item/started' && message.params.turnId === waiting.turn.id && message.params.item.tool === 'hold')) finish(true);
  });
  if (!holdStarted) throw new Error('No active hold tool call was observed');
  const metadata = await server.request('thread/read', { threadId: previous.threadId, includeTurns: false });
  report.checks.detachedObserver = { threadStatus: metadata.thread.status, observedBeforeDetach: uiObserved, note: 'Host process retained; no second turn was submitted while the simulated UI observer was detached.' };
  await server.request('turn/interrupt', { threadId: previous.threadId, turnId: waiting.turn.id });
  const interrupted = await server.waitTurn(waiting.turn.id, 30000);
  report.checks.interrupt = { status: interrupted.status, holdStarted, passed: interrupted.status === 'interrupted' };
  console.log('Active tool interruption:', report.checks.interrupt.passed); save();
  const after = await server.request('thread/turns/list', { threadId: previous.threadId, limit: 100, itemsView: 'notLoaded' });
  report.checks.reconnectWithoutResubmit = { matchingTurns: after.data.filter((turn: any) => turn.id === waiting.turn.id).length, passed: after.data.filter((turn: any) => turn.id === waiting.turn.id).length === 1 };
  save();
} catch (error) { report.error = String(error); save(); console.error(report.error); process.exitCode = 1; }
finally { await server.close(); }
console.log(JSON.stringify(report, null, 2));
if (Object.values(report.checks).some((check: any) => check.passed === false)) process.exitCode = 1;
