import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { WorkspaceService } from '../src/workspace.mjs';

const store = config => ({ transaction: async callback => callback({ connections: { native: config } }) });
const row = cwd => ({ workspaceId: 'native:id.with.dots', path: cwd, title: '工作区', sessionIds: ['session:1'], cookie: 'private', createdAt: 'now' });
const frame = items => ({ type: 'baseline', value: { items, archivedSessionIds: [], pinnedSessionIds: [] } });
const view = item => ({ workspaceId: item.workspaceId, path: item.path, title: item.title, sessionIds: item.sessionIds });

async function directories(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-workspace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), other = path.join(root, 'other');
  await fs.mkdir(cwd); await fs.mkdir(other);
  return { cwd: await fs.realpath(cwd), other: await fs.realpath(other) };
}

function fakeService(item, options = {}) {
  const calls = []; let closes = 0;
  const client = {
    rpc: async (method, args) => { calls.push({ method, args }); return options.result ?? { workspace: item, created: true }; },
    stream: (endpoint, args, callbacks) => {
      calls.push({ endpoint, args });
      const handle = { ready: options.ready ?? Promise.resolve(), closed: new Promise(() => {}), close: () => { closes++; } };
      if (options.deliver) options.deliver(callbacks);
      else callbacks.onItem(frame(options.items ?? [item]));
      return handle;
    },
  };
  return { service: new WorkspaceService({ store: store({ cookie: 'private' }), clientFactory: () => client, timeoutMs: 25 }), calls, closes: () => closes };
}

test('workspace/create uses canonical path and reads native follow baseline; projects only public fields', async t => {
  const { cwd } = await directories(t), item = row(cwd);
  const { service, calls, closes } = fakeService(item);
  assert.deepEqual(await service.create({ connection: 'native', cwd: path.join(cwd, '..', 'project') + path.sep }), { workspace: view(item), created: true });
  assert.deepEqual(calls, [
    { method: 'workspace/create', args: { request: { path: cwd } } },
    { endpoint: 'workspace/follow', args: {} },
  ]);
  assert.equal(closes(), 1);
});

test('get matches opaque native IDs exactly and unknown workspace fails without mutation', async t => {
  const { cwd } = await directories(t), item = row(cwd);
  const { service, calls } = fakeService(item);
  assert.deepEqual(await service.get({ connection: 'native', workspaceId: item.workspaceId }), view(item));
  await assert.rejects(service.get({ connection: 'native', workspaceId: 'native:id' }), { code: 'WORKSPACE_NOT_FOUND' });
  await assert.rejects(service.get({ connection: 'native', workspaceId: '' }), { code: 'INVALID_WORKSPACE_ID' });
  assert.ok(calls.every(call => call.endpoint === 'workspace/follow'));
});

test('create rejects unavailable/non-directory/relative cwd before any native call', async t => {
  const { cwd } = await directories(t), { service, calls } = fakeService(row(cwd));
  await fs.writeFile(path.join(cwd, 'file'), 'fixture');
  for (const [input, code] of [['relative', 'ABSOLUTE_CWD_REQUIRED'], [path.join(cwd, 'missing'), 'CWD_UNRESOLVABLE'], [path.join(cwd, 'file'), 'CWD_UNRESOLVABLE']]) {
    await assert.rejects(service.create({ connection: 'native', cwd: input }), { code });
  }
  assert.deepEqual(calls, []);
});

test('create rejects wrong RPC path, wrong readback path and missing readback without retrying', async t => {
  const { cwd, other } = await directories(t), item = row(cwd);
  for (const options of [{ result: { workspace: row(other), created: true } }, { items: [row(other)] }, { items: [] }]) {
    const { service, calls } = fakeService(item, options);
    await assert.rejects(service.create({ connection: 'native', cwd }), { code: options.items?.length === 0 ? 'WORKSPACE_NOT_FOUND' : 'WORKSPACE_CWD_MISMATCH' });
    assert.equal(calls.filter(call => call.method === 'workspace/create').length, 1);
    assert.ok(calls.every(call => call.method !== 'session/prompt'));
  }
});

test('list handles synchronous baseline before handle assignment and still requires ready', async t => {
  const { cwd } = await directories(t), item = row(cwd);
  const { service, closes } = fakeService(item, { ready: Promise.reject(Object.assign(new Error('ready'), { code: 'STREAM_SEND_UNKNOWN' })) });
  await assert.rejects(service.list({ connection: 'native' }), { code: 'STREAM_SEND_UNKNOWN' });
  assert.equal(closes(), 1);
  const pendingReady = fakeService(item, { ready: new Promise(() => {}) });
  await assert.rejects(pendingReady.service.list({ connection: 'native' }), { code: 'WORKSPACE_OPEN_TIMEOUT' });
  assert.equal(pendingReady.closes(), 1);
});

test('list reports timeout, close and errors before/after ready and closes every handle', async t => {
  const { cwd } = await directories(t);
  for (const [deliver, code] of [
    [() => {}, 'WORKSPACE_OPEN_TIMEOUT'],
    [callbacks => callbacks.onClose(), 'WORKSPACE_NO_BASELINE'],
    [callbacks => queueMicrotask(() => callbacks.onError(Object.assign(new Error('closed'), { code: 'STREAM_DISCONNECTED' }))), 'STREAM_DISCONNECTED'],
  ]) {
    const { service, closes } = fakeService(row(cwd), { deliver });
    await assert.rejects(service.list({ connection: 'native' }), { code });
    assert.equal(closes(), 1);
  }
  const earlyClose = fakeService(row(cwd), { ready: new Promise(() => {}), deliver: callbacks => { callbacks.onItem(frame([row(cwd)])); callbacks.onClose(); } });
  await assert.rejects(earlyClose.service.list({ connection: 'native' }), { code: 'WORKSPACE_NO_BASELINE' });
});

test('list rejects malformed or duplicate baseline safely; empty baseline is valid', async t => {
  const { cwd } = await directories(t), item = row(cwd);
  for (const invalid of [{ type: 'upsert', workspace: item }, { type: 'baseline', value: { items: [item] } }, frame([{ ...item, sessionIds: [null] }]), frame([item, item])]) {
    const { service, closes } = fakeService(item, { deliver: callbacks => callbacks.onItem(invalid) });
    await assert.rejects(service.list({ connection: 'native' }), { code: 'WORKSPACE_PROTOCOL_UNKNOWN' });
    assert.equal(closes(), 1);
  }
  assert.deepEqual(await fakeService(item, { items: [] }).service.list({ connection: 'native' }), []);
});

test('real NativeClient follows native frame schema and cancels after baseline with zero prompts', async t => {
  const { cwd } = await directories(t), item = row(cwd), requests = [];
  const server = http.createServer((request, response) => { requests.push(request.url); response.writeHead(404); response.end(); });
  const wss = new WebSocketServer({ server });
  let cancellation;
  const cancelled = new Promise(resolve => { cancellation = resolve; });
  wss.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString()); requests.push(message);
    if (message.type === 'cancel') return cancellation();
    assert.equal(message.endpoint, 'workspace/follow');
    assert.deepEqual(message.payload.args, {});
    socket.send(JSON.stringify({ type: 'item', streamId: message.streamId, value: frame([item]) }));
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of wss.clients) socket.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const service = new WorkspaceService({ store: store({ baseUrl: `http://127.0.0.1:${server.address().port}`, cookie: 'fixture-cookie' }), timeoutMs: 1000 });
  assert.deepEqual(await service.list({ connection: 'native' }), [view(item)]);
  await cancelled;
  assert.equal(requests.filter(item => item.type === 'open').length, 1);
  assert.equal(requests.filter(item => item.type === 'cancel').length, 1);
});

test('missing connection fails before opening native streams', async () => {
  const service = new WorkspaceService({ store: store({}), clientFactory: () => { throw new Error('must not construct'); } });
  await assert.rejects(service.list({ connection: 'missing' }), { code: 'CONNECTION_NOT_FOUND' });
});
