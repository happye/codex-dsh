import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { budgetOutput, outputFailure, validateOutputBudget } from '../src/output.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function storage() {
  const files = new Map();
  return { files, async writeFile(file, bytes) { assert.ok(!files.has(file)); files.set(file, Buffer.from(bytes)); return `private/${file}`; } };
}
const large = () => ({ state: 'RUNNING', privateBody: 'private-body-秘密'.repeat(1500) });
const ref = (file, text) => ({ file, bytes: Buffer.byteLength(text), sha256: digest(text) });
function verifySize(value) { assert.equal(value.statistics.visibleBytes, Buffer.byteLength(JSON.stringify(value))); }

test('budget validation accepts only disabled or bounded integer byte budgets', () => {
  assert.equal(validateOutputBudget(undefined), undefined);
  for (const value of [0, '0', 1024, '16384', 1048576]) assert.equal(validateOutputBudget(value), Number(value));
  for (const value of [null, false, '', ' ', '1e4', '1024.0', 1, 1023, 1048577, -1, Infinity, NaN, {}, [], 1024.5]) assert.throws(() => validateOutputBudget(value), { code: 'INVALID_OUTPUT_BUDGET' });
});

test('disabled and within-budget output retain the original value and never write assets', async () => {
  const store = storage(), original = large();
  for (const budgetBytes of [undefined, 0]) assert.equal(await budgetOutput(original, { store, budgetBytes }), original);
  const exact = { body: 'a'.repeat(1013) }; // JSON overhead is eleven bytes.
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 1024);
  assert.equal(await budgetOutput(exact, { store, budgetBytes: 1024 }), exact);
  assert.equal(store.files.size, 0);
});

test('UTF8 bytes trigger projection; originals are exact, uniquely named and fingerprinted', async () => {
  const store = storage(), original = { state: 'RUNNING', body: '中'.repeat(400) };
  assert.ok(JSON.stringify(original).length < 1024);
  const result = await budgetOutput(original, { store, budgetBytes: 1024, command: 'status' });
  assert.equal(result.schema, 'dsh-output/v1'); assert.equal(result.truncated, true);
  const bytes = store.files.get(result.artifactRef.file);
  assert.deepEqual(bytes, Buffer.from(JSON.stringify(original)));
  assert.equal(result.artifactRef.sha256, digest(bytes)); assert.equal(result.artifactRef.bytes, bytes.length);
  assert.equal(result.statistics.fullBytes, bytes.length); verifySize(result);
  assert.equal(result.statistics.codexUsage, null); assert.equal(result.statistics.dshUsage, null);
  const again = await budgetOutput(original, { store, budgetBytes: 1024 });
  assert.notEqual(result.artifactRef.file, again.artifactRef.file);
});

test('huge contracts, baselines, pytest nodeids and unknown private values stay in originals', async () => {
  const secret = 'PRIVATE-SENTINEL', nodes = Array.from({ length: 3506 }, (_, i) => `${secret}/test.py::case${i}`);
  const original = { ...large(), sourceBefore: 'source-a', sourceAfter: 'source-a', testFingerprint: 'test-a', scope: 'targeted', exitCode: 1, valid: true, passed: false, evidenceComplete: false, reused: false,
    argv: [secret], expectedNodeids: nodes, contract: { [secret]: nodes }, baseline: { files: nodes },
    pytest: { collected: nodes, outcomes: nodes.map(nodeid => ({ nodeid, outcome: 'failed', when: 'call' })), exitstatus: 1, finished: true }, unknown: { state: secret } };
  const result = await budgetOutput(original, { store: storage(), budgetBytes: 16384, command: 'status' });
  const visible = JSON.stringify(result);
  assert.ok(!visible.includes(secret)); assert.ok(!visible.includes('private-body'));
  assert.equal(result.summary.pytest.collectedCount, 3506); assert.equal(result.summary.pytest.outcomes.failed, 3506);
  assert.equal(result.summary.sourceBefore, 'source-a'); assert.equal(result.summary.scope, 'targeted');
  assert.equal(result.summary.passed, false); assert.equal(result.summary.exitCode, 1);
  assert.ok(result.omitted.some(item => item.pointer === '/pytest/collected' && item.count === 3506));
  assert.ok(result.omitted.some(item => item.pointer === '/baseline')); verifySize(result);
});

test('stop uncertainty, all request states and complete approval operations can exceed soft budget', async () => {
  const operation = { command: 'inspect-before-approving'.repeat(200), args: { nested: true } };
  const original = { ...large(), state: 'STOP_PENDING', blocked: true, observationError: 'STREAM_DISCONNECTED', errors: [{ code: 'NATIVE_UNKNOWN', message: 'PRIVATE-SENTINEL' }], stopReason: 'Cannot prove idle', leaseOpen: false,
    stopAttempt: { id: 'stop1', phase: 'failed', cancelRequested: true, cancelAck: { accepted: true, durationMs: 3 }, before: { running: true, queueCount: 2, associatedTurns: [1] } }, stopDiagnostic: { code: 'STOP_ACTIVITY_UNRESOLVED' },
    requests: [{ requestId: 'unknown', state: 'SUBMISSION_UNKNOWN' }, { requestId: 'done', state: 'COMPLETED', resultFile: 'reply.txt', resultSha256: 'hash', resultBytes: 25 }],
    approvals: [{ eventId: 'a', state: 'PENDING', operation }] };
  const result = await budgetOutput(original, { store: storage(), budgetBytes: 1024, command: 'stop' });
  assert.equal(result.summary.state, 'STOP_PENDING'); assert.equal(result.summary.blocked, true); assert.equal(result.summary.leaseOpen, false);
  assert.equal(result.summary.observationError, 'STREAM_DISCONNECTED'); assert.equal(result.summary.errors[0].code, 'NATIVE_UNKNOWN');
  assert.equal(result.summary.stopAttempt.cancelAck.accepted, true); assert.equal(result.summary.stopDiagnostic.code, 'STOP_ACTIVITY_UNRESOLVED');
  assert.deepEqual(result.summary.requests, original.requests); assert.deepEqual(result.summary.approvals[0].operation, operation);
  assert.equal(result.budgetExceeded, true); assert.ok(result.statistics.visibleBytes > 1024);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-SENTINEL')); verifySize(result);
});

test('3506 identical Python errors aggregate without merging a different line or leaking text/hash', async () => {
  const first = 'E   RuntimeError: PRIVATE-SENTINEL one';
  const second = 'E   RuntimeError: PRIVATE-SENTINEL two';
  const text = `${Array(3506).fill(first).join('\n')}\n${second}\n`;
  const store = storage(), stdout = ref('run.stdout', text);
  const original = { ...large(), schema: 'dsh-run/v1', stdout, exitCode: 1, termination: 'exited', passed: false };
  const result = await budgetOutput(original, { store, budgetBytes: 16384, command: 'run', readLog: async value => { assert.deepEqual(value, stdout); return Buffer.from(text); } });
  const groups = result.summary.errorGroups.stdout;
  assert.equal(groups.groupCount, 2); assert.equal(groups.errorLineCount, 3507);
  assert.deepEqual(groups.groups.map(item => [item.type, item.count, item.firstLine]), [['RuntimeError', 3506, 1], ['RuntimeError', 1, 3507]]);
  assert.equal(groups.rootCause, 'unverified'); assert.deepEqual(result.summary.stdout, stdout);
  assert.ok(groups.groups.every(item => item.id.startsWith(stdout.sha256)));
  const visible = JSON.stringify(result);
  assert.ok(!visible.includes('PRIVATE-SENTINEL')); assert.ok(!visible.includes(digest(first)));
  const indexBytes = store.files.get(groups.groupIndexRef.file);
  assert.equal(digest(indexBytes), groups.groupIndexRef.sha256);
  assert.deepEqual(JSON.parse(indexBytes).groups, groups.groups); verifySize(result);
});

test('pytest lines are descriptive groups and bounded projections index every omitted group', async () => {
  const text = Array.from({ length: 90 }, (_, i) => `FAILED private/test.py::secret${i} - ValueError: private-${i}`).join('\n');
  const store = storage(), stdout = ref('pytest.stdout', text);
  const result = await budgetOutput({ ...large(), schema: 'dsh-run/v1', stdout }, { store, budgetBytes: 3000, command: 'receipt', readLog: async () => Buffer.from(text) });
  const summary = result.summary.errorGroups.stdout;
  assert.equal(summary.groupCount, 90); assert.equal(summary.errorLineCount, 90);
  assert.ok(summary.groups.length < 90); assert.equal(summary.omittedGroups.last, 90);
  assert.equal(summary.omittedGroups.first, summary.groups.length + 1);
  assert.equal(JSON.parse(store.files.get(summary.groupIndexRef.file)).groups.length, 90);
  assert.ok(!JSON.stringify(result).includes('private/test')); assert.ok(result.statistics.visibleBytes <= 3000); verifySize(result);
});

test('unknown log formats remain unclassified, and verified-reader failures propagate', async () => {
  const text = 'PRIVATE-SENTINEL arbitrary output';
  const stdout = ref('unknown.stdout', text), original = { ...large(), stdout };
  const result = await budgetOutput(original, { store: storage(), budgetBytes: 16384, command: 'run', readLog: async () => Buffer.from(text) });
  assert.equal(result.summary.errorGroups.stdout.classification, 'unclassified');
  assert.equal(result.summary.errorGroups.stdout.groupCount, 0);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-SENTINEL'));
  await assert.rejects(budgetOutput(original, { store: storage(), budgetBytes: 1024, command: 'run', readLog: async () => { throw Object.assign(new Error('broken'), { code: 'EVIDENCE_CHANGED' }); } }), { code: 'EVIDENCE_CHANGED' });
});

test('bare Python assertion errors without a message are recognized', async () => {
  const text = 'E   AssertionError\nException\n';
  const stdout = ref('bare.stdout', text);
  const result = await budgetOutput({ ...large(), stdout }, { store: storage(), budgetBytes: 16384, command: 'run', readLog: async () => Buffer.from(text) });
  assert.deepEqual(result.summary.errorGroups.stdout.groups.map(group => group.type), ['AssertionError', 'Exception']);
});

test('distinct non-UTF8 error bytes are not merged by replacement decoding', async () => {
  const text = Buffer.concat([Buffer.from('E RuntimeError: '), Buffer.from([0xff, 10]), Buffer.from('E RuntimeError: '), Buffer.from([0xfe, 10])]);
  const stdout = ref('binary.stdout', text);
  const result = await budgetOutput({ ...large(), stdout }, { store: storage(), budgetBytes: 16384, command: 'run', readLog: async () => text });
  assert.equal(result.summary.errorGroups.stdout.groupCount, 2);
  assert.deepEqual(result.summary.errorGroups.stdout.groups.map(group => group.count), [1, 1]);
});

test('setup identity and observed DSH usage totals remain available without invented Codex usage', async () => {
  const setup = await budgetOutput({ ...large(), toolRoot: 'tool', stateDir: 'state', skillInstalled: true, authenticationRequired: true }, { store: storage(), budgetBytes: 1024, command: 'setup' });
  assert.equal(setup.summary.stateDir, 'state'); assert.equal(setup.summary.authenticationRequired, true);
  const value = { ...large(), schema: 'dsh-usage/v1', totals: { outputTokens: 42, totalInputTokens: null }, coverage: { uniqueEvents: 100 }, records: Array(20).fill({ text: 'PRIVATE-SENTINEL' }) };
  const usage = await budgetOutput(value, { store: storage(), budgetBytes: 1024, command: 'usage' });
  assert.equal(usage.statistics.dshUsage.outputTokens, 42); assert.equal(usage.statistics.dshUsage.totalInputTokens, null);
  assert.equal(usage.statistics.codexUsage, null); assert.equal(usage.summary.coverage.uniqueEvents, 100);
  assert.ok(!JSON.stringify(usage).includes('PRIVATE-SENTINEL'));
});

test('all task identities and uncertain activity states survive an oversized task listing', async () => {
  const tasks = Array.from({ length: 30 }, (_, i) => ({ task: `task${i}`, sessionId: `session${i}`, connection: 'native', cwd: `/project/${i}`, state: i % 2 ? 'STOP_PENDING' : 'SUBMISSION_UNKNOWN', blocked: i % 2 === 1, active: null, running: null, unresolved: true, title: 'PRIVATE-SENTINEL', private: large() }));
  const original = { connection: 'native', tasks }, before = structuredClone(original);
  const result = await budgetOutput(original, { store: storage(), budgetBytes: 1024, command: 'tasks' });
  assert.equal(result.summary.tasks.length, 30);
  assert.deepEqual(result.summary.tasks, tasks.map(({ title, private: privateValue, ...safe }) => safe));
  assert.equal(result.budgetExceeded, true); verifySize(result);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-SENTINEL'));
  assert.deepEqual(original, before);
});

test('ENOSPC and EACCES failures preserve stop, approvals, unknown delivery and source identity', async () => {
  const original = { ...large(), task: 'task1', sessionId: 'session1', state: 'STOP_PENDING', blocked: true, leaseOpen: false, stopReason: 'Cannot prove idle', stopAttempt: { id: 'stop1', phase: 'failed', cancelRequested: true }, stopDiagnostic: { code: 'STOP_ACTIVITY_UNRESOLVED' }, observationError: 'STREAM_DISCONNECTED',
    requests: [{ requestId: 'unknown', state: 'SUBMISSION_UNKNOWN' }, { requestId: 'done', state: 'COMPLETED', resultFile: 'reply.txt', resultSha256: 'hash', resultBytes: 2 }],
    approvals: [{ eventId: 'approval1', state: 'PENDING', operation: { command: 'review-command'.repeat(100) } }],
    sourceBefore: 'source-sha', cwd: '/project', binding: { task: 'task1', sessionId: 'session1', nativeCwd: '/project' }, contract: { id: 'contract1', executionRoot: '/project', private: 'PRIVATE-SENTINEL' }, argv: ['PRIVATE-SENTINEL'] };
  const before = structuredClone(original);
  for (const code of ['ENOSPC', 'EACCES']) {
    const error = Object.assign(new Error('PRIVATE-SENTINEL'), { code, stack: 'PRIVATE-STACK' });
    let caught;
    try { await budgetOutput(original, { store: { async writeFile() { throw error; } }, budgetBytes: 1024, command: 'stop' }); } catch (failure) { caught = failure; }
    assert.equal(caught, error);
    const result = outputFailure(original, { command: 'stop', budgetBytes: 1024, error: caught });
    assert.equal(result.projectionFailed, true); assert.equal(result.artifactRef, null);
    assert.equal(result.artifactPreservation, 'unverified'); assert.equal(result.recoveryRequired, true); assert.equal(result.automaticResubmissionAllowed, false);
    assert.equal(result.failure.code, code); assert.equal(result.summary.state, 'STOP_PENDING');
    assert.equal(result.summary.blocked, true); assert.equal(result.summary.leaseOpen, false);
    assert.deepEqual(result.summary.stopAttempt, original.stopAttempt); assert.deepEqual(result.summary.stopDiagnostic, original.stopDiagnostic);
    assert.deepEqual(result.summary.requests, original.requests); assert.deepEqual(result.summary.approvals, original.approvals);
    assert.equal(result.summary.source.sourceManifestSha, 'source-sha'); assert.deepEqual(result.summary.binding, original.binding); assert.equal(result.summary.contractIdentity.id, 'contract1');
    assert.equal(result.statistics.fullBytes, Buffer.byteLength(JSON.stringify(original))); verifySize(result);
    assert.equal(result.budgetExceeded, true);
    assert.ok(!JSON.stringify(result).includes('PRIVATE-SENTINEL')); assert.ok(!JSON.stringify(result).includes('PRIVATE-STACK'));
  }
  assert.deepEqual(original, before);
});

test('damaged run evidence blocks acceptance in failure frames without mutating the original receipt', async () => {
  const original = { ...large(), schema: 'dsh-run/v1', state: 'COMPLETED', passed: true, valid: true, evidenceComplete: true, stdout: ref('run.stdout', 'original'), argv: ['PRIVATE-SENTINEL'] };
  const before = structuredClone(original), store = storage();
  let caught;
  try { await budgetOutput(original, { store, budgetBytes: 1024, command: 'receipt', readLog: async () => { throw Object.assign(new Error('PRIVATE-SENTINEL'), { code: 'EVIDENCE_TAMPERED' }); } }); } catch (error) { caught = error; }
  assert.equal(caught.code, 'EVIDENCE_TAMPERED'); assert.ok(store.files.size > 0);
  const result = outputFailure(original, { command: 'receipt', budgetBytes: 1024, error: caught });
  assert.equal(result.artifactRef, null); assert.equal(result.summary.state, 'COMPLETED');
  assert.equal(result.failure.acceptanceBlocked, true); assert.equal(result.failure.reason, 'OUTPUT_PROJECTION_VERIFICATION_BLOCKED'); assert.equal(result.failure.originalValueChanged, false);
  for (const key of ['passed', 'valid', 'evidenceComplete']) assert.equal(result.summary[key], false);
  assert.deepEqual(original, before); assert.ok(!JSON.stringify(result).includes('PRIVATE-SENTINEL')); verifySize(result);
});

test('failure diagnostics expose fixed codes only and never error messages, stacks or private codes', () => {
  const result = outputFailure(large(), { command: 'status', budgetBytes: 1024, error: { code: 'PRIVATE-SENTINEL', message: 'PRIVATE-MESSAGE', stack: 'PRIVATE-STACK' } });
  assert.equal(result.failure.code, 'OUTPUT_PROJECTION_FAILED'); verifySize(result);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-'));
});
