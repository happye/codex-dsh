import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { StateStore } from '../src/store.mjs';
import { runCli } from '../src/cli.mjs';

test('CLI exposes safe native internal-error context without treating create as unexecuted', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dsh-cli-safety-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secret = 'private-response-and-cookie';
  const server = http.createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += chunk;
    const frame = JSON.parse(data);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ rpcId: frame.rpcId, result: { ok: false, error: {
      code: 'gateway/internal', message: secret, details: { token: secret, body: secret },
    } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const store = await StateStore.open(path.join(root, 'state'));
  await store.transaction(state => { state.connections.fixture = { baseUrl: `http://127.0.0.1:${server.address().port}`, cookie: secret }; });
  let output = '', error = '';
  const code = await runCli(['start', '--connection', 'fixture', '--cwd', root, '--task', 'internal', '--state-dir', store.directory], {
    stdout: { write: text => { output += text; } }, stderr: { write: text => { error += text; } },
  });
  assert.equal(code, 4);
  assert.equal(output, '');
  const failure = JSON.parse(error);
  assert.equal(failure.error, 'RPC_REJECTED');
  assert.equal(failure.diagnostic.stage, 'rpc');
  assert.equal(failure.diagnostic.knownRejected, false);
  assert.equal(failure.diagnostic.method, 'session/create');
  assert.ok(!error.includes(secret));
  assert.equal((await store.task('internal')).state, 'CREATE_UNKNOWN');
});

test('CLI rejects mixed recovery selectors before touching a ledger', async () => {
  let error = '';
  const code = await runCli(['recover', '--task', 'one', '--connection', 'native'], {
    stdout: { write() { assert.fail('unexpected success output'); } }, stderr: { write: text => { error += text; } },
  });
  assert.equal(code, 2);
  assert.deepEqual(JSON.parse(error), { error: 'USAGE' });
});

test('invalid send view options are rejected before ledger access or reading the prompt',async()=>{
  for(const args of [['--since-generation','bad'],['--request','previous-request']]){
    let error='';
    const code=await runCli(['send','--task','demo','--text-file','PRIVATE-DO-NOT-READ','--allow-model',...args],{stdout:{write(){assert.fail('unexpected dispatch');}},stderr:{write:text=>{error+=text;}}});
    assert.equal(code,2);assert.ok(!error.includes('PRIVATE'));assert.match(error,/INVALID_(GENERATION|REQUEST_SELECTOR)/);
  }
});
