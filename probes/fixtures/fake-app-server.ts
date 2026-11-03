import { createInterface } from 'node:readline';
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'synthetic' } });
  else if (message.method === 'echo') setTimeout(() => send({ id: message.id, result: message.params.value }), message.params.delay ?? 0);
  else if (message.method === 'reject') send({ id: message.id, error: { code: -32602, message: 'Synthetic invalid params' } });
  else if (message.method === 'complete') {
    send({ method: 'turn/completed', params: { turn: { id: 'synthetic-turn', status: 'completed' } } });
    send({ id: message.id, result: {} });
  } else if (message.method === 'malformed') process.stdout.write('not json\n');
  // Other requests intentionally never reply, for timeout/shutdown checks.
});
