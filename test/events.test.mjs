import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSession } from '../src/events.mjs';

const event = (seq, type, data) => ({ seq, type, time: 1, data });
test('only known native context sources avoid unknown user activity', () => {
  for (const kind of ['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context', 'compact-checkpoint']) {
    assert.equal(projectSession([event(0, 'user/message', { message: { source: { kind } } })]).unknownUserActivity, false);
  }
  for (const source of [undefined, {}, { kind: 'unknown' }]) {
    assert.equal(projectSession([event(0, 'user/message', { source })]).unknownUserActivity, true);
  }
  assert.equal(projectSession([event(0, 'user/message', { source: { rpcId: 'owned' } })], { requestIds: ['owned'] }).unknownUserActivity, false);
});

test('correlates rpc user to preceding turn, excludes unrelated turns and tool results', () => {
  const events = [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'user/message', { id: 'foreign-message', source: { rpcId: 'foreign' } }),
    event(2, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'foreign answer' }] } }),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(4, 'turn/start', { turn: 2 }),
    event(5, 'user/message', { id: 'owned-message', source: { rpcId: 'owned' } }),
    event(6, 'tool/call', { turn: 2, callId: 'tool', name: 'read' }),
    event(7, 'tool/result', { turn: 2, message: { toolCallId: 'tool', isError: false } }),
    event(8, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'owned answer' }] } }),
    event(9, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  const projection = projectSession(events.reverse(), { requestIds: ['owned'] });
  assert.equal(projection.requests.owned.state, 'RUNNING');
  assert.equal(projection.requests.owned.turn, 2);
  assert.equal(projection.requests.owned.answer, 'owned answer');
  assert.equal(projection.requests.owned.tools[0].isError, false);
  assert.deepEqual(projection.foreignRpcIds, ['foreign']);
});

test('synthetic-looking cold closers never confirm stop; seed boundary does not close a turn', () => {
  const prefix = [event(0, 'turn/start', { turn: 1 }), event(1, 'user/message', { id: 'm', source: { rpcId: 'r' } })];
  assert.equal(projectSession([...prefix, event(2, 'end-seed', {})], { requestIds: ['r'] }).requests.r.state, 'RUNNING');
  for (const kind of ['interrupted', 'aborted']) {
    const events = [...prefix, event(2, 'turn/end', { turn: 1, reason: { kind } })];
    assert.equal(projectSession(events, { requestIds: ['r'] }).requests.r.state, 'UNKNOWN');
    assert.equal(projectSession(events, { requestIds: ['r'], liveSeqs: [2] }).requests.r.state, kind.toUpperCase());
  }
});

test('keeps complete large content and rejects conflicts and gaps', () => {
  const content = '完整正文'.repeat(400000);
  const events = [event(0, 'turn/start', { turn: 3 }), event(1, 'user/message', { id: 'm', source: { rpcId: 'r' } }),
    event(2, 'assistant/message', { turn: 3, content: [{ type: 'text', text: content }] }),
    event(3, 'turn/end', { turn: 3, reason: { kind: 'completed' } })];
  assert.equal(projectSession([...events, events[0]], { requestIds: ['r'] }).requests.r.answer, content);
  assert.throws(() => projectSession([...events, event(0, 'turn/start', { turn: 4 })]), { code: 'EVENT_CONFLICT' });
  assert.throws(() => projectSession([events[0], events[2]]), { code: 'HISTORY_GAP' });
  assert.equal(projectSession([event(0, 'user/message', { id: 'm', source: { rpcId: 'r' } })], { requestIds: ['r'] }).requests.r.state, 'UNKNOWN');
});
