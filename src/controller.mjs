import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { NativeClient, readHistory } from './native.mjs';
import { projectSession } from './events.mjs';
import { fault, identifier } from './store.mjs';

const terminal = new Set(['COMPLETED', 'FAILED', 'ABORTED', 'INTERRUPTED', 'REJECTED']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const queued = value => {
  const inbox = value?.values?.inbox;
  if (!Array.isArray(inbox?.['next-turn']) || !Array.isArray(inbox?.['next-step'])) throw fault('NATIVE_QUEUE_UNKNOWN');
  return [...inbox['next-turn'], ...inbox['next-step']];
};
const summary = task => ({ task: task.id, sessionId: task.sessionId, scope: task.scope,
  state: task.stopRequested ? task.stopState ?? 'STOP_PENDING' : task.requests.at(-1)?.state ?? task.state,
  blocked: !!task.stopRequested, cursor: task.cursor ?? null,
  requests: task.requests.map(({ requestId, state, resultFile, reason, terminalSeq, turn, messageId }) => ({ requestId, state, resultFile, reason, terminalSeq, turn, messageId })),
  approvals: Object.values(task.approvals ?? {}).filter(a => ['PENDING', 'DECISION_QUEUED'].includes(a.state) && a.expiresAt >= Date.now()).map(a => ({ eventId: a.eventId, callId: a.callId, state: a.state, watchId: a.watchId, operation: a.operation })),
  ...(task.observationError ? { observationError: task.observationError } : {}), ...(task.stopReason ? { stopReason: task.stopReason } : {}) });

export class Controller {
  constructor({ store, clientFactory = config => new NativeClient(config), historyReader = readHistory, connect = options => NativeClient.connect(options) }) {
    this.store = store; this.clientFactory = clientFactory; this.historyReader = historyReader; this.connect = connect;
  }
  async attach({ name, url, token }) {
    identifier(name);
    const connection = await this.connect({ url, token });
    await this.store.transaction(state => {
      if (state.connections[name] && state.connections[name].baseUrl !== connection.baseUrl) throw fault('CONNECTION_IDENTITY_CONFLICT');
      state.connections[name] = { ...connection, name };
    });
    return { connection: name, attached: true };
  }
  async client(task) {
    const connection = await this.store.transaction(state => structuredClone(state.connections[task.connection]));
    if (!connection) throw fault('CONNECTION_NOT_FOUND');
    return this.clientFactory(connection);
  }
  async start({ connection, cwd, task: id = `task-${randomUUID()}`, title, session }) {
    identifier(id); identifier(connection);
    if (!cwd || !path.isAbsolute(cwd)) throw fault('ABSOLUTE_CWD_REQUIRED');
    if (session) identifier(session);
    const task = { id, connection, cwd, sessionId: session ?? `codex-${randomUUID()}`, scope: session ? 'shared' : 'exclusive', state: 'CREATING', requests: [], approvals: {}, liveSeqs: [], createdAt: new Date().toISOString() };
    await this.store.transaction(state => {
      if (!state.connections[connection]) throw fault('CONNECTION_NOT_FOUND');
      if (state.tasks[id]) throw fault('TASK_EXISTS');
      if (Object.values(state.tasks).some(t => state.connections[t.connection]?.baseUrl === state.connections[connection].baseUrl && t.sessionId === task.sessionId)) throw fault('SESSION_ALREADY_ATTACHED');
      state.tasks[id] = task;
    });
    const client = await this.client(task);
    if (!session) {
      try {
        const made = await client.rpc('session/create', { request: { sessionId: task.sessionId, cwd } });
        if (made?.sessionId !== task.sessionId) throw fault('SESSION_ID_MISMATCH');
      } catch (error) {
        await this.store.transaction(state => { state.tasks[id].state = error.knownRejected ? 'CREATE_REJECTED' : 'CREATE_UNKNOWN'; });
        throw error;
      }
    }
    if (!session && title) await client.rpc('session/rename', { request: { sessionId: task.sessionId, title } });
    await this.refresh(id, client);
    return this.store.transaction(state => { state.tasks[id].state = 'READY'; return summary(state.tasks[id]); });
  }
  async apply(id, events, liveSeqs = []) {
    return this.store.transaction(async state => {
      const task = state.tasks[id]; if (!task) throw fault('TASK_NOT_FOUND');
      const observedLiveSeqs = [...new Set([...(task.liveSeqs ?? []), ...liveSeqs])];
      const projection = projectSession(events, { requestIds: task.requests.map(r => r.requestId), liveSeqs: observedLiveSeqs });
      // A slow status read must not replace a newer watch generation already committed.
      if (projection.lastSeq < (task.cursor ?? -1)) return summary(task);
      task.liveSeqs = observedLiveSeqs;
      task.cursor = projection.lastSeq ?? null;
      task.activity = projection.activity;
      task.observedToolCount = projection.tools.length;
      task.foreignRpcIds = projection.foreignRpcIds;
      for (const request of task.requests) {
        const observed = projection.requests[request.requestId];
        if (!observed || (!observed.messageId && observed.state === 'UNKNOWN')) {
          if (request.state === 'SUBMITTING') request.state = 'SUBMISSION_UNKNOWN';
          continue;
        }
        // A locally observed durable terminal is never downgraded by a cold synthetic view.
        if (terminal.has(request.state) && observed.state === 'UNKNOWN') continue;
        request.state = observed.state; request.reason = observed.reason; request.turn = observed.turn; request.messageId = observed.messageId;
        request.terminalSeq = observed.terminalSeq; request.tools = observed.tools ?? [];
        if (observed.answer !== undefined && (observed.answer !== '' || terminal.has(observed.state))) {
          const answer = typeof observed.answer === 'string' ? observed.answer : JSON.stringify(observed.answer);
          request.resultFile = await this.store.writeFile(`reply-${request.requestId}.txt`, answer);
        }
      }
      task.observationError = undefined;
      return summary(task);
    });
  }
  async refresh(id, suppliedClient) {
    const task = await this.store.task(id), client = suppliedClient ?? await this.client(task);
    const history = await this.historyReader(client, task.sessionId);
    if (history.header?.id !== task.sessionId) throw fault('SESSION_ID_MISMATCH');
    await this.apply(id, history.events);
    await this.store.transaction(state => {
      if (['CREATING', 'CREATE_UNKNOWN'].includes(state.tasks[id].state)) state.tasks[id].state = 'READY';
    });
    return history;
  }
  async status({ task: id }) { await this.refresh(id); return summary(await this.store.task(id)); }
  async resume(options) { return this.status(options); }
  async send({ task: id, text, allowModel, wait = 0 }) {
    if (!allowModel) throw fault('MODEL_PERMISSION_REQUIRED', 'send requires --allow-model');
    if (typeof text !== 'string' || !text.length) throw fault('EMPTY_INPUT');
    if (!Number.isFinite(wait) || wait < 0) throw fault('INVALID_WAIT');
    await this.refresh(id);
    let watcher;
    if (wait > 0) watcher = await this.watch(id);
    const requestId = randomUUID();
    try {
      await this.store.withLock(`dispatch-${identifier(id)}.lock`, async () => {
      await this.store.transaction(async state => {
        const task = state.tasks[id];
        if (task.stopRequested) throw fault('TASK_STOPPED');
        if (task.state !== 'READY') throw fault('TASK_NOT_READY');
        if (task.requests.some(r => !terminal.has(r.state))) throw fault('UNRESOLVED_REQUEST', 'Resolve the existing request before submitting another turn');
        const inputFile = await this.store.writeFile(`input-${requestId}.txt`, text);
        task.requests.push({ requestId, state: 'SUBMITTING', inputFile, submittedAt: new Date().toISOString() });
      });
      const task = await this.store.task(id), client = watcher?.client ?? await this.client(task);
      if ((await this.store.task(id)).stopRequested) {
        await this.store.transaction(state => { const request = state.tasks[id].requests.find(r => r.requestId === requestId); request.state = 'REJECTED'; request.reason = 'Stopped before native dispatch'; });
        throw fault('TASK_STOPPED');
      }
      try {
        await client.rpc('session/prompt', { request: { sessionId: task.sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] } });
        await this.store.transaction(state => { const r = state.tasks[id].requests.find(r => r.requestId === requestId); if (r.state === 'SUBMITTING' || r.state === 'SUBMISSION_UNKNOWN') r.state = 'SUBMITTED'; });
      } catch (error) {
        await this.store.transaction(state => { const r = state.tasks[id].requests.find(r => r.requestId === requestId); if (!terminal.has(r.state)) { r.state = error.knownRejected ? 'REJECTED' : 'SUBMISSION_UNKNOWN'; r.reason = error.knownRejected ? 'Native request rejected' : 'Transport outcome unknown; do not resubmit'; } });
        if (error.knownRejected) throw fault('NATIVE_REJECTED');
      }
      });
      if (watcher) return await this.observe(id, wait, watcher, requestId);
      return summary(await this.store.task(id));
    } finally { if (watcher) await watcher.close(); }
  }
  async watch(id) {
    const task = await this.store.task(id), client = await this.client(task), history = await this.refresh(id, client);
    const events = [...history.events], live = new Set(), watchId = randomUUID();
    let active = true, failure, clientId, snapshotReady = false, remoteReady = false, pending = Promise.resolve();
    const streams = [];
    const enqueue = operation => { pending = pending.then(operation).catch(error => { failure = error; }); };
    const expire = async () => this.store.transaction(state => {
      for (const a of Object.values(state.tasks[id].approvals)) if (a.watchId === watchId && ['PENDING', 'DECISION_QUEUED', 'SENDING'].includes(a.state)) a.state = 'EXPIRED';
    });
    const onError = () => { failure = fault('WATCH_DISCONNECTED'); active = false; };
    const onClose = () => { if (active) onError(); };
    const follow = client.stream('session/follow', { request: { address: { kind: 'session', sessionId: task.sessionId }, maxMessages: 100 } }, {
      onItem: item => enqueue(async () => {
        if (item.type === 'snapshot') {
          if (item.header?.id && item.header.id !== task.sessionId) throw fault('SESSION_ID_MISMATCH');
          const generation = await this.historyReader(client, task.sessionId, { snapshot: item });
          events.splice(0, events.length, ...generation.events); snapshotReady = true;
        }
        if (item.type === 'event') { events.push(item.event); live.add(item.event.seq); }
        await this.apply(id, events, [...live]);
      }), onError, onClose,
    });
    streams.push(follow);
    const remote = client.stream('$events', {}, {
      onItem: item => enqueue(async () => {
        if (item.type === 'ready') { clientId = item.clientId; remoteReady = true; return; }
        if (item.type !== 'waterfall') return;
        const current = await this.store.task(id);
        const projection = projectSession(events, { requestIds: current.requests.map(r => r.requestId), liveSeqs: [...live] });
        let knownCalls = Object.values(projection.requests).filter(r => r.state === 'RUNNING').flatMap(r => r.tools ?? []).filter(t => t.isError === null).map(t => t.callId);
        // The two native streams may deliver waterfall before the follow tool/call.
        if (item.agentId === task.sessionId && item.event === 'approval/request' && !knownCalls.includes(item.request?.callId)) {
          await this.refresh(id, client);
          knownCalls = (await this.store.task(id)).requests.filter(r => r.state === 'RUNNING').flatMap(r => r.tools ?? []).filter(t => t.isError === null).map(t => t.callId);
        }
        if (!clientId || item.event !== 'approval/request' || item.agentId !== task.sessionId || !knownCalls.includes(item.request?.callId)) {
          if (clientId) await client.rpc('$events/result', { clientId, eventId: item.eventId, outcome: { kind: 'next' } });
          return;
        }
        await this.store.transaction(state => { state.tasks[id].approvals[item.eventId] = { eventId: item.eventId, callId: item.request.callId, operation: item.request, watchId, state: 'PENDING', expiresAt: Date.now() + 5000 }; });
      }), onError, onClose,
    });
    streams.push(remote);
    const close = async () => { active = false; for (const stream of streams) stream.close(); await pending; await expire(); };
    try {
      await Promise.all(streams.map(s => s.ready));
      const deadline = Date.now() + 15000;
      while (!snapshotReady || !remoteReady) { if (failure) throw failure; if (Date.now() > deadline) throw fault('WATCH_READY_TIMEOUT'); await sleep(20); }
    } catch (error) { await close(); throw error; }
    return { client, close, tick: async () => {
      await pending;
      if (failure) { await expire(); throw failure; }
      const decisions = await this.store.transaction(state => {
        const selected = [];
        for (const a of Object.values(state.tasks[id].approvals)) {
          if (a.watchId !== watchId) continue;
          if (a.state === 'PENDING') a.expiresAt = Date.now() + 5000;
          if (a.state === 'DECISION_QUEUED') { a.state = 'SENDING'; selected.push(structuredClone(a)); }
        }
        return selected;
      });
      for (const a of decisions) {
        try {
          await client.rpc('$events/result', { clientId, eventId: a.eventId, outcome: { kind: 'result', value: a.decision } });
          await this.store.transaction(state => { state.tasks[id].approvals[a.eventId].state = 'RESULT_SENT_UNCONFIRMED'; });
        } catch { await this.store.transaction(state => { state.tasks[id].approvals[a.eventId].state = 'DELIVERY_UNKNOWN'; }); }
      }
    } };
  }
  async observe(id, seconds, watcher, requestId) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      await watcher.tick();
      const task = await this.store.task(id), request = requestId ? task.requests.find(r => r.requestId === requestId) : task.requests.at(-1);
      if (request && terminal.has(request.state)) return summary(task);
      await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
    }
    return { ...summary(await this.store.task(id)), observationTimedOut: true };
  }
  async follow({ task: id, wait = 60 }) {
    if (!Number.isFinite(wait) || wait < 0) throw fault('INVALID_WAIT');
    const watcher = await this.watch(id);
    try { return await this.observe(id, wait, watcher); } finally { await watcher.close(); }
  }
  async approvals({ task: id }) { return summary(await this.store.task(id)); }
  async approve({ task: id, approval, decision }) {
    if (!['allowed-once', 'rejected'].includes(decision)) throw fault('INVALID_DECISION');
    return this.store.transaction(state => {
      const task = state.tasks[id]; if (!task) throw fault('TASK_NOT_FOUND');
      const a = task.approvals[approval];
      if (!a || a.state !== 'PENDING' || a.expiresAt < Date.now()) throw fault('APPROVAL_EXPIRED');
      a.decision = decision; a.state = 'DECISION_QUEUED';
      return { task: id, approval, state: 'DECISION_QUEUED' };
    });
  }
  async stop({ task: id }) {
    await this.store.transaction(state => {
      const task = state.tasks[id]; if (!task) throw fault('TASK_NOT_FOUND');
      task.stopRequested = true; task.stopState = 'STOP_PENDING';
      task.stopReason = 'Verifying native activity; new submissions blocked';
    });
    const task = await this.store.task(id), client = await this.client(task);
    let watcher;
    try {
      await this.store.withLock(`dispatch-${identifier(id)}.lock`, async () => {
      if (task.scope === 'exclusive') watcher = await this.watch(id);
      const owned = new Set(task.requests.map(r => r.requestId));
      const queue = queued(await client.rpc('session/projections', { request: { sessionId: task.sessionId } }));
      for (const item of queue) if (owned.has(item.source?.rpcId) && item.id) await client.rpc('session/updateQueue', { request: { sessionId: task.sessionId, itemId: item.id, action: { kind: 'remove' } } });
      // Shared sessions have no atomic conditional-cancel API; cancelling could affect a user turn.
      if (task.scope === 'exclusive') await client.rpc('session/cancel', { request: { sessionId: task.sessionId } });
      if (watcher) {
        const deadline = Date.now() + 1500;
        do {
          await watcher.tick();
          const current = await this.store.task(id);
          if (current.requests.every(r => terminal.has(r.state))) break;
          await sleep(50);
        } while (Date.now() < deadline);
      }
      await this.refresh(id, client);
      const projection = await client.rpc('session/projections', { request: { sessionId: task.sessionId } });
      const rows = await client.rpc('session/list', { _request: {} });
      const row = rows.items?.find(row => row.sessionId === task.sessionId);
      const current = await this.store.task(id);
      // Native tool inventory cannot prove every job/schedule/descendant stopped. Retain pending when any tool ran.
      const toolsSeen = current.observedToolCount > 0 || current.activity?.length || current.foreignRpcIds?.length;
      const unresolved = current.requests.some(r => ['SUBMISSION_UNKNOWN', 'SUBMITTING', 'SUBMITTED', 'UNKNOWN', 'RUNNING', 'QUEUED'].includes(r.state));
      const quiet = task.scope === 'exclusive' && row?.running === false && queued(projection).length === 0 && !toolsSeen && !unresolved;
      await this.store.transaction(state => {
        state.tasks[id].stopState = quiet ? 'STOPPED' : 'STOP_PENDING';
        state.tasks[id].stopReason = quiet ? 'Native session idle, owned queue empty, no observed tool activity' : 'Cannot prove all native activity stopped (shared session, tools, unknown submission or running activity)';
      });
      }, { timeoutMs: 20000 });
    } catch {
      await this.store.transaction(state => { state.tasks[id].stopReason = 'Native stop outcome or activity is unknown; new submissions remain blocked'; });
    } finally { if (watcher) await watcher.close(); }
    return summary(await this.store.task(id));
  }
}
