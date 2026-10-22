import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { NativeClient, readHistory, safeDiagnostic } from './native.mjs';
import { projectSession } from './events.mjs';
import { fault, identifier } from './store.mjs';
import { directoryIdentity, sameDirectory, verifySessionDirectory } from './identity.mjs';
import { taskView } from './view.mjs';

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
  requests: task.requests.map(({ requestId, state, resultFile, reason, terminalSeq, turn, messageId, diagnostic }) => ({ requestId, state, resultFile, reason, terminalSeq, turn, messageId,
    ...(safeDiagnostic(diagnostic) ? { diagnostic: safeDiagnostic(diagnostic) } : {}) })),
  approvals: Object.values(task.approvals ?? {}).filter(a => ['PENDING', 'DECISION_QUEUED'].includes(a.state) && a.expiresAt >= Date.now()).map(a => ({ eventId: a.eventId, callId: a.callId, state: a.state, watchId: a.watchId, operation: a.operation })),
  ...(task.observationError ? { observationError: task.observationError } : {}), ...(task.stopReason ? { stopReason: task.stopReason } : {}),
  ...(task.stopAttempt ? { stopAttempt: task.stopAttempt } : {}), ...(task.stopDiagnostic ? { stopDiagnostic: task.stopDiagnostic } : {}) });

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
  async workspace({ connection, cwd }) {
    const { WorkspaceService } = await import('./workspace.mjs');
    const service = new WorkspaceService({ store: this.store, clientFactory: this.clientFactory });
    return cwd === undefined ? { connection, workspaces: await service.list({ connection }) } : { connection, ...await service.create({ connection, cwd }) };
  }
  async verifyWorkspace(task) {
    if (!task.workspaceId) return;
    const { WorkspaceService } = await import('./workspace.mjs');
    const workspace = await new WorkspaceService({ store: this.store, clientFactory: this.clientFactory }).get({ connection: task.connection, workspaceId: task.workspaceId });
    if (!sameDirectory(await directoryIdentity(task.cwd), await directoryIdentity(workspace.path))) throw fault('SESSION_WORKSPACE_CWD_MISMATCH');
    if (!workspace.sessionIds.includes(task.sessionId)) throw fault('SESSION_WORKSPACE_MEMBERSHIP_UNKNOWN');
  }
  async start({ connection, cwd, task: id = `task-${randomUUID()}`, title, session, workspace: workspaceId }) {
    identifier(id); identifier(connection);
    if (!cwd || !path.isAbsolute(cwd)) throw fault('ABSOLUTE_CWD_REQUIRED');
    const cwdIdentity = await directoryIdentity(cwd);
    cwd = cwdIdentity.path;
    if (session) identifier(session);
    if (workspaceId !== undefined) {
      const { WorkspaceService } = await import('./workspace.mjs');
      const workspace = await new WorkspaceService({ store: this.store, clientFactory: this.clientFactory }).get({ connection, workspaceId });
      if (!sameDirectory(cwdIdentity, await directoryIdentity(workspace.path))) throw fault('SESSION_WORKSPACE_CWD_MISMATCH');
      if (session && !workspace.sessionIds.includes(session)) throw fault('SESSION_WORKSPACE_MEMBERSHIP_UNKNOWN');
    }
    const task = { id, connection, cwd, nativeCwd: cwd, cwdIdentity, ...(workspaceId === undefined ? {} : { workspaceId }), sessionId: session ?? `codex-${randomUUID()}`, scope: session ? 'shared' : 'exclusive', state: 'CREATING', requests: [], approvals: {}, liveSeqs: [], createdAt: new Date().toISOString() };
    await this.store.transaction(state => {
      if (!state.connections[connection]) throw fault('CONNECTION_NOT_FOUND');
      if (state.tasks[id]) throw fault('TASK_EXISTS');
      if (Object.values(state.tasks).some(t => state.connections[t.connection]?.baseUrl === state.connections[connection].baseUrl && t.sessionId === task.sessionId)) throw fault('SESSION_ALREADY_ATTACHED');
      state.tasks[id] = task;
    });
    const client = await this.client(task);
    if (!session) {
      try {
        const made = await client.rpc('session/create', { request: { sessionId: task.sessionId, ...(workspaceId === undefined ? { cwd } : { workspaceId }) } });
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
      task.toolSignals = projection.tools.map(({ name, seq }) => ({ name, seq }));
      const lastStep = events.filter(event => event.type === 'step/start').reduce((last,event) => !last || event.seq > last.seq ? event : last, null);
      task.currentStep = lastStep ? { turn: lastStep.data.turn, step: lastStep.data.step } : null;
      task.foreignRpcIds = projection.foreignRpcIds;
      if (projection.foreignRpcIds.length || projection.unknownUserActivity) task.sharedStopRequired = true;
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
          const resultSha256 = createHash('sha256').update(answer).digest('hex');
          let intact = false;
          if (request.resultSha256 === resultSha256 && request.resultFile) {
            try { intact = await this.store.readFile(`reply-${request.requestId}.txt`) === answer; } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          if (!intact) request.resultFile = await this.store.writeFile(`reply-${request.requestId}.txt`, answer);
          request.resultSha256 = resultSha256; request.resultBytes = Buffer.byteLength(answer);
        }
      }
      task.observationError = undefined;
      return summary(task);
    });
  }
  async refresh(id, suppliedClient) {
    const task = await this.store.task(id), client = suppliedClient ?? await this.client(task);
    const history = await this.historyReader(client, task.sessionId);
    const cwdIdentity = await verifySessionDirectory(task, history.header);
    await this.verifyWorkspace(task);
    await this.store.transaction(state => {
      // Another refresh may have established the first legacy binding while this read was in flight.
      if (state.tasks[id].cwdIdentity && !sameDirectory(state.tasks[id].cwdIdentity, cwdIdentity)) throw fault('SESSION_CWD_MISMATCH');
      state.tasks[id].nativeCwd = cwdIdentity.path;
      state.tasks[id].cwdIdentity = cwdIdentity;
      if (['CREATING', 'CREATE_UNKNOWN'].includes(state.tasks[id].state)) state.tasks[id].state = 'READY';
    });
    await this.apply(id, history.events);
    return history;
  }
  async status({ task: id }) { await this.refresh(id); return summary(await this.store.task(id)); }
  async resume(options) { return this.status(options); }
  async tasks({ connection, cwd, title, active } = {}) {
    identifier(connection);
    if (title !== undefined && typeof title !== 'string') throw fault('INVALID_TITLE');
    if (active !== undefined && typeof active !== 'boolean') throw fault('INVALID_ACTIVE');
    const selectedCwd = cwd === undefined ? undefined : await directoryIdentity(cwd);
    const { config, bound } = await this.store.transaction(state => {
      const config = state.connections[connection];
      if (!config) throw fault('CONNECTION_NOT_FOUND');
      return { config: structuredClone(config), bound: Object.values(state.tasks).filter(t => state.connections[t.connection]?.baseUrl === config.baseUrl).map(t => structuredClone(t)) };
    });
    const client = this.clientFactory(config);
    const rows = await client.rpc('session/list', { _request: {} });
    if (!Array.isArray(rows?.items)) throw fault('NATIVE_SESSION_LIST_UNKNOWN');
    const tasks = [];
    for (const boundTask of bound) {
      const expected = await directoryIdentity(boundTask.nativeCwd ?? boundTask.cwd);
      if (selectedCwd && !sameDirectory(expected, selectedCwd)) continue;
      const row = rows.items.find(item => item.sessionId === boundTask.sessionId);
      const nativeTitle = row?.projections?.values?.title;
      if (title !== undefined && nativeTitle !== title) continue;
      await this.refresh(boundTask.id, client);
      const task = await this.store.task(boundTask.id);
      const unresolved = ['CREATING', 'CREATE_UNKNOWN'].includes(task.state) || task.requests.some(r => !terminal.has(r.state));
      const running = typeof row?.running === 'boolean' ? row.running : null;
      const observedActive = running === true || unresolved;
      // An unknown native running flag cannot establish inactivity.
      if (active !== undefined && (observedActive !== active || (!active && running === null))) continue;
      tasks.push({ task: task.id, connection: task.connection, sessionId: task.sessionId, cwd: task.nativeCwd,
        ...(typeof nativeTitle === 'string' ? { title: nativeTitle } : {}), state: summary(task).state,
        blocked: !!task.stopRequested, active: observedActive ? true : running === false ? false : null, running, unresolved });
    }
    return { connection, tasks, activityMeaning: 'native-running-or-unresolved' };
  }
  async recover({ task, connection, cwd, title, active } = {}) {
    if (task !== undefined) {
      if (connection !== undefined || cwd !== undefined || title !== undefined || active !== undefined) throw fault('INVALID_RECOVERY_SELECTOR');
      return this.resume({ task });
    }
    const result = await this.tasks({ connection, cwd, title, active });
    if (!result.tasks.length) throw fault('TASK_NOT_FOUND');
    if (result.tasks.length > 1) throw Object.assign(fault('AMBIGUOUS_TASK'), { candidates: result.tasks.map(t => t.task) });
    return this.resume({ task: result.tasks[0].task });
  }
  async send({ task: id, text, allowModel, wait = 0, contractSha }) {
    if (!allowModel) throw fault('MODEL_PERMISSION_REQUIRED', 'send requires --allow-model');
    if (typeof text !== 'string' || !text.length) throw fault('EMPTY_INPUT');
    if (!Number.isFinite(wait) || wait < 0) throw fault('INVALID_WAIT');
    let watcher;
    if (wait > 0) watcher = await this.watch(id);
    else await this.refresh(id);
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
      let dispatchText = text;
      if ((await this.store.task(id)).stopRequested) {
        await this.store.transaction(state => { const request = state.tasks[id].requests.find(r => r.requestId === requestId); request.state = 'REJECTED'; request.reason = 'Stopped before native dispatch'; });
        throw fault('TASK_STOPPED');
      }
      try {
        // Recheck after acquiring dispatch ownership and any watcher/client setup.
        await verifySessionDirectory(task, (await this.historyReader(client, task.sessionId)).header);
        await this.verifyWorkspace(task);
        if ((await this.store.task(id)).stopRequested) throw fault('TASK_STOPPED');
        if (task.contractRef || contractSha !== undefined) {
          const { ContractService } = await import('./contract.mjs');
          const checked = await new ContractService({ store: this.store }).check({ task: id, contractSha });
          const known = task.requests.some(r => r.requestId !== requestId && r.contractSha === contractSha && r.messageId);
          const reference = { id: checked.contract.id, revision: checked.contract.revision, sha256: contractSha, asset: this.store.file(task.contractRef.file) };
          dispatchText = `[Codex task contract]\n${JSON.stringify(reference)}\nRead the asset's contract field if this hash is new, missing from context, or uncertain after compaction. Preserve all requirements; return conflicts for a decision. The baseline field is verification data and need not be expanded.\n${known ? '' : JSON.stringify(checked.contract) + '\n'}[Current task delta]\n${text}`;
          await this.store.transaction(async state => {
            const request = state.tasks[id].requests.find(r => r.requestId === requestId);
            request.contractSha = contractSha;
            request.dispatchFile = await this.store.writeFile(`dispatch-${requestId}.txt`, dispatchText);
          });
        }
        if ((await this.store.task(id)).stopRequested) throw fault('TASK_STOPPED');
      } catch (error) {
        await this.store.transaction(state => { const request = state.tasks[id].requests.find(r => r.requestId === requestId); request.state = 'REJECTED'; request.reason = 'Native identity or task contract could not be verified before dispatch'; });
        throw error;
      }
      try {
        const delivery = await this.store.transaction(state => {
          if (state.tasks[id].stopRequested) {
            const request = state.tasks[id].requests.find(r => r.requestId === requestId);
            request.state = 'REJECTED'; request.reason = 'Stopped before native dispatch';
            return null;
          }
          return { outcome: client.rpc('session/prompt', { request: { sessionId: task.sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: dispatchText }] } }).then(() => null, error => error) };
        });
        if (!delivery) throw fault('TASK_STOPPED');
        const dispatchError = await delivery.outcome;
        if (dispatchError) throw dispatchError;
        await this.store.transaction(state => { const r = state.tasks[id].requests.find(r => r.requestId === requestId); if (r.state === 'SUBMITTING' || r.state === 'SUBMISSION_UNKNOWN') r.state = 'SUBMITTED'; });
      } catch (error) {
        if (error.code === 'TASK_STOPPED') throw error;
        const diagnostic = safeDiagnostic(error.diagnostic);
        await this.store.transaction(state => { const r = state.tasks[id].requests.find(r => r.requestId === requestId); if (diagnostic) r.diagnostic = diagnostic; if (!terminal.has(r.state)) { r.state = error.knownRejected ? 'REJECTED' : 'SUBMISSION_UNKNOWN'; r.reason = error.knownRejected ? 'Native request rejected' : 'Transport outcome unknown; do not resubmit'; } });
        if (error.knownRejected) throw Object.assign(fault('NATIVE_REJECTED'), diagnostic ? { diagnostic } : {});
      }
      });
      if (watcher) return await this.observe(id, wait, watcher, requestId);
      return summary(await this.store.task(id));
    } finally { if (watcher) await watcher.close(); }
  }
  async watch(id) {
    const lease = await this.store.acquireLock(`observer-${identifier(id)}.lock`, { timeoutMs: 0 });
    try { return await this.createWatch(id, lease); }
    catch (error) { await lease.release(); throw error; }
  }
  async createWatch(id, lease) {
    let task = await this.store.task(id);
    const client = await this.client(task), history = await this.refresh(id, client);
    task = await this.store.task(id);
    const events = [...history.events], live = new Set(), watchId = randomUUID();
    let active = true, failure, clientId, snapshotReady = false, remoteReady = false, dirty = false, pending = Promise.resolve();
    const streams = [];
    const enqueue = operation => { pending = pending.then(operation).catch(error => { failure = error; }); };
    const flush = async (ignoreFailure = false) => {
      let batch;
      do { batch = pending; await batch; } while (batch !== pending);
      if (failure && !ignoreFailure) throw failure;
      if (dirty) { dirty = false; await this.apply(id, [...events], [...live]); }
    };
    const expire = async () => this.store.transaction(state => {
      for (const a of Object.values(state.tasks[id].approvals)) if (a.watchId === watchId && ['PENDING', 'DECISION_QUEUED', 'SENDING'].includes(a.state)) a.state = 'EXPIRED';
    });
    const onError = error => {
      const diagnostic = safeDiagnostic(error?.diagnostic);
      failure = Object.assign(fault('WATCH_DISCONNECTED'), diagnostic ? { diagnostic } : {}); active = false;
    };
    const onClose = () => { if (active) onError(); };
    const follow = client.stream('session/follow', { request: { address: { kind: 'session', sessionId: task.sessionId }, maxMessages: 100 } }, {
      onItem: item => enqueue(async () => {
        if (item.type === 'snapshot') {
          await verifySessionDirectory(task, item.header);
          const generation = await this.historyReader(client, task.sessionId, { snapshot: item });
          await verifySessionDirectory(task, generation.header);
          events.splice(0, events.length, ...generation.events); snapshotReady = true;
        }
        if (item.type === 'event') { events.push(item.event); live.add(item.event.seq); }
        dirty = true;
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
    let closed = false;
    const close = async () => {
      if (closed) return; closed = true;
      active = false;
      try { for (const stream of streams) stream.close(); await flush(true); }
      finally { try { await expire(); } finally { await lease.release(); } }
    };
    try {
      await Promise.all(streams.map(s => s.ready));
      const deadline = Date.now() + 15000;
      while (!snapshotReady || !remoteReady) { if (failure) throw failure; if (Date.now() > deadline) throw fault('WATCH_READY_TIMEOUT'); await sleep(20); }
      await flush();
    } catch (error) { await close(); throw error; }
    return { client, close, tick: async () => {
      await flush();
      if (failure) { await expire(); throw failure; }
      const decisions = await this.store.transaction(state => {
        const selected = [];
        const task = state.tasks[id];
        for (const a of Object.values(task.approvals)) {
          if (a.watchId !== watchId) continue;
          if (task.stopRequested && ['PENDING','DECISION_QUEUED'].includes(a.state)) { a.state = 'EXPIRED'; continue; }
          if (a.state === 'PENDING') a.expiresAt = Date.now() + 5000;
          if (a.state === 'DECISION_QUEUED') { a.state = 'SENDING'; selected.push(structuredClone(a)); }
        }
        return selected;
      });
      for (const a of decisions) {
        await this.store.withLock(`dispatch-${identifier(id)}.lock`, async () => {
          // Initiate synchronously while holding the stop flag's state lock. Do
          // not hold that lock while awaiting the remote acknowledgement.
          const delivery = await this.store.transaction(state => {
            if (state.tasks[id].stopRequested) {
              state.tasks[id].approvals[a.eventId].state = 'EXPIRED';
              return null;
            }
            return { outcome: client.rpc('$events/result', { clientId, eventId: a.eventId, outcome: { kind: 'result', value: a.decision } }).then(() => 'RESULT_SENT_UNCONFIRMED', () => 'DELIVERY_UNKNOWN') };
          });
          if (delivery) {
            const outcome = await delivery.outcome;
            await this.store.transaction(state => { state.tasks[id].approvals[a.eventId].state = outcome; });
          }
        });
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
  async listen({ task: id, wait = 60, request, sinceCursor, sinceGeneration, onUpdate }) {
    if (!Number.isFinite(wait) || wait < 0 || wait > 60 || typeof onUpdate !== 'function') throw fault('INVALID_LISTEN');
    const watcher = await this.watch(id), deadline = Date.now() + wait * 1000;
    let last = sinceGeneration;
    const publish = async leaseOpen => {
      const task = await this.store.task(id);
      const value = taskView(summary(task), task, { request, sinceCursor, sinceGeneration: last });
      if (value.changed || !leaseOpen) { await onUpdate({ ...value, leaseOpen }); last = value.generation; }
      return task;
    };
    try {
      do {
        await watcher.tick();
        const task = await publish(true);
        if ((task.stopRequested && task.requests.every(r => terminal.has(r.state))) || (task.requests.at(-1) && terminal.has(task.requests.at(-1).state))) break;
        if (Date.now() >= deadline) break;
        await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
      } while (Date.now() <= deadline);
    } finally { await watcher.close(); await publish(false); }
  }
  async approvals({ task: id }) { return summary(await this.store.task(id)); }
  async usage({ task: id }) {
    const history = await this.refresh(id), task = await this.store.task(id);
    const { aggregateUsage } = await import('./usage.mjs');
    return { task: id, sessionId: task.sessionId, cursor: task.cursor, ...aggregateUsage(history.events, { requestIds: task.requests.map(r => r.requestId) }) };
  }
  async approve({ task: id, approval, decision }) {
    if (!['allowed-once', 'rejected'].includes(decision)) throw fault('INVALID_DECISION');
    return this.store.transaction(state => {
      const task = state.tasks[id]; if (!task) throw fault('TASK_NOT_FOUND');
      if (task.stopRequested) throw fault('TASK_STOPPED');
      const a = task.approvals[approval];
      if (!a || a.state !== 'PENDING' || a.expiresAt < Date.now()) throw fault('APPROVAL_EXPIRED');
      a.decision = decision; a.state = 'DECISION_QUEUED';
      return { task: id, approval, state: 'DECISION_QUEUED' };
    });
  }
  async stop({ task: id }) {
    const attemptId = randomUUID();
    await this.store.transaction(state => {
      const task = state.tasks[id]; if (!task) throw fault('TASK_NOT_FOUND');
      task.stopRequested = true; task.stopState = 'STOP_PENDING';
      task.stopReason = 'Verifying native activity; new submissions blocked';
      task.stopAttempt = { id: attemptId, startedAt: new Date().toISOString(), scope: task.scope, phase: 'watch-ready', cancelRequested: false };
      delete task.stopDiagnostic;
    });
    let watcher, phase = 'watch-ready';
    const record = patch => this.store.transaction(state => {
      if (state.tasks[id].stopAttempt.id === attemptId) Object.assign(state.tasks[id].stopAttempt, patch);
    });
    const snapshot = (task, queue, row) => ({
      running: typeof row?.running === 'boolean' ? row.running : null,
      queueCount: queue.length,
      ownedQueueCount: queue.filter(item => task.requests.some(r => r.requestId === item.source?.rpcId)).length,
      associatedTurns: [...new Set(task.requests.map(r => r.turn).filter(Number.isSafeInteger))],
    });
    try {
      const task = await this.store.task(id), client = await this.client(task);
      await this.store.withLock(`dispatch-${identifier(id)}.lock`, async () => {
      if (task.scope === 'exclusive') {
        try { watcher = await this.watch(id); }
        catch (error) { if (error.code !== 'STATE_LOCKED') throw error; }
      }
      phase = 'queue'; await record({ phase });
      const owned = new Set(task.requests.map(r => r.requestId));
      const queue = queued(await client.rpc('session/projections', { request: { sessionId: task.sessionId } }));
      await this.store.transaction(state => {
        if (queue.some(item => !owned.has(item.source?.rpcId))) state.tasks[id].sharedStopRequired = true;
      });
      await record({ before: snapshot(await this.store.task(id), queue) });
      for (const item of queue) if (owned.has(item.source?.rpcId) && item.id) await client.rpc('session/updateQueue', { request: { sessionId: task.sessionId, itemId: item.id, action: { kind: 'remove' } } });
      // Re-read observable history and queue before cancellation, including when another
      // observer owns the lease. Native has no cross-client atomic conditional cancel.
      await this.refresh(id, client);
      const latestQueue = queued(await client.rpc('session/projections', { request: { sessionId: task.sessionId } }));
      await this.store.transaction(state => {
        if (latestQueue.some(item => !owned.has(item.source?.rpcId))) state.tasks[id].sharedStopRequired = true;
      });
      const cancelSafe = task.scope === 'exclusive' && !(await this.store.task(id)).sharedStopRequired;
      if (!cancelSafe) await record({ cancelSkippedReason: task.scope === 'shared' ? 'shared-session' : 'foreign-or-unknown-native-activity' });
      // Shared semantics are sticky once foreign or unknown activity is observed.
      if (cancelSafe) {
        phase = 'cancel'; await record({ phase, cancelRequested: true });
        const started = Date.now();
        let ack;
        try { ack = await client.rpc('session/cancel', { request: { sessionId: task.sessionId } }); }
        finally { await record({ cancelAck: { ...(typeof ack?.accepted === 'boolean' ? { accepted: ack.accepted } : {}), durationMs: Date.now() - started } }); }
      }
      phase = 'reconcile'; await record({ phase });
      if (cancelSafe) {
        const deadline = Date.now() + 1500;
        do {
          if (watcher) await watcher.tick();
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
      const remainingQueue = queued(projection);
      await record({ after: snapshot(current, remainingQueue, row) });
      // Native tool inventory cannot prove every job/schedule/descendant stopped. Retain pending when any tool ran.
      const toolsSeen = current.observedToolCount > 0 || current.activity?.length || current.foreignRpcIds?.length;
      const unresolved = current.requests.some(r => ['SUBMISSION_UNKNOWN', 'SUBMITTING', 'SUBMITTED', 'UNKNOWN', 'RUNNING', 'QUEUED'].includes(r.state));
      const quiet = cancelSafe && !current.sharedStopRequired && row?.running === false && remainingQueue.length === 0 && !toolsSeen && !unresolved;
      await this.store.transaction(state => {
        if (state.tasks[id].stopAttempt.id === attemptId) {
          state.tasks[id].stopState = quiet ? 'STOPPED' : 'STOP_PENDING';
          state.tasks[id].stopReason = quiet ? 'Native session idle, owned queue empty, no observed tool activity' : 'Cannot prove all native activity stopped (shared session, tools, unknown submission or running activity)';
          Object.assign(state.tasks[id].stopAttempt, { phase: 'finished', endedAt: new Date().toISOString() });
          state.tasks[id].stopDiagnostic = { code: quiet ? 'STOP_VERIFIED_IDLE' : current.requests.some(r => r.state === 'RUNNING') ? 'STOP_REQUEST_RUNNING' : 'STOP_ACTIVITY_UNRESOLVED' };
        }
      });
      }, { timeoutMs: 20000 });
    } catch (error) {
      const diagnostic = safeDiagnostic(error?.diagnostic);
      await this.store.transaction(state => {
        if (state.tasks[id].stopAttempt.id === attemptId) {
          state.tasks[id].stopReason = 'Native stop outcome or activity is unknown; new submissions remain blocked';
          Object.assign(state.tasks[id].stopAttempt, { phase: 'failed', failedPhase: phase, endedAt: new Date().toISOString() });
          const code = { 'watch-ready': 'STOP_WATCH_READY_FAILED', queue: 'STOP_QUEUE_FAILED', cancel: 'STOP_CANCEL_UNKNOWN', reconcile: 'STOP_RECONCILE_FAILED' }[phase];
          state.tasks[id].stopDiagnostic = { code, ...(diagnostic ? { diagnostic } : {}) };
        }
      });
    } finally { if (watcher) await watcher.close(); }
    return summary(await this.store.task(id));
  }
}
