import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { AppServer } from './client.ts';

function fake() {
  return new AppServer(process.cwd(), [], false, { executable: process.execPath, prefix: [resolve('probes/fixtures/fake-app-server.ts')] });
}

test('JSONL responses correlate by ID even when they arrive out of order', async () => {
  const server = fake();
  try {
    await server.initialize();
    const slow = server.request('echo', { value: 'slow', delay: 40 });
    const fast = server.request('echo', { value: 'fast', delay: 0 });
    assert.deepEqual(await Promise.all([slow, fast]), ['slow', 'fast']);
    assert.equal(server.pending.size, 0);
  } finally { await server.close(); }
});

test('completed turns are retained when notification arrives before wait registration', async () => {
  const server = fake();
  try { await server.initialize(); await server.request('complete'); assert.equal((await server.waitTurn('synthetic-turn', 100)).status, 'completed'); }
  finally { await server.close(); }
});

test('RPC errors and request timeouts settle and release pending calls', async () => {
  const server = fake();
  try {
    await server.initialize();
    await assert.rejects(server.request('reject'), /Synthetic invalid params/);
    await assert.rejects(server.request('no-reply', {}, 30), /timed out/);
    assert.equal(server.pending.size, 0);
  } finally { await server.close(); }
});

test('protocol contamination fails pending requests instead of hanging', async () => {
  const server = fake();
  try { await server.initialize(); await assert.rejects(server.request('malformed'), /Non-JSON/); }
  finally { await server.close(); }
});

test('stopping an owned child rejects outstanding requests', async () => {
  const server = fake();
  await server.initialize();
  const rejected = assert.rejects(server.request('no-reply'), /exited/);
  await server.close();
  await rejected;
});
