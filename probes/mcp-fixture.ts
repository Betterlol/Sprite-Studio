import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

const root = realpathSync(process.argv[2]!);
const audit = join(dirname(root), 'mcp-audit.jsonl');
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
const tools = [
  { name: 'get_image', description: 'Return diagnostic asset 1 or 2 as actual image content. Use it to inspect pixels.', inputSchema: { type: 'object', properties: { asset: { type: 'integer', enum: [1, 2] } }, required: ['asset'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'write_note', description: 'Write a plain text note under this project Scratch only; paths outside Scratch are rejected.', inputSchema: { type: 'object', properties: { filename: { type: 'string' }, text: { type: 'string', maxLength: 1000 } }, required: ['filename', 'text'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'submit_job', description: 'Submit one asynchronous synthetic job and return immediately. Do not poll; the host sends completion.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'hold', description: 'Wait twenty seconds before returning a synthetic result. Only for cancellation diagnostics.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'ask_choice', description: 'Ask the host to choose keep or cancel using an MCP form, then return its answer.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
];
const clientRequests = new Map<string, (value: any) => void>();

function call(name: string, args: any) {
  appendFileSync(audit, JSON.stringify({ at: new Date().toISOString(), name, args }) + '\n');
  if (name === 'get_image') {
    if (![1, 2].includes(args.asset)) throw new Error('VALIDATION: asset must be 1 or 2');
    const path = join(root, 'Assets', `asset-${args.asset}.png`);
    if (realpathSync(path) !== path) throw new Error('PERMISSION: linked assets are not accepted by this probe');
    return { content: [{ type: 'image', mimeType: 'image/png', data: readFileSync(path).toString('base64') }] };
  }
  if (name === 'write_note') {
    if (typeof args.filename !== 'string' || !/^[a-zA-Z0-9_-]+\.txt$/.test(args.filename) || typeof args.text !== 'string' || args.text.length > 1000) throw new Error('VALIDATION: only a simple .txt filename and at most 1000 characters are allowed');
    const scratch = realpathSync(join(root, 'Scratch'));
    if (scratch !== join(root, 'Scratch')) throw new Error('PERMISSION: redirected Scratch is not accepted');
    const path = resolve(scratch, args.filename);
    if (!path.startsWith(scratch + sep)) throw new Error('PERMISSION: outside Scratch');
    writeFileSync(path, args.text, { flag: 'wx' });
    return { content: [{ type: 'text', text: JSON.stringify({ written: `Scratch/${args.filename}` }) }] };
  }
  if (name === 'submit_job') {
    const jobId = 'synthetic-job-' + Date.now();
    writeFileSync(join(root, 'Scratch', `${jobId}.json`), JSON.stringify({ jobId, status: 'queued' }));
    return { content: [{ type: 'text', text: JSON.stringify({ jobId, status: 'queued', notice: 'Host will provide completion; finish this turn without polling.' }) }] };
  }
  if (name === 'hold') return new Promise(resolve => setTimeout(() => resolve({ content: [{ type: 'text', text: 'SYNTHETIC-HOLD-COMPLETE' }] }), 20000));
  if (name === 'ask_choice') return new Promise(resolve => {
    const id = 'fixture-choice-' + Date.now();
    const timer = setTimeout(() => { clientRequests.delete(id); resolve({ isError: true, content: [{ type: 'text', text: 'Host form timed out' }] }); }, 15000);
    clientRequests.set(id, result => { clearTimeout(timer); resolve({ content: [{ type: 'text', text: JSON.stringify(result) }] }); });
    send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { message: 'Synthetic diagnostic choice: keep or cancel?', requestedSchema: { type: 'object', properties: { choice: { type: 'string', enum: ['keep', 'cancel'] } }, required: ['choice'] } } });
  });
  throw new Error('VALIDATION: unknown tool');
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let request: any;
  try {
    request = JSON.parse(line);
    if (request.id === undefined) return;
    if (!request.method) { const pending = clientRequests.get(String(request.id)); if (pending) { clientRequests.delete(String(request.id)); pending(request.result ?? request.error); } return; }
    if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'sprite-probe-fixture', version: '0.1.0' } } });
    else if (request.method === 'ping') send({ jsonrpc: '2.0', id: request.id, result: {} });
    else if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools } });
    else if (request.method === 'tools/call') {
      try { Promise.resolve(call(request.params.name, request.params.arguments ?? {})).then(result => send({ jsonrpc: '2.0', id: request.id, result })).catch(error => send({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: String(error) }] } })); }
      catch (error) { send({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: String(error) }] } }); }
    } else if (request.method === 'resources/list' || request.method === 'resources/templates/list') send({ jsonrpc: '2.0', id: request.id, result: request.method === 'resources/list' ? { resources: [] } : { resourceTemplates: [] } });
    else send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
  } catch { if (request?.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32700, message: 'Invalid JSON request' } }); }
});
