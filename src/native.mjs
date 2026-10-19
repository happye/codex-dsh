import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { normalizeEvents } from './events.mjs';

function failure(code, knownRejected = false) {
  return Object.assign(new Error(`Native control: ${code}`), { code, knownRejected });
}

function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('INVALID_URL', true); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password) {
    throw failure('UNSAFE_URL', true);
  }
  return url;
}

export class NativeClient {
  constructor({ baseUrl, cookie, timeoutMs = 15000 }) {
    this.baseUrl = origin(baseUrl).origin;
    this.cookie = cookie ?? '';
    this.timeoutMs = timeoutMs;
  }

  static async connect({ url, token, cookie, timeoutMs = 15000 }) {
    const address = origin(url);
    token ??= address.searchParams.get('token');
    const baseUrl = address.origin;
    if (cookie) return { baseUrl, cookie };
    if (!token) throw failure('AUTH_REQUIRED', true);
    const exchange = new URL('/', baseUrl);
    exchange.searchParams.set('token', token);
    let response;
    try {
      response = await fetch(exchange, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw failure('AUTH_TRANSPORT_UNKNOWN'); }
    const cookies = response.headers.getSetCookie();
    if (![200, 302, 303].includes(response.status) || !cookies.length) throw failure('AUTH_REJECTED', true);
    const location = response.headers.get('location');
    if (location && new URL(location, baseUrl).origin !== baseUrl) throw failure('AUTH_REDIRECT_REJECTED', true);
    return { baseUrl, cookie: cookies.map(item => item.split(';', 1)[0]).join('; ') };
  }

  async rpc(method, args = {}, { signal } = {}) {
    const rpcId = randomUUID();
    let response;
    try {
      response = await fetch(new URL(`/api/${encodeURI(method)}`, this.baseUrl), {
        method: 'POST', redirect: 'manual',
        headers: { cookie: this.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
    } catch { throw failure('RPC_TRANSPORT_UNKNOWN'); }
    // Authentication/trust denial explicitly rejects before RPC dispatch. Other
    // HTTP statuses alone cannot establish whether a mutation executed.
    if ([401, 403].includes(response.status)) throw failure(`RPC_HTTP_${response.status}`, true);
    let body;
    try { body = await response.json(); } catch { throw failure(`RPC_HTTP_${response.status}`); }
    if (body.rpcId !== rpcId || typeof body.result?.ok !== 'boolean') throw failure('RPC_PROTOCOL_UNKNOWN');
    if (!body.result.ok) throw failure('RPC_REJECTED', true);
    if (!response.ok) throw failure(`RPC_HTTP_${response.status}`);
    return body.result.value;
  }

  stream(endpoint, args = {}, { onItem, onError, onClose, signal } = {}) {
    let readyResolve, readyReject, closedResolve, closedReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const closed = new Promise((resolve, reject) => { closedResolve = resolve; closedReject = reject; });
    // Consumers may await ready first; preserve rejection while avoiding a premature unhandled rejection.
    ready.catch(() => {});
    closed.catch(() => {});
    const streamId = randomUUID();
    const address = new URL('/api/remote.mux', this.baseUrl);
    address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws, finished = false, opened = false;
    let timer;
    const abort = () => finish(failure('STREAM_ABORTED'));
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'cancel', streamId }), () => {});
        ws.close();
        // No orphan socket if a peer ignores the close handshake.
        const cleanup = setTimeout(() => ws.terminate(), 1000);
        cleanup.unref();
        ws.once('close', () => clearTimeout(cleanup));
      } else if (ws?.readyState === WebSocket.CONNECTING) ws.terminate();
      if (!opened) readyReject(error ?? failure('STREAM_CLOSED_BEFORE_READY'));
      if (error) closedReject(error); else closedResolve();
      try { if (error) onError?.(error); } catch { /* promises still carry the transport failure */ }
      try { onClose?.(error); } catch { /* callback must not prevent cleanup */ }
    };
    const handle = { ready, closed, close: () => finish() };
    if (signal?.aborted) { queueMicrotask(abort); return handle; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(failure('STREAM_OPEN_TIMEOUT')), this.timeoutMs);
    try {
      const openFrame = JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } });
      ws = new WebSocket(address, { headers: { cookie: this.cookie }, maxPayload: 0, followRedirects: false });
      ws.on('open', () => {
        if (finished) return;
        ws.send(openFrame, error => {
          if (finished) return;
          if (error) return finish(failure('STREAM_SEND_UNKNOWN'));
          clearTimeout(timer);
          opened = true;
          readyResolve();
        });
      });
      ws.on('message', (raw, binary) => {
        if (finished) return;
        let frame;
        try { if (binary) throw Error(); frame = JSON.parse(raw.toString()); } catch { return finish(failure('STREAM_PROTOCOL_UNKNOWN')); }
        if (frame.streamId !== streamId) return finish(failure('STREAM_ID_MISMATCH'));
        if (frame.type === 'error') return finish(failure('STREAM_REMOTE_ERROR', true));
        if (frame.type === 'end') return finish();
        if (frame.type !== 'item') return finish(failure('STREAM_PROTOCOL_UNKNOWN'));
        try { onItem?.(frame.value); } catch { finish(failure('STREAM_ITEM_CALLBACK')); }
      });
      ws.on('error', () => finish(failure('STREAM_TRANSPORT_UNKNOWN')));
      ws.on('close', () => { if (!finished) finish(failure('STREAM_DISCONNECTED')); });
    } catch { finish(failure('STREAM_TRANSPORT_UNKNOWN')); }
    return handle;
  }
}

export async function readHistory(client, sessionId, { maxMessages = 100, signal, snapshot: suppliedSnapshot } = {}) {
  const address = { kind: 'session', sessionId };
  let handle;
  let resolveSnapshot, rejectSnapshot;
  const opening = new Promise((resolve, reject) => { resolveSnapshot = resolve; rejectSnapshot = reject; });
  let timer;
  try {
    signal?.throwIfAborted();
    let snapshot = suppliedSnapshot;
    if (snapshot === undefined) {
      timer = setTimeout(() => rejectSnapshot(failure('HISTORY_OPEN_TIMEOUT')), client.timeoutMs ?? 15000);
      handle = client.stream('session/follow', { request: { address, maxMessages } }, {
        signal,
        onItem: item => { if (item?.type === 'snapshot') resolveSnapshot(item); },
        onError: rejectSnapshot,
        onClose: error => rejectSnapshot(error ?? failure('HISTORY_NO_SNAPSHOT')),
      });
      handle.ready.catch(rejectSnapshot);
      snapshot = await opening;
    }
    clearTimeout(timer);
    handle?.close();
    if (snapshot?.type !== 'snapshot' || snapshot.header?.id !== sessionId || !Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < -1) throw failure('HISTORY_IDENTITY');
    const unpack = records => {
      if (!Array.isArray(records) || records.some(record => record.type !== 'event' || !record.event)) throw failure('HISTORY_RECORD');
      return normalizeEvents(records.map(record => record.event), { contiguous: true });
    };
    let events = unpack(snapshot.records);
    let hasMore = snapshot.hasMore;
    if (events.at(-1)?.seq !== snapshot.cursor && !(events.length === 0 && snapshot.cursor === -1)) throw failure('HISTORY_CURSOR_GAP');
    while (hasMore) {
      signal?.throwIfAborted();
      const beforeSeq = events[0]?.seq;
      if (beforeSeq === undefined || beforeSeq <= 0) throw failure('HISTORY_NO_PROGRESS');
      const page = await client.rpc('session/page', { request: { address, throughSeq: snapshot.cursor, beforeSeq, maxMessages } }, { signal });
      const older = unpack(page.records);
      // Merge also validates overlapping records before deciding progress.
      const merged = normalizeEvents([...older, ...events], { contiguous: true });
      if (!older.length || merged[0].seq >= beforeSeq || older.at(-1).seq >= beforeSeq) throw failure('HISTORY_NO_PROGRESS');
      events = merged;
      hasMore = page.hasMore;
    }
    if (typeof hasMore !== 'boolean' || (events.length && events[0].seq !== 0)) throw failure('HISTORY_PREFIX_GAP');
    return { header: snapshot.header, cursor: snapshot.cursor, events, hasMore: false, source: 'snapshot' };
  } finally { clearTimeout(timer); handle?.close(); }
}
