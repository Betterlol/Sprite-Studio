import { mkdirSync, realpathSync, symlinkSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AppServer } from './client.ts';

const base = realpathSync('.local');
const project = realpathSync(join(base, 'project'));
const scratch = realpathSync(join(project, 'Scratch'));
const junction = join(project, 'outside-link');
if (!existsSync(junction)) symlinkSync(join(base, 'outside'), junction, process.platform === 'win32' ? 'junction' : 'dir');
// Test a synthetic canary in the real application-state directory, never auth files.
const appStateCanary = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), `sprite-probe-${randomUUID()}.canary`);
writeFileSync(appStateCanary, 'SYNTHETIC-APP-STATE-CANARY', { flag: 'wx' });
const checks = [
  { id: 'projectRead', operation: 'read', path: join(project, 'Assets', 'sentinel.txt'), expectedAllowed: true },
  { id: 'scratchWrite', operation: 'write', path: join(scratch, 'permission-write.txt'), expectedAllowed: true },
  { id: 'assetWrite', operation: 'write', path: join(project, 'Assets', 'permission-write.txt'), expectedAllowed: false },
  { id: 'outsideRead', operation: 'read', path: join(base, 'outside', 'sentinel.txt'), expectedAllowed: false },
  { id: 'otherProjectRead', operation: 'read', path: join(base, 'other-project', 'sentinel.txt'), expectedAllowed: false },
  { id: 'mockCredentialRead', operation: 'read', path: join(base, 'mock-credentials', 'sentinel.txt'), expectedAllowed: false },
  { id: 'appStateCanaryRead', operation: 'read', path: appStateCanary, expectedAllowed: false },
  { id: 'junctionRead', operation: 'read', path: join(junction, 'sentinel.txt'), expectedAllowed: false },
  { id: 'outsideWrite', operation: 'write', path: join(base, 'outside', 'permission-write.txt'), expectedAllowed: false },
];
const code = `const fs=require('node:fs'); const checks=${JSON.stringify(checks)}; const out=checks.map(c=>{try{if(c.operation==='read')fs.readFileSync(c.path);else fs.writeFileSync(c.path,'SYNTHETIC-PERMISSION-CHECK');return {id:c.id,allowed:true,expectedAllowed:c.expectedAllowed}}catch(e){return {id:c.id,allowed:false,expectedAllowed:c.expectedAllowed,errorCode:e.code}}}); console.log(JSON.stringify(out));`;
const filesystem = { ':root': 'deny', ':minimal': 'read', [project.replaceAll('\\', '/')]: 'read', [scratch.replaceAll('\\', '/')]: 'write' };
const tomlMap = '{' + Object.entries(filesystem).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',') + '}';
const report: any = { observedAt: new Date().toISOString(), credentialCheck: 'Synthetic mock directory and a temporary canary under CODEX_HOME only; actual credential files were never read.', variants: {} };
mkdirSync('.local/reports', { recursive: true });

try { for (const variant of ['restricted-profile', 'legacy-workspace']) {
  const overrides = variant === 'restricted-profile' ? ['default_permissions="sprite-probe"', `permissions.sprite-probe.filesystem=${tomlMap}`, 'permissions.sprite-probe.network.enabled=false'] : [];
  // This process never creates a model thread or starts MCP clients.
  const server = new AppServer(project, overrides, false);
  try {
    await server.initialize();
    const params = variant === 'restricted-profile'
      ? { permissionProfile: 'sprite-probe' }
      : { sandboxPolicy: { type: 'workspaceWrite', writableRoots: [scratch], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } };
    const result = await server.request('command/exec', { command: [process.execPath, '-e', code], cwd: scratch, timeoutMs: 20000, ...params }, 30000);
    let results;
    try { results = JSON.parse(result.stdout.trim()); } catch { results = null; }
    report.variants[variant] = { exitCode: result.exitCode, results, stderr: result.stderr, passed: result.exitCode === 0 && results?.every((entry: any) => entry.allowed === entry.expectedAllowed) === true };
  } catch (error) { report.variants[variant] = { error: String(error), stderrTail: server.stderrTail.slice(-2000), passed: false }; }
  finally { await server.close(); }
  writeFileSync('.local/reports/permissions.json', JSON.stringify(report, null, 2) + '\n');
  console.log(variant, JSON.stringify(report.variants[variant]));
} } finally { unlinkSync(appStateCanary); }
if (!report.variants['restricted-profile']?.passed) process.exitCode = 1;
