import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';
import { Controller } from '../src/controller.mjs';
import { runCli } from '../src/cli.mjs';

async function fixture(t, { shared = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dsh-controller-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await StateStore.open(path.join(root, 'state'));
  const events = [], calls = [], streams = new Map();
  let failure, queue = [], running = false;
  const client = {
    async rpc(method, args) {
      calls.push({ method, args });
      if (method === 'session/projections') return { values: { inbox: { 'next-turn': queue, 'next-step': [] } } };
      if (method === 'session/list') return { items: [{ sessionId: 'native-session', running }] };
      if (method === 'session/prompt' && failure) throw failure;
      return { accepted: true };
    },
    stream(endpoint, args, callbacks) {
      streams.set(endpoint, callbacks);
      queueMicrotask(() => callbacks.onItem(endpoint === '$events' ? { type: 'ready', clientId: 'test-client' } : { type: 'snapshot', header: { id: 'native-session' }, records: events.map(event => ({ type: 'event', event })) }));
      return { ready: Promise.resolve(), closed: Promise.resolve(), close() { callbacks.onClose?.(); } };
    },
  };
  const controller = new Controller({ store, clientFactory: () => client, historyReader: async () => ({ header: { id: 'native-session' }, events: [...events] }) });
  await store.transaction(state => {
    state.connections.local = { baseUrl: 'http://127.0.0.1:9000', cookie: 'secret-fixture' };
    state.tasks.test = { id: 'test', sessionId: 'native-session', connection: 'local', state: 'READY', scope: shared ? 'shared' : 'exclusive', requests: [], approvals: {}, liveSeqs: [] };
  });
  return { root, store, controller, calls, events, streams, fail: value => { failure = value; }, queue: value => { queue = value; }, running: value => { running = value; } };
}
function turn(id, answer = 'answer') { return [
  { seq: 0, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, type: 'user/message', data: { source: { rpcId: id }, id: 'message-one' } },
  { seq: 2, type: 'assistant/message', data: { content: [{ type: 'text', text: answer }] } },
  { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]; }
test('unacknowledged submission persists intent and cannot be blindly retried, including after restart', async t => {
  const f = await fixture(t); f.fail(new Error('secret URL must not escape'));
  const result = await f.controller.send({ task: 'test', text: 'private input', allowModel: true });
  assert.equal(result.state, 'SUBMISSION_UNKNOWN');
  const request = (await f.store.task('test')).requests[0];
  assert.equal(await fs.readFile(request.inputFile, 'utf8'), 'private input');
  await assert.rejects(f.controller.send({ task: 'test', text: 'retry', allowModel: true }), { code: 'UNRESOLVED_REQUEST' });
  assert.equal(f.calls.filter(c => c.method === 'session/prompt').length, 1);
  await f.store.transaction(state => { state.tasks.test.requests[0].state = 'SUBMITTING'; });
  assert.equal((await f.controller.resume({ task: 'test' })).state, 'SUBMISSION_UNKNOWN');
});
test('unrelated completed turn does not complete request; correlated full answer is preserved', async t => {
  const f = await fixture(t);
  await f.controller.send({ task: 'test', text: 'input', allowModel: true });
  f.events.push(...turn('someone-else'));
  assert.equal((await f.controller.status({ task: 'test' })).state, 'SUBMITTED');
  const id = (await f.store.task('test')).requests[0].requestId;
  const answer = '完整答复'.repeat(400000);
  f.events.splice(0, f.events.length, ...turn(id, answer));
  const result = await f.controller.status({ task: 'test' });
  assert.equal(result.state, 'COMPLETED');
  assert.equal(await fs.readFile(result.requests[0].resultFile, 'utf8'), answer);
  assert.ok(!JSON.stringify(result).includes('完整答复'));
});
test('known native rejection allows a later explicit request and requires authorization every time', async t => {
  const f = await fixture(t);
  await assert.rejects(f.controller.send({ task: 'test', text: 'input' }), { code: 'MODEL_PERMISSION_REQUIRED' });
  f.fail(Object.assign(new Error('native rejection'), { knownRejected: true }));
  await assert.rejects(f.controller.send({ task: 'test', text: 'input', allowModel: true }), { code: 'NATIVE_REJECTED' });
  assert.equal((await f.store.task('test')).requests[0].state, 'REJECTED');
  f.fail(undefined);
  await f.controller.send({ task: 'test', text: 'new authorized input', allowModel: true });
  assert.equal(f.calls.filter(c => c.method === 'session/prompt').length, 2);
});
test('resume reconciles uncertain session creation without creating or prompting again', async t => {
  const f = await fixture(t);
  await f.store.transaction(state => { state.tasks.test.state = 'CREATE_UNKNOWN'; });
  assert.equal((await f.controller.resume({ task: 'test' })).state, 'READY');
  assert.equal(f.calls.filter(c => ['session/create', 'session/prompt'].includes(c.method)).length, 0);
});
test('connection aliases cannot attach a second controller task to the same native session', async t => {
  const f = await fixture(t);
  await f.store.transaction(state => { state.connections.alias = { ...state.connections.local }; });
  await assert.rejects(f.controller.start({ task: 'second', connection: 'alias', session: 'native-session', cwd: f.root }), { code: 'SESSION_ALREADY_ATTACHED' });
  assert.equal(f.calls.filter(c => c.method === 'session/create').length, 0);
});
test('an older concurrent status snapshot cannot regress cursor or completed request', async t => {
  const f = await fixture(t);
  await f.controller.send({ task: 'test', text: 'input', allowModel: true });
  const id = (await f.store.task('test')).requests[0].requestId;
  await f.controller.apply('test', turn(id));
  const stale = await f.controller.apply('test', turn(id).slice(0, 3));
  assert.equal(stale.state, 'COMPLETED'); assert.equal(stale.cursor, 3);
});
test('exclusive idle session with observed tool activity cannot be reported fully stopped', async t => {
  const f = await fixture(t);
  await f.controller.send({ task: 'test', text: 'input', allowModel: true });
  const id = (await f.store.task('test')).requests[0].requestId;
  f.events.push(...turn(id).slice(0, 2),
    { seq: 2, type: 'tool/call', data: { name: 'schedule_create', callId: 'schedule-one' } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  const result = await f.controller.stop({ task: 'test' });
  assert.equal(result.state, 'STOP_PENDING');
  assert.equal(f.calls.filter(c => c.method === 'session/cancel').length, 1);
  assert.equal(f.calls.filter(c => /archive|schedule.*(remove|delete)/.test(c.method)).length, 0);
});
test('missing native queue projection is unknown rather than proof of an empty queue', async t => {
  const f = await fixture(t), client = await f.controller.client(await f.store.task('test'));
  const rpc = client.rpc.bind(client);
  client.rpc = (method, args) => method === 'session/projections' ? Promise.resolve({ values: {} }) : rpc(method, args);
  assert.equal((await f.controller.stop({ task: 'test' })).state, 'STOP_PENDING');
});
test('wait establishes both streams before prompt; timeout does not cancel', async t => {
  const f = await fixture(t);
  const result = await f.controller.send({ task: 'test', text: 'input', allowModel: true, wait: 0.03 });
  assert.equal(f.streams.size, 2);
  assert.equal(result.observationTimedOut, true);
  assert.equal(f.calls.filter(c => c.method === 'session/cancel').length, 0);
});
test('shared stop removes only owned queue and never cancels another session turn', async t => {
  const f = await fixture(t, { shared: true });
  await f.controller.send({ task: 'test', text: 'input', allowModel: true });
  const id = (await f.store.task('test')).requests[0].requestId;
  f.queue([{ id: 'ours', source: { rpcId: id } }, { id: 'theirs', source: { rpcId: 'foreign' } }]);
  const result = await f.controller.stop({ task: 'test' });
  assert.equal(result.state, 'STOP_PENDING');
  assert.deepEqual(f.calls.filter(c => c.method === 'session/updateQueue').map(c => c.args.request.itemId), ['ours']);
  assert.equal(f.calls.filter(c => c.method === 'session/cancel').length, 0);
  await assert.rejects(f.controller.send({ task: 'test', text: 'later', allowModel: true }), { code: 'TASK_STOPPED' });
});
test('stop serializes with dispatch across controller instances and blocks a gated unsent intent', async t => {
  const f = await fixture(t, { shared: true });
  const original = f.controller.client.bind(f.controller);
  let release, entered, gated = false;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  f.controller.client = async task => {
    const client = await original(task);
    if (!gated && task.requests.at(-1)?.state === 'SUBMITTING') { gated = true; entered(); await gate; }
    return client;
  };
  const sending = f.controller.send({ task: 'test', text: 'input', allowModel: true });
  const rejection = assert.rejects(sending, { code: 'TASK_STOPPED' });
  await reached;
  const second = new Controller({ store: await StateStore.open(f.store.directory), clientFactory: asyncConfig => original({ connection: 'local' }), historyReader: f.controller.historyReader });
  let stopped = false;
  const stopping = second.stop({ task: 'test' }).then(value => { stopped = true; return value; });
  const deadline = Date.now() + 3000;
  while (!(await f.store.task('test')).stopRequested && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await f.store.task('test')).stopRequested, true);
  assert.equal(stopped, false);
  release(); await rejection;
  assert.equal((await stopping).state, 'STOP_PENDING');
  assert.equal(f.calls.filter(c => c.method === 'session/prompt').length, 0);
  assert.equal((await f.store.task('test')).requests[0].state, 'REJECTED');
});
test('approval is session and known-call scoped, expires on watch close, never autoallows', async t => {
  const f = await fixture(t);
  await f.controller.send({ task: 'test', text: 'input', allowModel: true });
  const id = (await f.store.task('test')).requests[0].requestId;
  f.events.push(...turn(id).slice(0, 2), { seq: 2, type: 'tool/call', data: { name: 'write', callId: 'known' } });
  const watcher = await f.controller.watch('test');
  f.streams.get('$events').onItem({ type: 'waterfall', eventId: 'other', event: 'approval/request', agentId: 'other-session', request: { callId: 'known' } });
  f.streams.get('$events').onItem({ type: 'waterfall', eventId: 'ours', event: 'approval/request', agentId: 'native-session', request: { callId: 'known', reason: 'write requested', path: '/fixture/output.txt' } });
  await watcher.tick();
  assert.equal(f.calls.find(c => c.method === '$events/result').args.outcome.kind, 'next');
  assert.equal((await f.controller.approvals({ task: 'test' })).approvals[0].eventId, 'ours');
  assert.equal((await f.controller.approvals({ task: 'test' })).approvals[0].operation.path, '/fixture/output.txt');
  await f.controller.approve({ task: 'test', approval: 'ours', decision: 'allowed-once' });
  await watcher.tick();
  assert.deepEqual(f.calls.at(-1).args.outcome, { kind: 'result', value: 'allowed-once' });
  assert.equal((await f.store.task('test')).approvals.ours.state, 'RESULT_SENT_UNCONFIRMED');
  f.streams.get('$events').onItem({ type: 'waterfall', eventId: 'expiring', event: 'approval/request', agentId: 'native-session', request: { callId: 'known' } });
  await watcher.tick(); await watcher.close();
  await assert.rejects(f.controller.approve({ task: 'test', approval: 'expiring', decision: 'rejected' }), { code: 'APPROVAL_EXPIRED' });
});
test('CLI rejects missing authorization without leaking input or credentials', async t => {
  const f = await fixture(t); let output = '';
  const code = await runCli(['send', '--task', 'test', '--text-file', 'secret-not-read', '--state-dir', f.store.directory], { stdout: { write: x => { output += x; } }, stderr: { write: x => { output += x; } } });
  assert.equal(code, 2); assert.match(output, /MODEL_PERMISSION_REQUIRED/); assert.ok(!output.includes('secret-fixture'));
});
