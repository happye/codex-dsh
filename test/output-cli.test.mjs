import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StateStore } from '../src/store.mjs';
import { Controller } from '../src/controller.mjs';
import { ContractService } from '../src/contract.mjs';
import { runCli } from '../src/cli.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dsh-output-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await StateStore.open(path.join(root, 'state'));
  const cli = async args => {
    let stdout = '', stderr = '';
    const code = await runCli([...args, '--state-dir', store.directory], {
      stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
    });
    return { code, stdout, stderr };
  };
  return { store, cli };
}

test('invalid output budget is rejected before a private prompt or ledger is read', async () => {
  for (const value of ['bad', '-1', '1023', '1024.5', '1048577']) {
    let error = '';
    const code = await runCli(['send', '--task', 'demo', '--text-file', 'PRIVATE-NOT-READ', '--allow-model', '--output-budget-bytes', value], {
      stdout: { write() { assert.fail('unexpected dispatch'); } }, stderr: { write: text => { error += text; } },
    });
    assert.equal(code, 2); assert.deepEqual(JSON.parse(error), { error: 'INVALID_OUTPUT_BUDGET' });
  }
});

test('opt-in oversized CLI output preserves exact JSON while default and zero remain compatible', async t => {
  const f = await fixture(t);
  await f.store.transaction(state => {
    state.connections.local = { baseUrl: 'http://127.0.0.1:1', cookie: 'SECRET-COOKIE' };
    for (let i = 0; i < 100; i++) state.tasks[`task-${i}`] = { id: `task-${i}`, connection: 'local', cwd: `/fixture/project-${i}`, sessionId: `session-${i}` };
  });
  const original = await f.cli(['connections']);
  assert.equal(original.code, 0);
  assert.equal((await f.cli(['connections', '--output-budget-bytes', '0'])).stdout, original.stdout);
  const output = await f.cli(['connections', '--output-budget-bytes', '1024']);
  assert.equal(output.code, 0); assert.equal(output.stderr, '');
  const envelope = JSON.parse(output.stdout);
  assert.equal(envelope.schema, 'dsh-output/v1'); assert.equal(envelope.truncated, true);
  assert.deepEqual(envelope.summary.source, { executionRoot: null, baseCommit: null, sourceManifestSha: null });
  const raw = await fs.readFile(envelope.artifactRef.path);
  assert.deepEqual(JSON.parse(raw), JSON.parse(original.stdout));
  assert.equal(raw.length, envelope.artifactRef.bytes); assert.equal(sha(raw), envelope.artifactRef.sha256);
  assert.ok(!output.stdout.includes('SECRET-COOKIE'));
});

test('listen keeps JSONL lease and actionable signals across budget envelopes', async t => {
  const f = await fixture(t), original = Controller.prototype.listen;
  t.after(() => { Controller.prototype.listen = original; });
  const operation = { path: 'review.txt', description: 'permission detail '.repeat(300) };
  Controller.prototype.listen = async ({ onUpdate }) => {
    for (const value of [
      { state: 'SUBMISSION_UNKNOWN', blocked: false, leaseOpen: true, approvals: [{ eventId: 'approval', state: 'PENDING', operation }] },
      { state: 'STOP_PENDING', blocked: true, leaseOpen: false, approvals: [], stopAttempt: { cancelAck: { accepted: true } }, stopReason: 'Native activity remains unknown' },
    ]) await onUpdate({ ...value, task: 'demo', bulk: 'PRIVATE-OMITTED'.repeat(500) });
  };
  const output = await f.cli(['listen', '--task', 'demo', '--output-budget-bytes', '1024']);
  assert.equal(output.code, 0);
  const rows = output.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2); assert.equal(rows[0].summary.state, 'SUBMISSION_UNKNOWN');
  assert.equal(rows[0].summary.leaseOpen, true); assert.deepEqual(rows[0].summary.approvals[0].operation, operation);
  assert.equal(rows[0].budgetExceeded, true);
  assert.equal(rows[1].summary.state, 'STOP_PENDING'); assert.equal(rows[1].summary.leaseOpen, false);
  assert.deepEqual(rows[1].summary.stopAttempt.cancelAck, { accepted: true });
  assert.ok(!output.stdout.includes('PRIVATE-OMITTED'));
});

test('budgeted receipt reads integrity-checked logs and rejects a changed raw asset', async t => {
  const f = await fixture(t), original = ContractService.prototype.receipt;
  t.after(() => { ContractService.prototype.receipt = original; });
  const stdout = Buffer.from('E RuntimeError: SECRET-IN-LOG\n'.repeat(3506));
  await f.store.writeFile('run-fixture.stdout', stdout); await f.store.writeFile('run-fixture.stderr', '');
  const ref = { file: 'run-fixture.stdout', bytes: stdout.length, sha256: sha(stdout) };
  ContractService.prototype.receipt = async () => ({
    schema: 'dsh-run/v1', runId: 'run-fixture', task: 'demo', exitCode: 1, passed: false, valid: true,
    stdout: ref, stderr: { file: 'run-fixture.stderr', bytes: 0, sha256: sha(Buffer.alloc(0)) },
    pytest: { collected: Array.from({ length: 3506 }, (_, i) => `tests/test_fixture.py::case_${i}`) },
  });
  const args = ['receipt', '--task', 'demo', '--run', 'run-fixture', '--output-budget-bytes', '1024'];
  const output = await f.cli(args);
  assert.equal(output.code, 0); assert.equal(JSON.parse(output.stdout).summary.passed, false);
  assert.ok(!output.stdout.includes('SECRET-IN-LOG'));
  await f.store.writeFile('run-fixture.stdout', 'changed raw log');
  const rejected = await f.cli(args);
  assert.equal(rejected.code, 3);
  const failure = JSON.parse(rejected.stdout);
  assert.equal(failure.projectionFailed, true); assert.equal(failure.summary.passed, false);
  assert.deepEqual(JSON.parse(rejected.stderr), { error: 'EVIDENCE_TAMPERED' });
});

for (const command of ['send', 'stop']) test(`output storage failure after ${command} keeps observed state without retry`, async t => {
  const f = await fixture(t), original = Controller.prototype[command], write = StateStore.prototype.writeFile;
  t.after(() => { Controller.prototype[command] = original; StateStore.prototype.writeFile = write; });
  const prompt = f.store.file('prompt.txt'); await fs.writeFile(prompt, 'fixture prompt');
  let calls = 0;
  Controller.prototype[command] = async () => {
    calls++;
    return { task: 'demo', state: command === 'send' ? 'SUBMISSION_UNKNOWN' : 'STOP_PENDING', blocked: command === 'stop',
      requests: [{ requestId: 'request', state: 'SUBMISSION_UNKNOWN' }],
      stopAttempt: { cancelAck: { accepted: true } }, bulk: 'PRIVATE-OMITTED'.repeat(500) };
  };
  StateStore.prototype.writeFile = async function(name, bytes) {
    if (name.startsWith('output-')) throw Object.assign(new Error('PRIVATE-IO-DETAILS'), { code: 'ENOSPC' });
    return write.call(this, name, bytes);
  };
  const args = [command, '--task', 'demo', '--output-budget-bytes', '1024'];
  if (command === 'send') args.push('--text-file', prompt, '--allow-model');
  const output = await f.cli(args), value = JSON.parse(output.stdout);
  assert.equal(output.code, 4); assert.equal(calls, 1);
  assert.equal(value.projectionFailed, true); assert.equal(value.artifactRef, null);
  assert.equal(value.summary.state, command === 'send' ? 'SUBMISSION_UNKNOWN' : 'STOP_PENDING');
  assert.equal(value.summary.requests[0].state, 'SUBMISSION_UNKNOWN');
  assert.ok(!output.stdout.includes('PRIVATE-')); assert.ok(!output.stderr.includes('PRIVATE-'));
});

test('oversized contract projection keeps bound identity and source while missing metadata stays unknown', async t => {
  const f = await fixture(t), original = ContractService.prototype.inspect;
  t.after(() => { ContractService.prototype.inspect = original; });
  ContractService.prototype.inspect = async () => ({
    contractSha: 'a'.repeat(64), binding: { task: 'demo', sessionId: 'native', nativeCwd: '/fixture/native' },
    contract: { id: 'contract', revision: 2, gitOwner: 'Codex', executionRoot: '/fixture/execution', requirements: Array(1000).fill({ text: 'PRIVATE-REQUIREMENT' }) },
    baseline: { head: 'base-commit', fingerprint: 'source-sha', files: {} },
  });
  const output = await f.cli(['contract', '--task', 'demo', '--output-budget-bytes', '1024']);
  assert.equal(output.code, 0);
  const summary = JSON.parse(output.stdout).summary;
  assert.deepEqual(summary.source, { executionRoot: '/fixture/execution', baseCommit: 'base-commit', sourceManifestSha: 'source-sha' });
  assert.equal(summary.binding.sessionId, 'native'); assert.equal(summary.contractIdentity.revision, 2);
  assert.ok(!output.stdout.includes('PRIVATE-REQUIREMENT'));
});
