import { isDeepStrictEqual } from 'node:util';
import { normalizeEvents } from './events.mjs';

const nativeFields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens', 'reasoningTokens'];
const fields = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalInputTokens', 'totalTokens'];
const count = value => Number.isSafeInteger(value) && value >= 0;
// These native context messages share the user/message envelope but do not
// represent another user request. Unknown sources remain ambiguous.
const contextSources = new Set(['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context', 'compact-checkpoint']);
const sum = values => values.every(count) && Number.isSafeInteger(values.reduce((a, b) => a + b, 0))
  ? values.reduce((a, b) => a + b, 0) : null;

function usageRecord(event, turn) {
  const data = event.data ?? {};
  // Native streams contain cumulative samples. Only the final sample represents
  // this attempt; committed-message data.usage is another view of that sample.
  const streamed = Array.isArray(data.stream)
    ? data.stream.findLast(item => item?.type === 'chunk' && item.chunk?.type === 'usage')?.chunk.usage
    : undefined;
  const raw = event.type === 'assistant/message' ? data.usage ?? streamed : streamed;
  const issues = [];
  if (data.usage && streamed && !isDeepStrictEqual(data.usage, streamed)) issues.push('message-stream-usage-conflict');
  const native = Object.fromEntries(nativeFields.map(key => [key, count(raw?.[key]) ? raw[key] : null]));
  const missing = nativeFields.filter(key => raw?.[key] === undefined);
  for (const key of nativeFields) if (raw?.[key] !== undefined && !count(raw[key])) issues.push(`invalid-${key}`);
  const totalInputTokens = sum([native.inputTokens, native.cacheReadTokens, native.cacheWriteTokens]);
  const derivedTotal = sum([totalInputTokens, native.outputTokens]);
  if (derivedTotal !== null && native.totalTokens !== null && derivedTotal !== native.totalTokens) issues.push('total-tokens-mismatch');
  if (native.totalTokens !== null && native.outputTokens !== null && native.totalTokens < native.outputTokens) issues.push('total-less-than-output');
  const normalized = {
    uncachedInputTokens: native.inputTokens, cacheReadTokens: native.cacheReadTokens,
    cacheWriteTokens: native.cacheWriteTokens, outputTokens: native.outputTokens,
    totalInputTokens, totalTokens: native.totalTokens ?? derivedTotal,
  };
  // A contradictory sample is retained as native evidence, never accepted into
  // normalized totals as if its accounting were coherent.
  if (issues.length) for (const key of fields) normalized[key] = null;
  return { seq: event.seq, type: event.type, turn, requestId: null, native, normalized, missing, issues, usagePresent: raw != null };
}

function summarize(records, { unresolved = false, ended = true } = {}) {
  const totals = {};
  const reportedTotals = {};
  const coverage = {};
  for (const key of fields) {
    const known = records.map(record => record.normalized[key]).filter(count);
    coverage[key] = { reported: known.length, missing: records.length - known.length };
    reportedTotals[key] = known.length ? sum(known) : null;
    totals[key] = !unresolved && records.length && known.length === records.length ? sum(known) : null;
  }
  const complete = ended && !unresolved && records.length > 0 && fields.every(key => totals[key] !== null);
  return {
    status: complete ? 'complete' : 'partial', sampleCount: records.length,
    missingUsageCount: records.filter(record => !record.usagePresent).length,
    inconsistentCount: records.filter(record => record.issues.length > 0).length,
    totals, reportedTotals, fieldCoverage: coverage,
    cacheReadRatio: {
      numerator: totals.cacheReadTokens, denominator: totals.totalInputTokens,
      denominatorField: 'totalInputTokens',
      value: totals.cacheReadTokens !== null && totals.totalInputTokens > 0 ? totals.cacheReadTokens / totals.totalInputTokens : null,
    },
  };
}

/**
 * Pure export for ONE native session's full ordered history, never provider API
 * usage. Adapter contract: DSH TokenUsage (@deepseek-ai/dsh-llm 0.2.1-alpha.1,
 * types.ts): inputTokens is uncached; cacheRead/cacheWrite are disjoint.
 * Optional absent counters remain unknown even if a provider adapter sometimes
 * omits zero. Unknown providers/SDK payloads must not be passed as native events.
 * requestIds omitted selects all records; [] selects none. Foreign/unassociated
 * turns are never attributed to a requested RPC. No body/source/arguments escape.
 */
export function aggregateUsage(events, { requestIds } = {}) {
  const ordered = normalizeEvents(events, { contiguous: true });
  const selected = requestIds === undefined ? null : new Set(requestIds);
  const turns = new Map();
  const requests = new Map();
  const records = [];
  const associationIssues = [];
  let openTurn = null;
  const validTurn = turn => Number.isSafeInteger(turn) && turn >= 0;
  for (const event of ordered) {
    const data = event.data ?? {};
    if (event.type === 'turn/start') {
      openTurn = validTurn(data.turn) ? data.turn : null;
      if (openTurn !== null) {
        if (turns.has(openTurn)) turns.get(openTurn).ambiguous = true;
        else turns.set(openTurn, { turn: openTurn, requestIds: new Set(), ended: false, ambiguous: false });
      }
    }
    if (event.type === 'user/message') {
      const message = data.message ?? data;
      const rpcId = message.source?.rpcId;
      if (typeof rpcId === 'string') {
        if (!requests.has(rpcId)) requests.set(rpcId, { requestId: rpcId, turns: new Set(), messages: new Set() });
        const request = requests.get(rpcId);
        request.messages.add(message.id ?? event.seq);
        if (openTurn === null || (data.turn !== undefined && data.turn !== openTurn)) {
          request.unassociated = true;
          associationIssues.push({ seq: event.seq, reason: 'user-message-without-matching-open-turn' });
        } else {
          request.turns.add(openTurn);
          turns.get(openTurn).requestIds.add(rpcId);
        }
      } else if (openTurn !== null && !contextSources.has(message.source?.kind)) turns.get(openTurn).ambiguous = true;
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      // Usage explicitly declaring another turn cannot borrow the current one.
      const turn = validTurn(data.turn) ? data.turn : null;
      const record = usageRecord(event, turn);
      if (turn === null || !turns.has(turn) || turn !== openTurn) {
        record.associationReason = 'usage-without-matching-open-turn';
      }
      records.push(record);
    }
    if (event.type === 'turn/end' && openTurn !== null && data.turn === openTurn) {
      turns.get(openTurn).ended = true;
      openTurn = null;
    }
  }
  for (const record of records) {
    const turn = turns.get(record.turn);
    const ids = turn ? [...turn.requestIds] : [];
    const request = ids.length === 1 ? requests.get(ids[0]) : null;
    if (!record.associationReason && !turn.ambiguous && ids.length === 1 && request.messages.size === 1 && request.turns.size === 1 && !request.unassociated) record.requestId = ids[0];
    else {
      record.associationReason ??= 'ambiguous-or-missing-request-correlation';
      associationIssues.push({ seq: record.seq, turn: record.turn, reason: record.associationReason });
    }
  }
  const outputRecords = records.filter(record => selected === null || selected.has(record.requestId));
  const ids = selected === null ? [...requests.keys()] : [...selected];
  const outputRequests = ids.map(requestId => {
    const request = requests.get(requestId);
    const turn = request?.turns.size === 1 ? [...request.turns][0] : null;
    const record = turns.get(turn);
    const associated = request && request.messages.size === 1 && request.turns.size === 1 && !request.unassociated && !record.ambiguous && record.requestIds.size === 1;
    return { requestId, turn: associated ? turn : null, association: associated ? 'matched' : 'unresolved',
      ...summarize(outputRecords.filter(item => item.requestId === requestId), { unresolved: !associated, ended: record?.ended ?? false }) };
  });
  const outputTurns = [...turns.values()].filter(turn => selected === null || [...turn.requestIds].some(id => selected.has(id))).map(turn => ({
    turn: turn.turn, requestIds: [...turn.requestIds], ended: turn.ended,
    ...summarize(outputRecords.filter(record => record.turn === turn.turn), { unresolved: turn.ambiguous || turn.requestIds.size !== 1, ended: turn.ended }),
  }));
  const unresolved = outputRequests.some(request => request.association === 'unresolved' || request.sampleCount === 0) || outputRecords.some(record => record.requestId === null);
  return {
    schema: 'dsh-usage/v1', adapter: 'native-token-usage-disjoint/v1',
    scope: 'single-native-session', lastSeq: ordered.at(-1)?.seq ?? -1,
    coverage: { uniqueEvents: ordered.length, usageEvents: records.length, selectedEvents: outputRecords.length,
      unassociatedEvents: records.filter(record => record.requestId === null).length,
      excludedEvents: records.length - outputRecords.length, historyStartsAtZero: !ordered.length || ordered[0].seq === 0 },
    records: outputRecords, requests: outputRequests, turns: outputTurns,
    ...summarize(outputRecords, { unresolved, ended: outputTurns.every(turn => turn.ended) }),
    associationIssues,
  };
}
