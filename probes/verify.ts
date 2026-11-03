import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppServer } from './client.ts';

const mode = process.argv[2] ?? 'inspect';
if (mode === '--help' || mode === '-h') {
  console.log('Diagnostic probes only; no platform server is implemented.\nSetup: npm ci; npm run protocol; python -m pip install -r requirements-probes.txt; npm run fixtures\nChecks: npm run typecheck; npm test\nModes: npm run verify -- inspect|live|recovery|permissions|generation|summary\nRun inspect before model probes to disable inherited user MCP servers.\nGeneration makes one real reference-image request and refuses an automatic repeat while its attempt record exists.\nResults and generated protocol bindings are local under .local/.\nFailed capability checks return a nonzero exit code; summary combines the recorded evidence without additional model calls.');
  process.exit(0);
}
if (mode === 'live') { await import('./live.ts'); process.exit(process.exitCode ?? 0); }
if (mode === 'permissions') { await import('./permissions.ts'); process.exit(process.exitCode ?? 0); }
if (mode === 'generation') { await import('./generation.ts'); process.exit(process.exitCode ?? 0); }
if (mode === 'recovery') { await import('./recovery.ts'); process.exit(process.exitCode ?? 0); }
if (mode === 'summary') { await import('./summary.ts'); process.exit(process.exitCode ?? 0); }
if (mode !== 'inspect') throw new Error('Supported modes: inspect, live, permissions, generation, recovery, summary');
mkdirSync('.local/reports', { recursive: true });
const server = new AppServer(resolve('.local'), [], false);
const report: any = { observedAt: new Date().toISOString(), node: process.version, mode };
try {
  const init = await server.initialize();
  report.server = { userAgent: init.userAgent, platformFamily: init.platformFamily, platformOs: init.platformOs };
  const account = await server.request('account/read', { refreshToken: false });
  report.account = { type: account.account?.type ?? null, planType: account.account?.planType ?? null, requiresOpenaiAuth: account.requiresOpenaiAuth };
  const config = await server.request('config/read', { includeLayers: false });
  const mcpNames = Object.keys(config.config?.mcp_servers ?? {});
  writeFileSync('.local/mcp-names.json', JSON.stringify(mcpNames) + '\n');
  report.inheritedMcpNames = mcpNames;
  report.config = { model: config.config?.model, provider: config.config?.model_provider, sandboxMode: config.config?.sandbox_mode, approvalPolicy: config.config?.approval_policy, windows: config.config?.windows };
  const models = await server.request('model/list', { limit: 50 });
  report.models = models.data.map((model: any) => ({ id: model.id, model: model.model, isDefault: model.isDefault, inputModalities: model.inputModalities }));
  for (const method of ['modelProvider/capabilities/read', 'windowsSandbox/readiness', 'configRequirements/read']) {
    try { report[method] = await server.request(method); } catch (error) { report[method] = { error: String(error) }; }
  }
  writeFileSync('.local/reports/inspect.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await server.close(); }
