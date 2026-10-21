import { createHash } from 'node:crypto';
import { fault } from './store.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The native cursor alone cannot identify local stop/approval/error changes.
export function taskView(value, task, { request, sinceCursor, sinceGeneration } = {}) {
  if (sinceCursor !== undefined && (!Number.isSafeInteger(sinceCursor) || sinceCursor < -1 || sinceCursor > (value.cursor ?? -1))) throw fault('INVALID_CURSOR');
  if (sinceGeneration !== undefined && !/^[a-f0-9]{64}$/.test(sinceGeneration)) throw fault('INVALID_GENERATION');
  if (request !== undefined && request !== 'latest' && !value.requests.some(r => r.requestId === request)) throw fault('REQUEST_NOT_FOUND');
  const requests = value.requests.map(r => {
    const stored = task.requests.find(item => item.requestId === r.requestId);
    return { requestId: r.requestId, state: r.state, turn: r.turn ?? null, terminalSeq: r.terminalSeq ?? null,
      ...(r.reason?.kind ? { reason: r.reason.kind } : {}), ...(r.diagnostic ? { diagnostic: r.diagnostic } : {}),
      ...(r.resultFile ? { resultFile: r.resultFile, resultSha256: stored?.resultSha256 ?? null, resultBytes: stored?.resultBytes ?? null } : {}) };
  });
  const selection = request === undefined || request === 'latest' ? requests.slice(-1) : requests.filter(r => r.requestId === request);
  const tools = task.toolSignals ?? [];
  const stable = { task: value.task, sessionId: value.sessionId, scope: value.scope, state: value.state,
    blocked: value.blocked, cursor: value.cursor, requests, approvals: value.approvals,
    stopAttempt: value.stopAttempt, stopDiagnostic: value.stopDiagnostic, stopReason: value.stopReason, observationError: value.observationError,
    currentStep: task.currentStep ?? null, tools, contractSha: task.contractRef?.sha ?? null, selector: request ?? 'latest' };
  const generation = digest(stable), changed = generation !== sinceGeneration;
  const base = { task: value.task, sessionId: value.sessionId, scope: value.scope, state: value.state,
    blocked: value.blocked, cursor: value.cursor, generation, changed,
    ...(task.contractRef ? { contractSha: task.contractRef.sha } : {}),
    ...(value.observationTimedOut ? { observationTimedOut: true } : {}) };
  if (!changed) return { ...base, requests: [], approvals: value.approvals, counts: { requests: requests.length, newTools: 0 } };
  const byName = new Map();
  for (const tool of tools.filter(item => sinceCursor === undefined || item.seq > sinceCursor)) byName.set(tool.name ?? 'unknown', (byName.get(tool.name ?? 'unknown') ?? 0) + 1);
  const counts = Object.fromEntries(byName);
  return { ...base, requests: selection, approvals: value.approvals, currentStep: task.currentStep ?? null,
    counts: { requests: requests.length, newTools: Object.values(counts).reduce((a,b) => a+b, 0), tools: counts },
    ...(value.stopReason ? { stopReason: value.stopReason } : {}),
    ...(value.stopAttempt ? { stopAttempt: value.stopAttempt } : {}),
    ...(value.stopDiagnostic ? { stopDiagnostic: value.stopDiagnostic } : {}),
    ...(value.observationError ? { observationError: value.observationError } : {}) };
}
