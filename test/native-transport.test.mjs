import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { NativeClient, readHistory } from '../src/native.mjs';

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
  await assert.rejects(client.rpc('reject'), error => error.knownRejected && !error.message.includes('secret'));
  await assert.rejects(client.rpc('mismatch'), error => !error.knownRejected);
  await assert.rejects(client.rpc('lost'), error => !error.knownRejected);
  await assert.rejects(client.rpc('unauthorized'), error => error.knownRejected);
  await assert.rejects(client.rpc('http-error'), error => !error.knownRejected);
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
