import { isDeepStrictEqual } from 'node:util';

const contextSources = new Set(['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context', 'compact-checkpoint']);

// Wire events are a dense zero-based log; partial windows may begin above zero.
export function normalizeEvents(events, { contiguous = false } = {}) {
  const bySeq = new Map();
  for (const event of events) {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0 || typeof event.type !== 'string') {
      throw Object.assign(new Error('Invalid native event'), { code: 'EVENT_INVALID' });
    }
    if (bySeq.has(event.seq) && !isDeepStrictEqual(bySeq.get(event.seq), event)) {
      throw Object.assign(new Error(`Conflicting native event at seq ${event.seq}`), { code: 'EVENT_CONFLICT' });
    }
    bySeq.set(event.seq, event);
  }
  const result = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  if (contiguous && result.some((event, i) => i > 0 && event.seq !== result[i - 1].seq + 1)) {
    throw Object.assign(new Error('Gap in native history'), { code: 'HISTORY_GAP' });
  }
  return result;
}

function text(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text ?? '').join('') : '';
}

export function projectSession(events, { requestIds = [], liveSeqs = [] } = {}) {
  const ordered = normalizeEvents(events, { contiguous: true });
  const live = new Set(liveSeqs);
  const requests = Object.fromEntries(requestIds.map(requestId => [requestId, {
    requestId, messageId: null, turn: null, state: 'UNKNOWN', answer: '', tools: [],
  }]));
  const turns = new Map();
  const foreignRpcIds = new Set();
  let unknownUserActivity = false;
  const tools = [];
  const activity = [];
  let currentTurn = null;
  let openTurn = null;
  for (const event of ordered) {
    const data = event.data ?? {};
    if (event.type === 'turn/start') {
      openTurn = data.turn;
      currentTurn = data.turn;
      if (!turns.has(openTurn)) turns.set(openTurn, { answer: '', tools: [], end: null });
    }
    if (event.type === 'user/message') {
      const message = data.message ?? data;
      const requestId = message.source?.rpcId;
      if (requestId && Object.hasOwn(requests, requestId)) {
        const request = requests[requestId];
        if (request.messageId !== null && request.messageId !== message.id) {
          request.state = 'UNKNOWN';
          request.viewReason = 'request-id-has-multiple-messages';
          request.ambiguous = true;
        } else {
          request.messageId = message.id ?? null;
          request.turn = openTurn;
        }
      } else if (requestId) foreignRpcIds.add(requestId);
      else if (!contextSources.has(message.source?.kind)) unknownUserActivity = true;
    }
    const turn = data.turn ?? openTurn;
    const record = turns.get(turn);
    if (event.type === 'assistant/message' && record) record.answer += text(data.message?.content ?? data.content);
    if (event.type === 'tool/call') {
      const tool = { callId: data.callId, name: data.name, isError: null, seq: event.seq };
      tools.push(tool);
      record?.tools.push(tool);
      if (/(subagent|task|job|schedule)/i.test(data.name ?? '')) activity.push({ type: event.type, seq: event.seq, turn, callId: data.callId, name: data.name });
    }
    if (event.type === 'tool/result') {
      const callId = data.message?.toolCallId ?? data.message?.callId ?? data.callId;
      const tool = tools.findLast(item => item.callId === callId);
      if (tool) tool.isError = data.message?.isError ?? data.isError ?? null;
    }
    if (/(subagent|schedule|job)[/]/i.test(event.type)) activity.push({ type: event.type, seq: event.seq, turn, data });
    if (event.type === 'turn/end') {
      if (record) record.end = event;
      if (data.turn === openTurn) openTurn = null;
    }
  }
  for (const request of Object.values(requests)) {
    if (request.ambiguous) continue;
    const record = turns.get(request.turn);
    if (!record) {
      request.viewReason = request.messageId === null ? 'no-correlated-user-message' : 'no-preceding-turn-start';
      continue;
    }
    request.answer = record.answer;
    request.tools = record.tools.map(tool => ({ ...tool }));
    if (!record.end) { request.state = 'RUNNING'; continue; }
    request.terminalSeq = record.end.seq;
    request.terminalSource = live.has(record.end.seq) ? 'live' : 'snapshot';
    request.reason = record.end.data.reason;
    const kind = request.reason?.kind;
    request.state = ({ completed: 'COMPLETED', aborted: 'ABORTED', interrupted: 'INTERRUPTED', error: 'FAILED', blocked: 'FAILED', 'max-tokens': 'FAILED' })[kind] ?? 'UNKNOWN';
    if (['interrupted', 'aborted', 'forked'].includes(kind) && request.terminalSource !== 'live') {
      request.state = 'UNKNOWN';
      request.viewReason = 'snapshot-terminal-may-be-synthetic';
    }
  }
  return { requests, currentTurn, lastSeq: ordered.at(-1)?.seq ?? -1, tools, foreignRpcIds: [...foreignRpcIds], unknownUserActivity, activity };
}
