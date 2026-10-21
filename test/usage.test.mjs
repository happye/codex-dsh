import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateUsage } from '../src/usage.mjs';

const usage = { inputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 5, outputTokens: 5, totalTokens: 100 };
const event = (seq, type, data) => ({ seq, type, data });
function turnEvents(turn, rpcId, firstSeq = 0, counters = usage) {
  return [event(firstSeq, 'turn/start', { turn }),
    event(firstSeq + 1, 'user/message', { message: { id: `m${turn}`, source: { rpcId }, content: 'PRIVATE PROMPT' } }),
    event(firstSeq + 2, 'assistant/message', { turn, step: 0, usage: counters, message: { content: 'PRIVATE ANSWER' } }),
    event(firstSeq + 3, 'turn/end', { turn, reason: { kind: 'completed' } })];
}
const chunk = counters => ({ type: 'chunk', time: 1, chunk: { type: 'usage', usage: counters } });

test('native disjoint usage, deterministic snapshot dedup, request/turn totals and ratio denominator', () => {
  const events = [...turnEvents(1, 'r1'), ...turnEvents(2, 'r2', 4)];
  const first = aggregateUsage(events);
  assert.deepEqual(aggregateUsage([...events, ...structuredClone(events)]), first);
  assert.equal(first.coverage.uniqueEvents, 8);
  assert.equal(first.status, 'complete');
  assert.deepEqual(first.totals, { uncachedInputTokens: 20, cacheReadTokens: 160, cacheWriteTokens: 10, outputTokens: 10, totalInputTokens: 190, totalTokens: 200 });
  assert.equal(first.requests[0].totals.totalTokens, 100);
  assert.equal(first.turns[1].totals.totalInputTokens, 95);
  assert.deepEqual(first.cacheReadRatio, { numerator: 160, denominator: 190, denominatorField: 'totalInputTokens', value: 160 / 190 });
  const filtered = aggregateUsage(events, { requestIds: ['r2'] });
  assert.equal(filtered.totals.totalTokens, 100);
  assert.equal(filtered.records[0].turn, 2);
  assert.equal(filtered.coverage.excludedEvents, 1);
  assert.equal(aggregateUsage(events, { requestIds: [] }).sampleCount, 0);
});

test('absence stays unknown, partial reported sums remain separate and bad counters are diagnosed', () => {
  const events = [...turnEvents(1, 'r1'), ...turnEvents(2, 'r2', 4, undefined)];
  delete events[6].data.usage;
  const result = aggregateUsage(events);
  assert.equal(result.status, 'partial');
  assert.equal(result.missingUsageCount, 1);
  assert.equal(result.totals.totalTokens, null);
  assert.equal(result.reportedTotals.totalTokens, 100);
  assert.equal(result.records[1].native.inputTokens, null);
  const optional = aggregateUsage(turnEvents(1, 'r1', 0, { inputTokens: 10, outputTokens: 2 }));
  assert.equal(optional.totals.uncachedInputTokens, 10);
  assert.equal(optional.totals.cacheReadTokens, null);
  assert.equal(optional.totals.totalInputTokens, null);
  assert.equal(optional.cacheReadRatio.value, null);
  for (const bad of [-1, NaN, Infinity, '10', 1.5]) {
    const result = aggregateUsage(turnEvents(1, 'r1', 0, { ...usage, inputTokens: bad }));
    assert.equal(result.status, 'partial');
    assert.ok(result.records[0].issues.includes('invalid-inputTokens'));
  }
});

test('contradictions are retained only as allowlisted native evidence and cannot produce accepted totals', () => {
  const result = aggregateUsage(turnEvents(1, 'r1', 0, { ...usage, totalTokens: 101, secret: 'CREDENTIAL' }));
  assert.deepEqual(result.records[0].issues, ['total-tokens-mismatch']);
  assert.equal(result.records[0].native.totalTokens, 101);
  assert.equal(result.totals.totalTokens, null);
  assert.equal(result.inconsistentCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|CREDENTIAL|content|secret/);
  const overflow = aggregateUsage(turnEvents(1, 'r1', 0, { ...usage, inputTokens: Number.MAX_SAFE_INTEGER }));
  assert.equal(overflow.totals.totalInputTokens, null);
});

test('same seq conflicts and history gaps reject instead of silently double counting', () => {
  const events = turnEvents(1, 'r1');
  assert.throws(() => aggregateUsage([...events, { ...events[2], data: {} }]), { code: 'EVENT_CONFLICT' });
  assert.throws(() => aggregateUsage(events.filter(item => item.seq !== 1)), { code: 'HISTORY_GAP' });
});

test('foreign and ambiguous turns never borrow a requested RPC', () => {
  const events = [...turnEvents(1, 'mine'), ...turnEvents(2, 'foreign', 4)];
  events[6].data.turn = 1;
  const result = aggregateUsage(events, { requestIds: ['mine'] });
  assert.equal(result.sampleCount, 1);
  assert.equal(result.totals.totalTokens, 100);
  assert.equal(result.coverage.unassociatedEvents, 1);
  assert.ok(result.associationIssues.some(issue => issue.seq === 6));
  const duplicateRpc = aggregateUsage([...turnEvents(1, 'mine'), ...turnEvents(2, 'mine', 4)], { requestIds: ['mine'] });
  assert.equal(duplicateRpc.requests[0].association, 'unresolved');
  assert.equal(duplicateRpc.totals.totalTokens, null);
  const missingRpc = aggregateUsage(events, { requestIds: ['absent'] });
  assert.equal(missingRpc.requests[0].association, 'unresolved');
  assert.equal(missingRpc.totals.totalTokens, null);
  const ambiguous = turnEvents(1, 'mine');
  ambiguous.splice(2, 0, event(2, 'user/message', { message: { id: 'other', source: { rpcId: 'other' } } }));
  ambiguous.forEach((item, seq) => { item.seq = seq; });
  assert.equal(aggregateUsage(ambiguous, { requestIds: ['mine'] }).requests[0].association, 'unresolved');
});

test('attempt final sample counts separately from committed message, while message stream is not a second call', () => {
  const events = turnEvents(1, 'r1');
  events.splice(2, 0, event(2, 'assistant/attempt', { turn: 1, step: 0, stream: [chunk({ ...usage, inputTokens: 1 }), chunk(usage)] }));
  events.forEach((item, seq) => { item.seq = seq; });
  events[3].data.stream = [chunk(usage)];
  const result = aggregateUsage(events);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.totals.totalTokens, 200);
  events[3].data.stream = [chunk({ ...usage, inputTokens: 11 })];
  assert.ok(aggregateUsage(events).records[1].issues.includes('message-stream-usage-conflict'));
});

test('open turn is partial and missing attempt samples cannot be replaced with message usage', () => {
  const events = turnEvents(1, 'r1');
  events.splice(2, 0, event(2, 'assistant/attempt', { turn: 1, step: 0, stream: [] }));
  events.forEach((item, seq) => { item.seq = seq; });
  const result = aggregateUsage(events);
  assert.equal(result.missingUsageCount, 1);
  assert.equal(result.totals.totalTokens, null);
  assert.equal(result.reportedTotals.totalTokens, 100);
  assert.equal(aggregateUsage(turnEvents(1, 'r1').slice(0, 3)).status, 'partial');
});

test('six-round published aggregate can be recomputed offline without replaying prompts', () => {
  const rows = [[83000, 13904128, 59853], [50325, 26937728, 74960], [11343, 10111232, 25811], [380065, 26958592, 69225], [192447, 10425088, 46792], [5153, 4813696, 12505]];
  const events = rows.flatMap(([inputTokens, cacheReadTokens, outputTokens], index) => turnEvents(index + 2, `r${index}`, index * 4, {
    inputTokens, cacheReadTokens, outputTokens, cacheWriteTokens: 0,
    totalTokens: inputTokens + cacheReadTokens + outputTokens,
  }));
  const result = aggregateUsage(events);
  assert.equal(result.totals.uncachedInputTokens, 722333);
  assert.equal(result.totals.totalInputTokens, 93872797);
  assert.equal(result.totals.totalTokens, 94161943);
  assert.equal(result.cacheReadRatio.value, 93150464 / 93872797);
});

test('native context and compaction messages do not erase request usage association', () => {
  const events=turnEvents(1,'mine');
  const contexts=['agent-instructions','runtime-context','skill-catalog','time-context','compact-checkpoint'];
  events.splice(2,0,...contexts.map(kind=>event(0,'user/message',{id:kind,source:{kind},content:'PRIVATE CONTEXT'})));
  events.forEach((item,seq)=>{item.seq=seq;});
  const result=aggregateUsage(events,{requestIds:['mine']});
  assert.equal(result.status,'complete');assert.equal(result.totals.totalTokens,100);
  const unknown=structuredClone(events);unknown[2].data.source.kind='unknown-extension';
  assert.equal(aggregateUsage(unknown,{requestIds:['mine']}).requests[0].association,'unresolved');
});

test('a selected request with no assistant usage prevents a false complete total',()=>{
  const events=[...turnEvents(1,'r1'),event(4,'turn/start',{turn:2}),event(5,'user/message',{id:'m2',source:{rpcId:'r2'}}),event(6,'turn/end',{turn:2,reason:{kind:'error'}})];
  const result=aggregateUsage(events,{requestIds:['r1','r2']});
  assert.equal(result.status,'partial');assert.equal(result.totals.totalTokens,null);
  assert.equal(result.reportedTotals.totalTokens,100);assert.equal(result.requests[1].sampleCount,0);
});
