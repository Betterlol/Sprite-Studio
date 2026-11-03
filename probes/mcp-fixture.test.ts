import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

test('MCP fixture rejects traversal, alternate paths, overwrite and linked input', async () => {
  const base = mkdtempSync(join(tmpdir(), 'sprite-probe-test-'));
  const project = join(base, 'project');
  mkdirSync(join(project, 'Assets'), { recursive: true });
  mkdirSync(join(project, 'Scratch'));
  writeFileSync(join(project, 'Assets', 'asset-1.png'), 'synthetic-image-bytes');
  const child = spawn(process.execPath, [resolve('probes/mcp-fixture.ts'), project], { stdio: 'pipe', windowsHide: true });
  const responses = new Map<number, (value: any) => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const result = JSON.parse(line); responses.get(result.id)?.(result.result); });
  let id = 0;
  const call = (tool: string, args: unknown): Promise<any> => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error('MCP fixture timed out')), 3000);
    responses.set(requestId, result => { clearTimeout(timer); responses.delete(requestId); resolve(result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n');
  });
  try {
    assert.equal((await call('get_image', { asset: 1 })).content[0].type, 'image');
    for (const filename of ['../Assets/escape.txt', 'C:\\escape.txt', 'a.txt:stream', 'folder/file.txt']) assert.equal((await call('write_note', { filename, text: 'blocked' })).isError, true);
    assert.equal((await call('get_image', { asset: '../outside' })).isError, true);
    assert.equal((await call('write_note', { filename: 'valid.txt', text: 'first' })).isError, undefined);
    assert.equal((await call('write_note', { filename: 'valid.txt', text: 'overwrite' })).isError, true);
    assert.equal(readFileSync(join(project, 'Scratch', 'valid.txt'), 'utf8'), 'first');
    assert.equal(existsSync(join(project, 'Assets', 'escape.txt')), false);
    mkdirSync(join(base, 'outside'));
    writeFileSync(join(base, 'outside', 'asset-2.png'), 'outside');
    // Directory junctions on Windows do not require symlink developer mode.
    renameSync(join(project, 'Assets'), join(project, 'Assets-original'));
    symlinkSync(join(base, 'outside'), join(project, 'Assets'), process.platform === 'win32' ? 'junction' : 'dir');
    const inventory = await call('get_image', { asset: 2 });
    assert.equal(inventory.isError, true);
    renameSync(join(project, 'Scratch'), join(project, 'Scratch-original'));
    symlinkSync(join(base, 'outside'), join(project, 'Scratch'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await call('write_note', { filename: 'redirected.txt', text: 'blocked' })).isError, true);
    assert.equal(existsSync(join(base, 'outside', 'redirected.txt')), false);
  } finally { child.stdin.end(); await new Promise<void>(resolve => child.once('exit', () => resolve())); }
});
