import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StateStore } from '../src/store.mjs';
import { ContractService } from '../src/contract.mjs';
import { snapshot } from '../src/execution.mjs';

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-contract-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'); await fs.mkdir(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'fixture');
  await fs.writeFile(path.join(root, 'source.txt'), 'baseline');
  await fs.writeFile(path.join(root, 'protected.txt'), 'keep');
  await fs.writeFile(path.join(root, 'runner.mjs'), 'console.log("real runner");');
  git('add', '.'); git('commit', '-m', 'baseline');
  await fs.writeFile(path.join(root, 'original-untracked.txt'), 'preserve');
  await fs.writeFile(path.join(root, 'source.txt'), 'original dirty');
  const store = await StateStore.open(path.join(temp, 'state'));
  await store.transaction(s => { s.tasks.demo = { id: 'demo', cwd: root, sessionId: 'session' }; });
  const service = new ContractService({ store });
  const plan = { id: 'unit', owner: 'DSH', scope: 'targeted', purpose: 'regression', domain: 'guard', runner: 'command', executable: process.execPath, argv: ['runner.mjs'], env: {}, inputs: ['source.txt', 'runner.mjs'], runtimeInputs: [], expectedNodeids: [], timeoutMs: 5000 };
  const contract = { id: 'work', revision: 1, nativeCwd: root, executionRoot: root, gitOwner: 'Codex', authorizationRef: 'fixture task', feeAuthorizationRef: null, stopConditions: ['stop on scope violation'], allowedFiles: ['source.txt', 'runner.mjs'], protectedFiles: ['protected.txt', 'original-untracked.txt'], requirements: [{ id: 'r1', text: 'preserve protection' }], testPlan: [plan] };
  return { root, store, service, contract, git };
}

test('contract baseline preserves dirty/untracked; rejects stale hash and file/index scope', async t => {
  const f = await fixture(t), bound = await f.service.bind({ task: 'demo', contract: f.contract });
  const checked = await f.service.check({ task: 'demo', contractSha: bound.contractSha });
  assert.deepEqual(checked.changedFiles, []);
  await assert.rejects(f.service.check({ task: 'demo', contractSha: 'old' }), { code: 'CONTRACT_HASH_MISMATCH' });
  await fs.writeFile(path.join(f.root, 'protected.txt'), 'changed');
  await assert.rejects(f.service.check({ task: 'demo', contractSha: bound.contractSha }), { code: 'CONTRACT_FILE_SCOPE_VIOLATION' });
});

test('tracked protected __proto__ changes affect fingerprints and block scope and reuse', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, '__proto__'), 'protected baseline'); f.git('add', '__proto__'); f.git('commit', '-m', 'protected special filename');
  f.contract.protectedFiles.push('__proto__');
  const { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract });
  const before = await snapshot(f.root), request = { task: 'demo', contractSha, case: 'unit', owner: 'DSH' };
  const first = await f.service.run(request); assert.equal(first.passed, true);
  await fs.writeFile(path.join(f.root, '__proto__'), 'modified protection');
  await assert.rejects(f.service.check({ task: 'demo', contractSha }), { code: 'CONTRACT_FILE_SCOPE_VIOLATION' });
  const after = await snapshot(f.root);
  assert.equal(Object.hasOwn(before.files, '__proto__'), true); assert.notEqual(before.fingerprint, after.fingerprint);
  await assert.rejects(f.service.run(request), { code: 'CONTRACT_FILE_SCOPE_VIOLATION' });
});

test('protected unmerged index keeps every baseline stage and rejects a stage-one-only change', async t => {
  const f = await fixture(t);
  const oid = f.git('rev-parse', 'HEAD:protected.txt').toString().trim();
  const differentOid = f.git('rev-parse', 'HEAD:source.txt').toString().trim();
  const stages = first => `0 ${'0'.repeat(40)}\tprotected.txt\n100644 ${first} 1\tprotected.txt\n100644 ${oid} 2\tprotected.txt\n100644 ${oid} 3\tprotected.txt\n`;
  const update = first => execFileSync('git', ['-C', f.root, 'update-index', '--index-info'], { input: stages(first), stdio: ['pipe', 'pipe', 'pipe'] });
  update(oid);
  const { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract });
  assert.deepEqual((await f.service.check({ task: 'demo', contractSha })).changedFiles, []);
  const before = f.git('ls-files', '--stage', 'protected.txt').toString(); update(differentOid);
  assert.notEqual(before, f.git('ls-files', '--stage', 'protected.txt').toString());
  assert.equal(await fs.readFile(path.join(f.root, 'protected.txt'), 'utf8'), 'keep');
  await assert.rejects(f.service.check({ task: 'demo', contractSha }), { code: 'CONTRACT_FILE_SCOPE_VIOLATION' });
  assert.equal(await fs.readFile(path.join(f.root, 'source.txt'), 'utf8'), 'original dirty');
});

test('contract revisions require explicit decision; immutable assets detect tampering', async t => {
  const f = await fixture(t), first = await f.service.bind({ task: 'demo', contract: f.contract });
  const next = { ...f.contract, revision: 2, supersedes: first.contractSha, requirements: [{ id: 'r2', text: 'new requirement' }] };
  await assert.rejects(f.service.bind({ task: 'demo', contract: next }), { code: 'CONTRACT_DECISION_REQUIRED' });
  const second = await f.service.bind({ task: 'demo', contract: { ...next, decision: { approved: true, reason: 'explicit fixture approval', requirementChanges: [{ id: 'r1', action: 'remove', reason: 'superseded requirement', authorizationRef: 'fixture revocation approval' }] } } });
  assert.notEqual(first.contractSha, second.contractSha);
  await assert.rejects(f.service.check({ task: 'demo', contractSha: first.contractSha }), { code: 'CONTRACT_HASH_MISMATCH' });
  const task = await f.store.task('demo'); await fs.appendFile(f.store.file(task.contractRef.file), ' ');
  await assert.rejects(f.service.inspect({ task: 'demo' }), { code: 'EVIDENCE_TAMPERED' });
});

test('contract requirement revisions require exact per-ID remove or replace declarations', async t => {
  const f = await fixture(t);
  f.contract.requirements.push({ id: 'retained', text: 'must remain', severity: 'blocking' });
  const first = await f.service.bind({ task: 'demo', contract: f.contract });
  const removed = { ...f.contract, revision: 2, supersedes: first.contractSha, requirements: [f.contract.requirements[1]], decision: { approved: true, reason: 'generic approval is insufficient' } };
  const removal = { id: 'r1', action: 'remove', reason: 'explicitly revoked', authorizationRef: 'fixture revocation approval' };
  const failure = { code: 'CONTRACT_REQUIREMENT_CHANGE_REQUIRED' };
  await assert.rejects(f.service.bind({ task: 'demo', contract: removed }), failure);
  for (const declaration of [{ ...removal, id: 'wrong-id' }, { ...removal, action: 'replace' }, { ...removal, reason: '' }, { ...removal, authorizationRef: '' }, { reason: 'missing id/action', authorizationRef: 'fixture' }]) {
    await assert.rejects(f.service.bind({ task: 'demo', contract: { ...removed, decision: { ...removed.decision, requirementChanges: [declaration] } } }), failure);
  }
  const replacement = { ...removed, requirements: [{ id: 'r1', text: 'changed constraint' }, f.contract.requirements[1]] };
  await assert.rejects(f.service.bind({ task: 'demo', contract: replacement }), failure);
  await assert.rejects(f.service.bind({ task: 'demo', contract: { ...replacement, decision: { ...replacement.decision, requirementChanges: [removal] } } }), failure);
  const unapprovedRetainedChange = { ...replacement, requirements: [replacement.requirements[0], { ...replacement.requirements[1], severity: 'advisory' }], decision: { ...replacement.decision, requirementChanges: [{ ...removal, action: 'replace' }] } };
  await assert.rejects(f.service.bind({ task: 'demo', contract: unapprovedRetainedChange }), failure);
  const second = await f.service.bind({ task: 'demo', contract: { ...replacement, decision: { ...replacement.decision, requirementChanges: [{ ...removal, action: 'replace' }] } } });
  const stored = await f.service.inspect({ task: 'demo' });
  assert.equal(second.contractSha, stored.contractSha); assert.deepEqual(stored.contract.requirements, replacement.requirements);
  const third = { ...stored.contract, revision: 3, supersedes: second.contractSha, requirements: [...stored.contract.requirements, { id: 'new', text: 'additional requirement' }], decision: { approved: true, reason: 'additive requirement only' } };
  await f.service.bind({ task: 'demo', contract: third });
});

test('execution captures bytes, enforces owner, deduplicates concurrent runs and validates original logs', async t => {
  const f = await fixture(t), { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract });
  const request = { task: 'demo', contractSha, case: 'unit', owner: 'DSH' };
  await assert.rejects(f.service.run({ ...request, owner: 'Codex' }), { code: 'TEST_OWNER_MISMATCH' });
  const runs = await Promise.all([f.service.run(request), f.service.run(request)]);
  assert.ok(runs.every(r => r.passed)); assert.equal(runs.filter(r => r.reused).length, 1); assert.equal(runs[0].runId, runs[1].runId);
  assert.equal(runs[0].stderr.bytes, 0);
  await fs.appendFile(f.store.file(runs[0].stdout.file), 'tamper');
  await assert.rejects(f.service.receipt({ task: 'demo', run: runs[0].runId }), { code: 'EVIDENCE_TAMPERED' });
});

test('empty stdout cannot pass; changed source requires rerun reason', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'runner.mjs'), '');
  const { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract });
  const request = { task: 'demo', contractSha, case: 'unit', owner: 'DSH' };
  const first = await f.service.run(request); assert.equal(first.passed, false);
  await fs.writeFile(path.join(f.root, 'runner.mjs'), 'console.log("fixed");');
  await assert.rejects(f.service.run(request), { code: 'RERUN_REASON_REQUIRED' });
  const fixed = await f.service.run({ ...request, rerunReason: 'fixed empty runner' }); assert.equal(fixed.passed, true);
  assert.equal((await f.service.receipt({ task: 'demo', run: first.runId })).valid, false);
});

test('repo-full requires current readiness and zero review blockers', async t => {
  const f = await fixture(t);
  f.contract.testPlan.push({ ...f.contract.testPlan[0], id: 'full', scope: 'repo-full', purpose: 'full suite' });
  const { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract });
  const full = { task: 'demo', contractSha, case: 'full', owner: 'DSH' };
  await assert.rejects(f.service.run(full), { code: 'READINESS_REQUIRED' });
  const unit = await f.service.run({ ...full, case: 'unit' });
  await assert.rejects(f.service.readiness({ task: 'demo', contractSha, review: { blockers: ['bug'], targetedRuns: [unit.runId] } }), { code: 'REVIEW_BLOCKED' });
  await f.service.readiness({ task: 'demo', contractSha, review: { blockers: [], targetedRuns: [unit.runId] } });
  assert.equal((await f.service.run(full)).passed, true);
  await assert.rejects(f.service.readiness({ task: 'demo', contractSha, review: { blockers: ['new blocker'], targetedRuns: [unit.runId] } }), { code: 'REVIEW_BLOCKED' });
  await assert.rejects(f.service.run(full), { code: 'READINESS_REQUIRED' });
  await fs.writeFile(path.join(f.root, 'source.txt'), 'new source');
  await assert.rejects(f.service.run({ ...full, rerunReason: 'integration change' }), { code: 'READINESS_REQUIRED' });
});

test('unsafe paths, missing authorization and shell scripts are rejected', async t => {
  const f = await fixture(t);
  for (const edit of [{ allowedFiles: ['../outside'] }, { authorizationRef: '' }, { testPlan: [{ ...f.contract.testPlan[0], executable: path.join(f.root, 'run.cmd') }] }]) await assert.rejects(f.service.bind({ task: 'demo', contract: { ...f.contract, ...edit } }));
});

test('index-only changes, branch changes and new outside files are blocked without resetting baseline', async t => {
  const f = await fixture(t), { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract });
  f.git('update-index', '--chmod=+x', 'protected.txt');
  await assert.rejects(f.service.check({ task: 'demo', contractSha }), { code: 'CONTRACT_FILE_SCOPE_VIOLATION' });
  assert.equal(await fs.readFile(path.join(f.root, 'source.txt'), 'utf8'), 'original dirty');
  assert.equal(await fs.readFile(path.join(f.root, 'original-untracked.txt'), 'utf8'), 'preserve');
  f.git('update-index', '--chmod=-x', 'protected.txt');
  await fs.writeFile(path.join(f.root, 'outside.txt'), 'new outside');
  await assert.rejects(f.service.check({ task: 'demo', contractSha }), { code: 'CONTRACT_FILE_SCOPE_VIOLATION' });
  await fs.unlink(path.join(f.root, 'outside.txt'));
  f.git('checkout', '-b', 'different-branch');
  await assert.rejects(f.service.check({ task: 'demo', contractSha }), { code: 'CONTRACT_GIT_BASE_CHANGED' });
});

test('declared ignored protection and missing-path ancestor links cannot bypass scope', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, '.gitignore'), 'ignored.txt\nfuture/\n');
  await fs.writeFile(path.join(f.root, 'ignored.txt'), 'keep ignored');
  f.contract.protectedFiles.push('ignored.txt', 'future/protected.txt');
  const { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract });
  await fs.writeFile(path.join(f.root, 'ignored.txt'), 'changed ignored');
  await assert.rejects(f.service.check({ task: 'demo', contractSha }), { code: 'CONTRACT_FILE_SCOPE_VIOLATION' });
  await fs.writeFile(path.join(f.root, 'ignored.txt'), 'keep ignored');
  const outside = path.join(path.dirname(f.root), 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.root, 'future'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.check({ task: 'demo', contractSha }), { code: 'UNSAFE_EXECUTION_PATH' });
});

test('Windows aliases cannot turn protection into allowlisted writes', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.bind({ task: 'demo', contract: { ...f.contract, allowedFiles: ['PROTECTED.txt'] } }), { code: 'INVALID_CONTRACT_PATH' });
  await assert.rejects(f.service.bind({ task: 'demo', contract: { ...f.contract, allowedFiles: ['Source.txt'] } }), { code: 'UNSAFE_EXECUTION_PATH' });
});

test('external runtime inventory invalidates old evidence and unknown dependencies cannot reuse', async t => {
  const f = await fixture(t), dependency = path.join(path.dirname(f.root), 'dependency.lock');
  await fs.writeFile(dependency, 'version1'); f.contract.testPlan[0].runtimeInputs = [dependency];
  const { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract });
  const request = { task: 'demo', contractSha, case: 'unit', owner: 'DSH' };
  const first = await f.service.run(request); assert.equal(first.passed, true);
  await fs.writeFile(dependency, 'version2');
  assert.equal((await f.service.receipt({ task: 'demo', run: first.runId })).passed, false);
  await assert.rejects(f.service.run(request), { code: 'RERUN_REASON_REQUIRED' });
  const second = await f.service.run({ ...request, rerunReason: 'external dependency changed' }); assert.equal(second.passed, true); assert.notEqual(first.testFingerprint, second.testFingerprint);
});

test('unknown dependencies are executed once but are never accepted for reuse or readiness', async t => {
  const f = await fixture(t); delete f.contract.testPlan[0].runtimeInputs;
  const { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract });
  const request = { task: 'demo', contractSha, case: 'unit', owner: 'DSH' };
  const first = await f.service.run(request); assert.equal(first.reusable, false); assert.equal(first.passed, false); assert.equal(first.evidenceComplete, true);
  assert.equal((await f.service.receipt({ task: 'demo', run: first.runId })).passed, false);
  await assert.rejects(f.service.run(request), { code: 'RERUN_REASON_REQUIRED' });
});

test('guard/probe plans retain independent evidence and overlap needs a reason', async t => {
  const f = await fixture(t); f.contract.testPlan[0].expectedNodeids = ['same-id'];
  f.contract.testPlan.push({ ...f.contract.testPlan[0], id: 'probe', domain: 'probe' }, { ...f.contract.testPlan[0], id: 'overlap' });
  const { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract });
  const request = { task: 'demo', contractSha, case: 'unit', owner: 'DSH' };
  const guard = await f.service.run(request), probe = await f.service.run({ ...request, case: 'probe' });
  assert.notEqual(guard.runId, probe.runId); assert.equal(probe.reused, false);
  await assert.rejects(f.service.run({ ...request, case: 'overlap' }), { code: 'OVERLAPPING_TEST_REASON_REQUIRED' });
  await assert.rejects(f.service.run({ ...request, case: 'overlap', rerunReason: ' ' }), { code: 'INVALID_RERUN_REASON' });
});

test('stop blocks local runs both at lock entry and immediately before launch', async t => {
  const f = await fixture(t), launched = path.join(path.dirname(f.root), 'launched.marker');
  await fs.writeFile(path.join(f.root, 'runner.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(launched)}, 'launched'); console.log('ran');`);
  const { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract });
  const request = { task: 'demo', contractSha, case: 'unit', owner: 'DSH' };
  await f.store.transaction(s => { s.tasks.demo.stopRequested = true; });
  await assert.rejects(f.service.run(request), { code: 'TASK_STOPPED' });
  await f.store.transaction(s => { s.tasks.demo.stopRequested = false; });
  const check = f.service.check.bind(f.service);
  f.service.check = async args => { const checked = await check(args); await f.store.transaction(s => { s.tasks.demo.stopRequested = true; }); return checked; };
  await assert.rejects(f.service.run(request), { code: 'TASK_STOPPED' });
  await assert.rejects(fs.stat(launched), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(f.store.directory)).filter(name => name.startsWith('run-')), []);
  assert.deepEqual((await f.store.task('demo')).contractRuns || [], []);
});

test('stop after durable execution intent prevents spawn and records NOT_STARTED',async t=>{
  const f=await fixture(t),{contractSha}=await f.service.bind({task:'demo',contract:f.contract});
  const transaction=f.store.transaction.bind(f.store);
  let intercepted=false;
  f.store.transaction=async(callback,options)=>{
    return transaction(async state=>{
      if(!intercepted && state.tasks.demo.executionIntents?.some(item=>item.state==='STARTING')){
        intercepted=true;state.tasks.demo.stopRequested=true;
      }
      return callback(state);
    },options);
  };
  await assert.rejects(f.service.run({task:'demo',contractSha,case:'unit',owner:'DSH'}),{code:'TASK_STOPPED'});
  assert.equal(intercepted,true);
  const task=await f.store.task('demo'),intent=task.executionIntents[0];
  assert.equal(intent.state,'SETTLED');assert.equal(intent.termination,'not-started');
  const receipt=await f.service.receipt({task:'demo',run:intent.runId});
  assert.equal(receipt.executionState,'NOT_STARTED');assert.equal(receipt.passed,false);
  assert.deepEqual((await fs.readdir(f.store.directory)).filter(name=>/\.stdout$|\.stderr$/.test(name)),[]);
  assert.equal((await f.service.check({task:'demo',contractSha})).contractSha,contractSha);
});

test('residual STARTING execution without a lock blocks dispatch and exposes UNKNOWN receipt', async t => {
  const f = await fixture(t), { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract });
  await f.store.transaction(s => { s.tasks.demo.executionIntents = [{ runId: 'interrupted-run', caseId: 'unit', contractSha, state: 'STARTING', testFingerprint: 'unknown' }]; });
  await assert.rejects(f.service.check({ task: 'demo', contractSha }), { code: 'UNRESOLVED_EXECUTION' });
  await assert.rejects(f.service.run({ task: 'demo', contractSha, case: 'unit', owner: 'DSH', rerunReason: 'cannot override unknown execution' }), { code: 'UNRESOLVED_EXECUTION' });
  const receipt = await f.service.receipt({ task: 'demo', run: 'interrupted-run' });
  assert.equal(receipt.executionState, 'UNKNOWN'); assert.equal(receipt.passed, false);
  assert.deepEqual((await fs.readdir(f.store.directory)).filter(name => name.startsWith('run-')), []);
});

test('timeout intent remains UNKNOWN; ordinary failing exits settle and can rerun with a reason', async t => {
  const timed = await fixture(t); Object.assign(timed.contract.testPlan[0], { argv: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 50 });
  const timedBound = await timed.service.bind({ task: 'demo', contract: timed.contract });
  const timedRequest = { task: 'demo', contractSha: timedBound.contractSha, case: 'unit', owner: 'DSH' };
  const timeout = await timed.service.run(timedRequest);
  assert.equal(timeout.termination, 'timeout'); assert.equal(timeout.cleanup, 'UNVERIFIED');
  assert.equal((await timed.store.task('demo')).executionIntents[0].state, 'UNKNOWN');
  assert.equal((await timed.service.receipt({ task: 'demo', run: timeout.runId })).executionState, 'UNKNOWN');
  await assert.rejects(timed.service.run({ ...timedRequest, rerunReason: 'not permission to replay unknown' }), { code: 'UNRESOLVED_EXECUTION' });
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'runner.mjs'), 'console.log("failed assertion"); process.exitCode=7;');
  const { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract }), request = { task: 'demo', contractSha, case: 'unit', owner: 'DSH' };
  const failed = await f.service.run(request); assert.equal(failed.passed, false); assert.equal(failed.exitCode, 7);
  assert.equal((await f.store.task('demo')).executionIntents[0].state, 'SETTLED');
  await assert.rejects(f.service.run(request), { code: 'RERUN_REASON_REQUIRED' });
  const rerun = await f.service.run({ ...request, rerunReason: 'independent failing-exit diagnosis' }); assert.notEqual(rerun.runId, failed.runId);
});

test('real pytest collection and finish evidence are required; wrong nodeids cannot pass', async t => {
  let python;
  try { python = execFileSync('python', ['-c', 'import sys, pytest; print(sys.executable)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { t.skip('Python with pytest unavailable; no synthetic pytest pass'); return; }
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'test_sample.py'), 'import os\ndef test_ok():\n    if os.environ.get("CHANGE_CWD"):\n        os.chdir(os.path.dirname(os.getcwd()))\n    assert True\n');
  f.contract.allowedFiles.push('test_sample.py');
  Object.assign(f.contract.testPlan[0], { runner: 'pytest', executable: python, argv: ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'test_sample.py'], expectedNodeids: ['test_sample.py::test_ok'], inputs: ['test_sample.py'], runtimeInputs: undefined });
  f.contract.testPlan.push({ ...f.contract.testPlan[0], id: 'wrong-nodeids', expectedNodeids: ['test_sample.py::not_collected'] }, { ...f.contract.testPlan[0], id: 'wrong-cwd', domain: 'probe', env: { CHANGE_CWD: '1' } });
  const { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract });
  const run = await f.service.run({ task: 'demo', contractSha, case: 'unit', owner: 'DSH' });
  assert.equal(run.evidenceComplete, true); assert.equal(run.passed, false); assert.equal(run.pytest.finished, true); assert.deepEqual(run.pytest.collected, ['test_sample.py::test_ok']); assert.ok(run.pytestAsset.bytes > 0);
  assert.equal((await f.service.run({ task: 'demo', contractSha, case: 'wrong-nodeids', owner: 'DSH' })).evidenceComplete, false);
  assert.equal((await f.service.run({ task: 'demo', contractSha, case: 'wrong-cwd', owner: 'DSH' })).evidenceComplete, false);
  await fs.appendFile(f.store.file(run.pytestAsset.file), ' ');
  await assert.rejects(f.service.receipt({ task: 'demo', run: run.runId }), { code: 'EVIDENCE_TAMPERED' });
});

test('source changes during a command cannot be accepted as evidence for the original version', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'runner.mjs'), 'import fs from "node:fs"; fs.writeFileSync("source.txt", "changed during run"); console.log("passed");');
  const { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract });
  const run = await f.service.run({ task: 'demo', contractSha, case: 'unit', owner: 'DSH' });
  assert.equal(run.exitCode, 0); assert.equal(run.passed, false); assert.notEqual(run.sourceBefore, run.sourceAfter);
});

test('repo-full cannot reuse readiness after a targeted external dependency changes', async t => {
  const f = await fixture(t), dependency = path.join(path.dirname(f.root), 'targeted-runtime');
  await fs.writeFile(dependency, 'v1'); f.contract.testPlan[0].runtimeInputs = [dependency];
  f.contract.testPlan.push({ ...f.contract.testPlan[0], id: 'full', scope: 'repo-full', purpose: 'full suite', runtimeInputs: [] });
  const { contractSha } = await f.service.bind({ task: 'demo', contract: f.contract });
  const request = { task: 'demo', contractSha, case: 'unit', owner: 'DSH' };
  const unit = await f.service.run(request);
  await f.service.readiness({ task: 'demo', contractSha, review: { blockers: [], targetedRuns: [unit.runId] } });
  assert.equal((await f.service.run({ ...request, case: 'full' })).passed, true);
  await fs.writeFile(dependency, 'v2');
  await assert.rejects(f.service.run({ ...request, case: 'full' }), { code: 'TARGETED_EVIDENCE_REQUIRED' });
});
