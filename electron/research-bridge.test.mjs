import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startResearchBridge, createRendererResearchRequests } from './research-bridge.mjs';
import { callResearchTool, RESEARCH_DESCRIPTOR } from './research-bridge-client.mjs';

async function fixture(t, callTool) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'pc-bridge-test-'));
  const bridge = await startResearchBridge({ dataDirectory, callTool });
  t.after(async () => { await bridge.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  return dataDirectory;
}

test('connecting does not read context and imports return only their own result', async t => {
  const calls = [];
  const dataDirectory = await fixture(t, async (tool, args) => { calls.push({ tool, args }); return { batchId: 'new', createdNodes: 2 }; });
  assert.equal(calls.length, 0);
  const args = { requestId: 'one', title: 'Independent', papers: [] };
  assert.deepEqual(await callResearchTool('import_research_batch', args, { dataDirectory }), { batchId: 'new', createdNodes: 2 });
  assert.deepEqual(calls, [{ tool: 'import_research_batch', args }]);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(dataDirectory, RESEARCH_DESCRIPTOR))).mode & 0o777, 0o600);
});

test('authentication, tool allowlist and explicit context scope are enforced before dispatch', async t => {
  let calls = 0;
  const dataDirectory = await fixture(t, async () => { calls++; return {}; });
  await assert.rejects(callResearchTool('database_execute', {}, { dataDirectory }), /Unknown research tool/);
  await assert.rejects(callResearchTool('read_research_context', { intent: 'independent' }, { dataDirectory }), /explicit/);
  const descriptor = JSON.parse(await readFile(path.join(dataDirectory, RESEARCH_DESCRIPTOR), 'utf8'));
  const denied = await new Promise((resolve, reject) => {
    const socket = connect(descriptor.socket, () => socket.write(`${JSON.stringify({ token: 'wrong', tool: 'import_research_batch', args: {} })}\n`));
    socket.on('error', reject);
    socket.once('data', data => { resolve(JSON.parse(data.toString())); socket.destroy(); });
  });
  assert.match(denied.error, /Unauthorized/);
  assert.equal(calls, 0);
});

test('explicit scoped context is forwarded intact; local app errors never broaden or retry it', async t => {
  const calls = [];
  const dataDirectory = await fixture(t, async (tool, args) => { calls.push({ tool, args }); throw new Error('NO_SELECTION'); });
  await assert.rejects(callResearchTool('read_research_context', { intent: 'selected_papers' }, { dataDirectory }), /NO_SELECTION/);
  assert.deepEqual(calls, [{ tool: 'read_research_context', args: { intent: 'selected_papers' } }]);
});

test('desktop requests wait for readiness and reject pending calls on reload', async () => {
  const sent = [];
  const requests = createRendererResearchRequests((event, payload) => sent.push({ event, payload }));
  await assert.rejects(requests.request('import_research_batch', {}), /APP_NOT_READY/);
  requests.setReady(true);
  const imported = requests.request('import_research_batch', { requestId: 'one' });
  requests.reply({ id: 'not-the-request', result: { secret: true } });
  requests.reply({ id: sent[0].payload.id, result: { batchId: 'one' } });
  assert.deepEqual(await imported, { batchId: 'one' });
  const pending = requests.request('read_research_context', { intent: 'gap_analysis' });
  requests.reset();
  await assert.rejects(pending, /APP_RELOADING/);
  assert.equal(sent.length, 2);
});

test('missing app profile gives a useful connection error', async () => {
  await assert.rejects(callResearchTool('import_research_batch', {}, { dataDirectory: path.join(tmpdir(), 'pc-does-not-exist') }), /APP_NOT_RUNNING/);
});
