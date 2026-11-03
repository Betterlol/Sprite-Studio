import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: any };

// Resolve the installed CLI without a shell, including npm's Windows shim.
export function codexCommand(): { executable: string; prefix: string[] } {
  if (process.env.CODEX_EXECUTABLE) return { executable: resolve(process.env.CODEX_EXECUTABLE), prefix: [] };
  const located = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], { encoding: 'utf8', windowsHide: true });
  if (located.status !== 0) throw new Error('Codex CLI was not found; set CODEX_EXECUTABLE to its executable.');
  for (const candidate of located.stdout.trim().split(/\r?\n/)) {
    if (candidate.endsWith('.exe') || process.platform !== 'win32') return { executable: candidate, prefix: [] };
    const entry = join(dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(entry)) return { executable: process.execPath, prefix: [entry] };
  }
  throw new Error('Unsupported CLI installation; set CODEX_EXECUTABLE to its executable.');
}

export class AppServer extends EventEmitter {
  child: ChildProcessWithoutNullStreams;
  nextId = 1;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  completed = new Map<string, any>();
  notifications: Message[] = [];
  stderrTail = '';
  closed = false;
  serverRequest: (message: Message) => Promise<any> = async () => ({ decision: 'decline' });

  constructor(cwd: string, overrides: string[] = [], isolateMcp = true, launch?: { executable: string; prefix: string[] }) {
    super();
    const command = launch ?? codexCommand();
    const isolatedConfig = fileURLToPath(new URL('../.local/mcp-names.json', import.meta.url));
    if (isolateMcp && !existsSync(isolatedConfig)) throw new Error('Run the inspect probe before model probes to inventory and disable inherited MCP servers.');
    const disabled: string[] = isolateMcp && existsSync(isolatedConfig) ? JSON.parse(readFileSync(isolatedConfig, 'utf8')) : [];
    if (disabled.some(name => !/^[\w-]+$/.test(name))) throw new Error('Unsupported MCP name in probe isolation overrides');
    const args = [...command.prefix, 'app-server', '--stdio', '--disable', 'hooks', '--disable', 'memories', '--disable', 'multi_agent', '--disable', 'plugins', '--disable', 'apps', '-c', 'project_doc_max_bytes=0', ...disabled.map(name => `mcp_servers.${name}.enabled=false`).concat(overrides).flatMap(value => ['-c', value])];
    // Do not inherit the parent desktop's tool pipe, originator or thread permissions.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CODEX_') || key === 'CODEX_HOME'));
    this.child = spawn(command.executable, args, { cwd, env, stdio: 'pipe', windowsHide: true });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      let message: Message;
      try { message = JSON.parse(line); } catch { this.fail(new Error('Non-JSON data on App Server stdout')); return; }
      if (message.method && message.id !== undefined) {
        this.serverRequest(message).then(result => this.send({ id: message.id, result })).catch(() => this.send({ id: message.id, error: { code: -32000, message: 'Probe rejected the server request' } }));
      } else if (message.id !== undefined) {
        const pending = this.pending.get(Number(message.id));
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(Number(message.id));
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else {
        this.notifications.push(message);
        if (this.notifications.length > 4000) this.notifications.shift();
        if (message.method === 'turn/completed') this.completed.set(message.params.turn.id, message.params.turn);
        this.emit('notification', message);
      }
    });
    this.child.stderr.on('data', bytes => { this.stderrTail = (this.stderrTail + bytes.toString()).slice(-6000); });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', code => { this.closed = true; this.fail(new Error(`App Server exited (${code})`)); });
  }

  private fail(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('stopped', error);
  }

  send(message: Message) {
    if (this.closed || this.child.stdin.destroyed) throw new Error('App Server is closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method: string, params: any = {}, timeoutMs = 45_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async initialize() {
    const result = await this.request('initialize', { clientInfo: { name: 'sprite_studio_probe', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.send({ method: 'initialized', params: {} });
    return result;
  }

  waitTurn(turnId: string, timeoutMs = 180_000): Promise<any> {
    if (this.completed.has(turnId)) return Promise.resolve(this.completed.get(turnId));
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: any) => { clearTimeout(timer); this.off('notification', onEvent); this.off('stopped', onStop); error ? reject(error) : resolve(value); };
      const onEvent = (message: Message) => { if (message.method === 'turn/completed' && message.params.turn.id === turnId) finish(undefined, message.params.turn); };
      const onStop = (error: Error) => finish(error);
      const timer = setTimeout(() => finish(new Error(`turn ${turnId} timed out`)), timeoutMs);
      this.on('notification', onEvent);
      this.on('stopped', onStop);
    });
  }

  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    await new Promise(resolve => setTimeout(resolve, 700));
    if (!this.closed && this.child.pid) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else this.child.kill('SIGTERM');
    }
  }
}

export function assistantText(server: AppServer, turnId: string): string {
  const messages = server.notifications.filter(message => message.method === 'item/completed' && message.params.turnId === turnId && message.params.item.type === 'agentMessage');
  const final = messages.filter(message => message.params.item.phase === 'final_answer');
  const legacy = messages.filter(message => message.params.item.phase !== 'commentary');
  return (final.length ? final : legacy).map(message => message.params.item.text).join('\n');
}
