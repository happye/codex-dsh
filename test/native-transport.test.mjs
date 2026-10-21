import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { NativeClient, readHistory, safeDiagnostic } from '../src/native.mjs';

async function fixture(t, handler, streamHandler) {
  const server = http.createServer(handler);
  const wss = new WebSocketServer({ server });
  if (streamHandler) wss.on('connection', streamHandler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks));
}

test('exchanges native token without following redirects; RPC preserves full arguments', async t => {
  const large = 'x'.repeat(2 * 1024 * 1024);
  const baseUrl = await fixture(t, async (request, response) => {
    if (request.method === 'GET') {
      assert.equal(new URL(request.url, 'http://test').searchParams.get('token'), 'fixture-token');
      response.writeHead(302, { 'set-cookie': 'dsh=fixture-cookie; HttpOnly', location: '/' });
      return response.end();
    }
    assert.equal(request.headers.cookie, 'dsh=fixture-cookie');
    const message = await body(request);
    assert.equal(message.payload.args.request.text, large);
    response.end(JSON.stringify({ rpcId: message.rpcId, result: { ok: true, value: large } }));
  });
  const config = await NativeClient.connect({ url: `${baseUrl}/?token=fixture-token` });
  const client = new NativeClient(config);
  assert.equal(await client.rpc('session/prompt', { request: { text: large } }), large);
  await assert.rejects(NativeClient.connect({ url: 'http://example.invalid/?token=secret' }), error => error.code === 'UNSAFE_URL' && !error.message.includes('secret'));
});

test('RPC distinguishes explicit rejection, protocol mismatch and lost response', async t => {
  const baseUrl = await fixture(t, async (request, response) => {
    const message = await body(request);
    if (message.method === 'lost') return request.socket.destroy();
    if (message.method === 'unauthorized') { response.writeHead(401); return response.end(); }
    if (message.method === 'http-error') { response.writeHead(500); return response.end(); }
    if (message.method === 'reject') return response.end(JSON.stringify({ rpcId: message.rpcId, result: { ok: false, error: { message: 'secret' } } }));
    response.end(JSON.stringify({ rpcId: 'wrong', result: { ok: true } }));
  });
  const client = new NativeClient({ baseUrl });
  await assert.rejects(client.rpc('reject'), error => !error.knownRejected && !error.message.includes('secret'));
  await assert.rejects(client.rpc('mismatch'), error => !error.knownRejected);
  await assert.rejects(client.rpc('lost'), error => !error.knownRejected);
  await assert.rejects(client.rpc('unauthorized'), error => error.knownRejected);
  await assert.rejects(client.rpc('http-error'), error => !error.knownRejected);
});

test('RPC rejection exposes a safe category and local correlation instead of native payload', async t => {
  let rpcId;
  const secret = 'cookie=private-token https://private.invalid/?token=secret C:\\private\\session';
  const baseUrl = await fixture(t, async (request, response) => {
    const message = await body(request);
    rpcId = message.rpcId;
    response.end(JSON.stringify({ rpcId, result: { ok: false, error: { code: 'gateway/lookup-not-found', message: secret, payload: secret } } }));
  });
  await assert.rejects(new NativeClient({ baseUrl, cookie: secret }).rpc('session/prompt', { secret }), error => {
    assert.equal(error.code, 'RPC_REJECTED');
    assert.deepEqual(error.diagnostic, { stage: 'rpc', category: 'not_found', knownRejected: true, method: 'session/prompt', rpcId, httpStatus: 200 });
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!error.message.includes(secret));
    return true;
  });
});

test('RPC diagnostics do not trust mismatched rejections, malformed responses or HTTP ambiguity', async t => {
  const baseUrl = await fixture(t, async (request, response) => {
    const message = await body(request);
    const mode = message.payload.args.mode;
    if (mode === 'lost') return request.socket.destroy();
    if (mode === 'unauthorized' || mode === 'forbidden') {
      response.writeHead(mode === 'unauthorized' ? 401 : 403);
      return response.end('private response');
    }
    if (mode === 'malformed') { response.writeHead(500); return response.end('private response'); }
    if (mode === 'null') return response.end('null');
    if (mode === 'http-error') response.writeHead(500);
    response.end(JSON.stringify({ rpcId: mode === 'mismatch' ? 'private-server-id' : message.rpcId, result: { ok: mode === 'http-error', error: { code: 'gateway/arguments-invalid', message: 'private response' } } }));
  });
  for (const [mode, category, knownRejected, httpStatus] of [
    ['mismatch', 'protocol_unknown', false, 200], ['null', 'protocol_unknown', false, 200],
    ['lost', 'transport_unknown', false, undefined], ['malformed', 'protocol_unknown', false, 500],
    ['http-error', 'protocol_unknown', false, 500],
    ['unauthorized', 'authentication', true, 401], ['forbidden', 'permission', true, 403],
  ]) {
    await assert.rejects(new NativeClient({ baseUrl }).rpc('session/prompt', { mode }), error => {
      assert.equal(error.knownRejected, knownRejected);
      assert.equal(error.diagnostic.knownRejected, knownRejected);
      assert.equal(error.diagnostic.category, category);
      assert.equal(error.diagnostic.httpStatus, httpStatus);
      assert.match(error.diagnostic.rpcId, /^[0-9a-f-]{36}$/);
      assert.ok(!JSON.stringify(error).includes('private'));
      return true;
    });
  }
});

test('unknown native discriminators and method input cannot become diagnostic text', async t => {
  const secret = 'credential/body?token=private C:\\private\\session';
  const baseUrl = await fixture(t, async (request, response) => {
    const message = await body(request);
    response.end(JSON.stringify({ rpcId: message.rpcId, result: { ok: false, error: message.payload.args.error } }));
  });
  for (const error of [{ code: secret, message: 'gateway/arguments-invalid', type: 'gateway/lookup-not-found' }, { code: { code: 'gateway/input-invalid' } }, { code: 'gateway/input-invalid ' }, { code: 'FORBIDDEN' }, secret, null]) {
    await assert.rejects(new NativeClient({ baseUrl }).rpc('private-method?token=private', { error }), failure => {
      assert.equal(failure.code, 'RPC_REJECTED');
      assert.equal(failure.diagnostic.category, 'rejected');
      assert.equal(failure.diagnostic.knownRejected, false);
      assert.equal(failure.diagnostic.method, undefined);
      assert.ok(!JSON.stringify(failure).includes('private'));
      return true;
    });
  }
});

test('safeDiagnostic picks fixed fields and rejects unrecognized diagnostics', () => {
  const input = { stage: 'rpc', category: 'rejected', knownRejected: true, method: 'session/prompt', rpcId: '12345678-1234-4123-8123-123456789abc', httpStatus: 403, message: 'private', payload: 'private' };
  assert.deepEqual(safeDiagnostic(input), { stage: 'rpc', category: 'rejected', knownRejected: true, method: input.method, rpcId: input.rpcId, httpStatus: 403 });
  assert.equal(safeDiagnostic({ ...input, category: 'private' }), undefined);
  assert.equal(safeDiagnostic({ ...input, stage: 'private' }), undefined);
  assert.equal(safeDiagnostic({ ...input, knownRejected: 'true' }), undefined);
  assert.deepEqual(safeDiagnostic({ ...input, method: 'private', rpcId: 'private', httpStatus: '403' }), { stage: 'rpc', category: 'rejected', knownRejected: true });
});

test('stream diagnostics validate identity and never infer pre-dispatch rejection from an error code', async t => {
  let count = 0;
  const baseUrl = await fixture(t, undefined, ws => ws.on('message', raw => {
    const frame = JSON.parse(raw);
    if (frame.type !== 'open') return;
    ws.send(JSON.stringify({ type: 'error', streamId: count++ === 0 ? 'private-id' : frame.streamId, error: { code: 'gateway/input-invalid', message: 'private-native-message' } }));
  }));
  for (const [category, knownRejected] of [['protocol_unknown', false], ['invalid_request', false]]) {
    const stream = new NativeClient({ baseUrl }).stream('session/follow');
    await stream.ready;
    await assert.rejects(stream.closed, error => {
      assert.equal(error.diagnostic.category, category);
      assert.equal(error.diagnostic.knownRejected, knownRejected);
      assert.ok(!JSON.stringify(error).includes('private'));
      return true;
    });
  }
});

test('native error categories distinguish boundary rejection from failures with possible effects', async t => {
  const baseUrl = await fixture(t, async (request, response) => {
    const message = await body(request);
    response.end(JSON.stringify({ rpcId: message.rpcId, result: { ok: false, error: { code: message.payload.args.code, message: 'private-native-message', details: { requestedCwd: 'C:\\private' } } } }));
  });
  for (const [code, category, knownRejected] of [
    ['gateway/arguments-invalid', 'invalid_request', true], ['gateway/input-invalid', 'invalid_request', true],
    ['gateway/definition-unavailable', 'unavailable', true], ['gateway/method-unavailable', 'unavailable', true],
    ['session/conflict', 'conflict', false], ['session/agent-busy', 'conflict', false],
    ['session/not-found', 'not_found', false], ['session/provider-credentials-unavailable', 'unavailable', false],
    ['gateway/internal', 'unavailable', false], ['gateway/cancelled', 'aborted', false],
    ['gateway/result-invalid', 'protocol_unknown', false], ['gateway/bad-request', 'invalid_request', false],
    ['unknown/provider-error', 'rejected', false], [undefined, 'rejected', false],
  ]) {
    await assert.rejects(new NativeClient({ baseUrl }).rpc('session/prompt', { code }), error => {
      assert.equal(error.code, 'RPC_REJECTED');
      assert.equal(error.knownRejected, knownRejected, code);
      assert.equal(error.diagnostic.knownRejected, knownRejected, code);
      assert.equal(error.diagnostic.category, category, code);
      assert.ok(!JSON.stringify(error).includes('private'));
      assert.ok(!JSON.stringify(error).includes(code ?? 'undefined'));
      return true;
    });
  }
});

test('raw stream has no experimental payload limit and asynchronously reports disconnect', async t => {
  const large = '原生'.repeat(700000);
  const baseUrl = await fixture(t, undefined, ws => ws.on('message', raw => {
    const frame = JSON.parse(raw);
    if (frame.type !== 'open') return;
    ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: large }), () => setImmediate(() => ws.terminate()));
  }));
  const values = [], errors = [], closes = [];
  const handle = new NativeClient({ baseUrl }).stream('session/follow', {}, { onItem: value => values.push(value), onError: error => errors.push(error), onClose: error => closes.push(error) });
  await handle.ready;
  await assert.rejects(handle.closed, { code: 'STREAM_DISCONNECTED' });
  assert.equal(values[0], large);
  assert.equal(errors.length, 1);
  assert.equal(closes.length, 1);
});

test('pre-aborted and connection-refused streams settle both lifecycle promises', async () => {
  const client = new NativeClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 200 });
  for (const signal of [AbortSignal.abort(), undefined]) {
    const stream = client.stream('session/follow', {}, { signal });
    await assert.rejects(stream.ready);
    await assert.rejects(stream.closed);
    stream.close();
  }
});

const record = seq => ({ type: 'event', event: { seq, type: 'fixture/event', data: {}, time: 1 } });
function historyClient(snapshot, pages) {
  let closed = false;
  return { timeoutMs: 1000, get isClosed() { return closed; },
    stream(endpoint, args, { onItem }) {
      assert.equal(endpoint, 'session/follow');
      queueMicrotask(() => onItem(snapshot));
      return { ready: Promise.resolve(), closed: Promise.resolve(), close() { closed = true; } };
    },
    async rpc(endpoint, args) {
      assert.equal(closed, true);
      assert.equal(endpoint, 'session/page');
      assert.equal(args.request.throughSeq, snapshot.cursor);
      const page = pages.shift();
      assert.equal(args.request.beforeSeq, page.beforeSeq);
      return page;
    },
  };
}
test('history walks pages at one snapshot cut and validates dense complete history', async () => {
  const client = historyClient({ type: 'snapshot', header: { id: 's' }, cursor: 5, records: [record(4), record(5)], hasMore: true }, [
    { beforeSeq: 4, records: [record(2), record(3)], hasMore: true },
    { beforeSeq: 2, records: [record(0), record(1)], hasMore: false },
  ]);
  const result = await readHistory(client, 's');
  assert.deepEqual(result.events.map(event => event.seq), [0, 1, 2, 3, 4, 5]);
  assert.equal(result.hasMore, false);
});

test('history fails rather than looping or accepting conflicting/gapped pages', async () => {
  for (const records of [[], [record(3)], [record(0), record(2)], [record(0), { ...record(3), event: { ...record(3).event, data: { conflict: true } } }]]) {
    const client = historyClient({ type: 'snapshot', header: { id: 's' }, cursor: 3, records: [record(3)], hasMore: true }, [
      { beforeSeq: 3, records, hasMore: true },
    ]);
    await assert.rejects(readHistory(client, 's'));
    assert.equal(client.isClosed, true);
  }
});

test('history reuses a watch opening snapshot without opening or closing the watch', async () => {
  const snapshot = { type: 'snapshot', header: { id: 's' }, cursor: 1, records: [record(1)], hasMore: true };
  const client = {
    stream() { assert.fail('must not open another follow'); },
    async rpc(endpoint, args) {
      assert.equal(args.request.throughSeq, 1);
      assert.equal(args.request.beforeSeq, 1);
      return { records: [record(0)], hasMore: false };
    },
  };
  assert.deepEqual((await readHistory(client, 's', { snapshot })).events.map(event => event.seq), [0, 1]);
});
