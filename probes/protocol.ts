import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { codexCommand } from './client.ts';

const command = codexCommand();
mkdirSync('.local', { recursive: true });
for (const [method, out] of [['generate-ts', '.local/protocol'], ['generate-json-schema', '.local/schema']]) {
  const result = spawnSync(command.executable, [...command.prefix, 'app-server', method!, '--experimental', '--out', out!], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
