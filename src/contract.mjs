import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { identifier, fault } from './store.mjs';
import { digest, jsonDigest, relativeFile, safeFile, snapshot, executeCase } from './execution.mjs';

const requireValue = (condition, code = 'INVALID_CONTRACT') => { if (!condition) throw fault(code); };
const nonempty = x => typeof x === 'string' && x.trim().length > 0;
const unresolvedExecution = task => (task.executionIntents || []).some(intent => intent.state !== 'SETTLED');
function requirementRevision(previous, contract) {
  const next = new Map(contract.requirements.map(r => [r.id, r]));
  const changes = new Map(previous.requirements.flatMap(r => !next.has(r.id) ? [[r.id, 'remove']] : !isDeepStrictEqual(r, next.get(r.id)) ? [[r.id, 'replace']] : []));
  const declarations = contract.decision.requirementChanges === undefined ? [] : contract.decision.requirementChanges;
  requireValue(Array.isArray(declarations) && declarations.length === changes.size, 'CONTRACT_REQUIREMENT_CHANGE_REQUIRED');
  const seen = new Set();
  for (const item of declarations) {
    requireValue(item && changes.has(item.id) && !seen.has(item.id) && changes.get(item.id) === item.action && nonempty(item.reason) && nonempty(item.authorizationRef), 'CONTRACT_REQUIREMENT_CHANGE_REQUIRED');
    seen.add(item.id);
  }
  // These references record the caller's authorization declaration, not proof of user approval.
}
async function noLinks(absolute, missing = false) {
  let current = path.parse(path.resolve(absolute)).root;
  for (const part of path.resolve(absolute).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { const st = await fs.lstat(current); requireValue(!st.isSymbolicLink() && (st.isDirectory() || st.nlink === 1), 'UNSAFE_STATE_PATH'); }
    catch (e) { if (missing && e.code === 'ENOENT') return; throw e; }
  }
}
async function writeNew(store, name, bytes) {
  const target = store.file(name); await noLinks(store.directory); await noLinks(target, true);
  const handle = await fs.open(target, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return { file: name, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) };
}
export async function readAsset(store, ref) {
  requireValue(ref && typeof ref.file === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256), 'INVALID_ASSET_REF');
  const target = store.file(ref.file); await noLinks(target);
  const bytes = await fs.readFile(target);
  requireValue(bytes.length === ref.bytes && digest(bytes) === ref.sha256, 'EVIDENCE_TAMPERED');
  return bytes;
}
function validate(contract) {
  requireValue(contract && typeof contract === 'object');
  identifier(contract.id);
  requireValue(Number.isInteger(contract.revision) && contract.revision > 0);
  requireValue(contract.gitOwner === 'Codex' && nonempty(contract.authorizationRef) && Object.hasOwn(contract, 'feeAuthorizationRef') && (contract.feeAuthorizationRef === null || nonempty(contract.feeAuthorizationRef)));
  requireValue(Array.isArray(contract.stopConditions) && contract.stopConditions.length && contract.stopConditions.every(nonempty));
  requireValue(path.isAbsolute(contract.nativeCwd || '') && path.isAbsolute(contract.executionRoot || ''));
  for (const key of ['allowedFiles', 'protectedFiles']) { requireValue(Array.isArray(contract[key])); contract[key].forEach(relativeFile); requireValue(new Set(contract[key]).size === contract[key].length); }
  requireValue(contract.allowedFiles.every(x => !contract.protectedFiles.includes(x)));
  if (contract.textFiles !== undefined) {
    requireValue(Array.isArray(contract.textFiles) && new Set(contract.textFiles).size === contract.textFiles.length);
    contract.textFiles.forEach(relativeFile);
    requireValue(contract.textFiles.every(file => contract.allowedFiles.includes(file) && !contract.protectedFiles.includes(file)), 'INVALID_CONTRACT_PATH');
  }
  if (process.platform === 'win32') {
    const all = [...contract.allowedFiles, ...contract.protectedFiles].map(x => x.toLowerCase());
    requireValue(new Set(all).size === all.length, 'INVALID_CONTRACT_PATH');
  }
  requireValue(Array.isArray(contract.requirements) && contract.requirements.length && contract.requirements.every(r => nonempty(r.id) && nonempty(r.text)) && new Set(contract.requirements.map(r => r.id)).size === contract.requirements.length);
  requireValue(Array.isArray(contract.testPlan));
  const ids = new Set();
  for (const plan of contract.testPlan) {
    identifier(plan.id); requireValue(!ids.has(plan.id)); ids.add(plan.id);
    requireValue(nonempty(plan.owner) && nonempty(plan.purpose) && ['targeted', 'repo-full'].includes(plan.scope) && ['guard', 'probe'].includes(plan.domain) && ['command', 'pytest'].includes(plan.runner));
    requireValue(path.isAbsolute(plan.executable || '') && !/\.(cmd|bat)$/i.test(plan.executable), 'INVALID_EXECUTABLE');
    requireValue(Array.isArray(plan.argv) && plan.argv.every(a => typeof a === 'string' && !a.includes('\0')));
    requireValue(Number.isInteger(plan.timeoutMs) && plan.timeoutMs >= 1 && plan.timeoutMs <= 300000);
    requireValue(Array.isArray(plan.inputs) && plan.inputs.length > 0); plan.inputs.forEach(relativeFile);
    if (plan.runtimeInputs !== undefined) requireValue(Array.isArray(plan.runtimeInputs) && plan.runtimeInputs.every(x => typeof x === 'string' && path.isAbsolute(x)), 'INVALID_RUNTIME_INPUTS');
    requireValue(plan.env && typeof plan.env === 'object' && !Array.isArray(plan.env) && Object.entries(plan.env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && !v.includes('\0')));
    requireValue(Array.isArray(plan.expectedNodeids) && plan.expectedNodeids.every(nonempty) && new Set(plan.expectedNodeids).size === plan.expectedNodeids.length);
    if (plan.runner === 'pytest') requireValue(plan.expectedNodeids.length > 0 && plan.argv.includes('pytest'), 'INVALID_PYTEST_RUNNER');
  }
}
function changed(base, current) {
  const own = (files, key) => Object.hasOwn(files, key) ? files[key] : null;
  return [...new Set([...Object.keys(base.files), ...Object.keys(current.files)])].filter(x => jsonDigest(own(base.files, x)) !== jsonDigest(own(current.files, x)));
}
function indexMap(lines) {
  const files = Object.create(null);
  for (const line of lines) { const at = line.indexOf('\t'), name = line.slice(at + 1); (files[name] ||= []).push(line.slice(0, at)); }
  for (const stages of Object.values(files)) stages.sort();
  return files;
}
const contractFiles = contract => [...new Set([...contract.allowedFiles, ...contract.protectedFiles, ...contract.testPlan.flatMap(p => p.inputs)])];
async function testIdentity(plan, source, contractSha) {
  const executable = await fs.realpath(plan.executable); await noLinks(plan.executable);
  const runtime = [];
  for (const name of plan.runtimeInputs || []) { await noLinks(name); runtime.push({ file: name, sha256: digest(await fs.readFile(name)) }); }
  const identity = { contractSha, source, plan, executable: digest(await fs.readFile(executable)), runtime, platform: process.platform, arch: process.arch, systemRoot: process.platform === 'win32' ? process.env.SystemRoot : null, runnerVersion: digest(await fs.readFile(new URL('./execution.mjs', import.meta.url))), contractVersion: digest(await fs.readFile(new URL('./contract.mjs', import.meta.url))), reporterVersion: digest(await fs.readFile(new URL('./pytest-reporter.py', import.meta.url))) };
  // runtimeInputs is an explicit complete external dependency inventory (empty for stdlib-only).
  // Without it, source/lock hashes do not prove an installed environment unchanged.
  return { executable, fingerprint: jsonDigest(identity), reusable: Array.isArray(plan.runtimeInputs) };
}
function evidencePass(run) {
  if (run.exitCode !== 0 || run.termination !== 'exited' || run.stdout.bytes === 0 || run.sourceBefore !== run.sourceAfter || run.testFingerprint !== run.testFingerprintAfter) return false;
  if (run.runner !== 'pytest') return true;
  const p = run.pytest;
  if (!Array.isArray(p?.observedCwds) || !p.observedCwds.length || !p.observedCwds.every(cwd => cwd === run.cwd)) return false;
  return p?.finished === true && p.exitstatus === 0 && p.cwd === run.cwd && Array.isArray(p.collected) && p.collected.length > 0 && Array.isArray(p.outcomes) && jsonDigest([...p.collected].sort()) === jsonDigest([...run.expectedNodeids].sort()) && p.outcomes.every(o => o && o.outcome !== 'failed') && p.collected.every(id => p.outcomes.some(o => o.nodeid === id && o.when === 'call' && o.outcome === 'passed') && p.outcomes.some(o => o.nodeid === id && o.when === 'teardown' && o.outcome === 'passed'));
}
async function targetedEvidence(service, task, contract, runs) {
  for (const plan of contract.testPlan.filter(p => p.scope === 'targeted')) {
    let found = false;
    for (const id of runs) { const r = await service.receipt({ task, run: id }); if (r.caseId === plan.id && r.passed) found = true; }
    requireValue(found, 'TARGETED_EVIDENCE_REQUIRED');
  }
}

export class ContractService {
  constructor({ store }) { this.store = store; }
  async bind({ task, contract }) {
    identifier(task); validate(contract);
    return this.store.withLock(`dispatch-${task}.lock`, async () => {
      const bound = await this.store.task(task);
      requireValue(path.resolve(await fs.realpath(contract.nativeCwd)) === path.resolve(await fs.realpath(bound.cwd)), 'CONTRACT_NATIVE_CWD_MISMATCH');
      await noLinks(contract.executionRoot);
      let baseline = await snapshot(contract.executionRoot, contractFiles(contract), contract.textFiles);
      for (const file of [...contract.allowedFiles, ...contract.protectedFiles, ...contract.testPlan.flatMap(p => p.inputs)]) await safeFile(baseline.root, file, true);
      if (bound.contractRef) {
        const previous = await this.inspect({ task });
        await this.check({ task, contractSha: previous.contractSha });
        requireValue(contract.id === previous.contract.id && contract.revision === previous.contract.revision + 1 && contract.supersedes === previous.contractSha, 'INVALID_CONTRACT_REVISION');
        requireValue(contract.decision?.approved === true && nonempty(contract.decision?.reason), 'CONTRACT_DECISION_REQUIRED');
        requirementRevision(previous.contract, contract);
        if (baseline.root === previous.baseline.root) baseline = previous.baseline;
      } else requireValue(contract.revision === 1 && (contract.supersedes === null || contract.supersedes === undefined), 'INVALID_CONTRACT_REVISION');
      const asset = { schema: 'dsh-contract/v1', contract, baseline, binding: { task, sessionId: bound.sessionId, nativeCwd: await fs.realpath(bound.cwd) } };
      const bytes = JSON.stringify(asset), sha = digest(bytes);
      const ref = await writeNew(this.store, `contract-${sha}.json`, bytes);
      await this.store.transaction(state => { requireValue(state.tasks[task].sessionId === bound.sessionId, 'CONTRACT_BINDING_CHANGED'); state.tasks[task].contractRef = { ...ref, sha, id: contract.id, revision: contract.revision }; delete state.tasks[task].readinessRef; });
      return { contractSha: sha, contractRef: { ...ref, sha, id: contract.id, revision: contract.revision }, baselineFingerprint: baseline.fingerprint };
    });
  }
  async inspect({ task }) {
    const bound = await this.store.task(task);
    requireValue(bound.contractRef, 'CONTRACT_NOT_BOUND');
    const asset = JSON.parse(await readAsset(this.store, bound.contractRef));
    requireValue(asset.binding.task === task && asset.binding.sessionId === bound.sessionId && path.resolve(asset.binding.nativeCwd) === path.resolve(await fs.realpath(bound.cwd)), 'CONTRACT_BINDING_CHANGED');
    return { ...asset, contractSha: bound.contractRef.sha };
  }
  async check({ task, contractSha }) {
    const asset = await this.inspect({ task });
    requireValue(contractSha === asset.contractSha, 'CONTRACT_HASH_MISMATCH');
    requireValue(!unresolvedExecution(await this.store.task(task)), 'UNRESOLVED_EXECUTION');
    for (const file of contractFiles(asset.contract)) await safeFile(asset.contract.executionRoot, file, true);
    const current = await snapshot(asset.contract.executionRoot, contractFiles(asset.contract), asset.contract.textFiles);
    requireValue(current.root === asset.baseline.root && jsonDigest(current.rootIdentity) === jsonDigest(asset.baseline.rootIdentity), 'CONTRACT_EXECUTION_ROOT_CHANGED');
    requireValue(current.head === asset.baseline.head && current.branch === asset.baseline.branch, 'CONTRACT_GIT_BASE_CHANGED');
    const baseIndex = indexMap(asset.baseline.index), nowIndex = indexMap(current.index);
    const indexChanges = [...new Set([...Object.keys(baseIndex), ...Object.keys(nowIndex)])].filter(x => jsonDigest(baseIndex[x] ?? null) !== jsonDigest(nowIndex[x] ?? null));
    const files = [...new Set([...changed(asset.baseline, current), ...indexChanges])];
    requireValue(files.every(f => asset.contract.allowedFiles.includes(f) && !asset.contract.protectedFiles.includes(f)), 'CONTRACT_FILE_SCOPE_VIOLATION');
    return { ...asset, sourceFingerprint: current.fingerprint, current, changedFiles: files };
  }
  async receipt({ task, run }) {
    identifier(run);
    const bound = await this.store.task(task), ref = bound.contractRuns?.find(r => r.id === run);
    if (!ref) {
      const intent = bound.executionIntents?.find(item => item.runId === run);
      requireValue(intent, 'RUN_NOT_FOUND');
      if (intent.state === 'SETTLED' && intent.termination === 'not-started') {
        const asset = JSON.parse(await readAsset(this.store, intent.intentRef));
        requireValue(asset.runId === run && asset.task === task && asset.contractSha === intent.contractSha && asset.caseId === intent.caseId, 'EVIDENCE_TAMPERED');
        return { runId: run, task, caseId: intent.caseId, contractSha: intent.contractSha, executionState: 'NOT_STARTED', valid: false, passed: false, evidenceComplete: false, cleanup: 'NOT_STARTED' };
      }
      return { runId: run, task, caseId: intent.caseId, contractSha: intent.contractSha, executionState: 'UNKNOWN', valid: false, passed: false, evidenceComplete: false, cleanup: 'UNVERIFIED' };
    }
    const receipt = JSON.parse(await readAsset(this.store, ref));
    const recordedIntent = bound.executionIntents?.find(item => item.runId === run);
    if (recordedIntent?.state === 'SETTLED') {
      const intent = JSON.parse(await readAsset(this.store, recordedIntent.intentRef));
      requireValue(intent.runId === run && intent.task === task && intent.contractSha === receipt.contractSha && intent.caseId === receipt.caseId, 'EVIDENCE_TAMPERED');
    }
    await readAsset(this.store, receipt.stdout); await readAsset(this.store, receipt.stderr);
    if (receipt.pytestAsset) requireValue(jsonDigest(JSON.parse(await readAsset(this.store, receipt.pytestAsset))) === jsonDigest(receipt.pytest), 'EVIDENCE_TAMPERED');
    if (unresolvedExecution(bound)) return { ...receipt, executionState: 'UNKNOWN', valid: false, evidenceComplete: evidencePass(receipt), passed: false };
    const current = await this.check({ task, contractSha: receipt.contractSha });
    const plan = current.contract.testPlan.find(p => p.id === receipt.caseId);
    const identity = await testIdentity(plan, current.sourceFingerprint, receipt.contractSha);
    const valid = identity.reusable && current.sourceFingerprint === receipt.sourceAfter && identity.fingerprint === receipt.testFingerprint;
    return { ...receipt, valid, evidenceComplete: evidencePass(receipt), passed: valid && evidencePass(receipt) };
  }
  async readiness({ task, contractSha, review }) {
    return this.store.withLock(`dispatch-${identifier(task)}.lock`, async () => {
      const checked = await this.check({ task, contractSha });
      await this.store.transaction(state => { delete state.tasks[task].readinessRef; });
      if (!review || !Array.isArray(review.blockers) || review.blockers.length !== 0 || !Array.isArray(review.targetedRuns)) {
        throw fault('REVIEW_BLOCKED');
      }
      await targetedEvidence(this, task, checked.contract, review.targetedRuns);
      const ready = { contractSha, sourceFingerprint: checked.sourceFingerprint, review, ready: true };
      const ref = await writeNew(this.store, `readiness-${randomUUID()}.json`, JSON.stringify(ready));
      await this.store.transaction(state => { state.tasks[task].readinessRef = { ...ref, contractSha, sourceFingerprint: ready.sourceFingerprint }; });
      return ready;
    });
  }
  async run({ task, contractSha, case: caseId, owner, rerunReason, signal }) {
    return this.store.withLock(`dispatch-${identifier(task)}.lock`, async () => {
      requireValue(!(await this.store.task(task)).stopRequested, 'TASK_STOPPED');
      requireValue(rerunReason === undefined || nonempty(rerunReason), 'INVALID_RERUN_REASON');
      const checked = await this.check({ task, contractSha });
      const plan = checked.contract.testPlan.find(p => p.id === caseId);
      requireValue(plan, 'CASE_NOT_IN_CONTRACT'); requireValue(owner === plan.owner, 'TEST_OWNER_MISMATCH');
      requireValue(plan.inputs.every(file => checked.current.files[file] !== null && checked.current.files[file] !== undefined), 'TEST_INPUT_MISSING');
      const { executable, fingerprint, reusable } = await testIdentity(plan, checked.sourceFingerprint, contractSha);
      const bound = await this.store.task(task), previous = [];
      if (plan.scope === 'repo-full') {
        const ref = bound.readinessRef; requireValue(ref && ref.contractSha === contractSha && ref.sourceFingerprint === checked.sourceFingerprint, 'READINESS_REQUIRED');
        const ready = JSON.parse(await readAsset(this.store, ref)); requireValue(ready.ready && ready.contractSha === contractSha && ready.sourceFingerprint === checked.sourceFingerprint && ready.review.blockers.length === 0, 'READINESS_REQUIRED');
        await targetedEvidence(this, task, checked.contract, ready.review.targetedRuns);
      }
      for (const ref of bound.contractRuns || []) {
        const old = JSON.parse(await readAsset(this.store, ref));
        if (old.contractSha === contractSha && old.caseId === caseId) {
          previous.push(old);
          const verified = await this.receipt({ task, run: old.runId });
          if (reusable && old.testFingerprint === fingerprint && verified.passed && !rerunReason) return { ...verified, reused: true, reuseOf: old.runId };
        }
        if (old.contractSha === contractSha && old.purpose === plan.purpose && old.domain === plan.domain && old.caseId !== caseId && old.expectedNodeids.some(id => plan.expectedNodeids.includes(id)) && !rerunReason) throw fault('OVERLAPPING_TEST_REASON_REQUIRED');
      }
      requireValue(!previous.length || nonempty(rerunReason), 'RERUN_REASON_REQUIRED');
      const runId = randomUUID(), prefix = `run-${runId}`;
      const reportName = `${prefix}.pytest.json`, reportPath = this.store.file(reportName);
      requireValue(!(await this.store.task(task)).stopRequested, 'TASK_STOPPED');
      const intent = { schema: 'dsh-execution-intent/v1', task, runId, caseId, contractSha, owner, sourceBefore: checked.sourceFingerprint, testFingerprint: fingerprint, state: 'STARTING', startedAt: new Date().toISOString() };
      const intentBytes = JSON.stringify(intent), intentRef = { file: `${prefix}.intent.json`, bytes: Buffer.byteLength(intentBytes), sha256: digest(intentBytes) };
      // Commit the blocking marker first: a crash before the separate immutable asset
      // write must still prevent another process from launching the same work.
      await this.store.transaction(state => { (state.tasks[task].executionIntents ||= []).push({ ...intent, intentRef }); });
      await writeNew(this.store, intentRef.file, intentBytes);
      const launch = await this.store.transaction(state => {
        if (state.tasks[task].stopRequested) {
          Object.assign(state.tasks[task].executionIntents.find(item => item.runId === runId), { state: 'SETTLED', termination: 'not-started' });
          return null;
        }
        // executeCase calls spawn synchronously, before its first await. Order
        // process launch against the stop flag without holding the lock for its lifetime.
        return { outcome: executeCase(plan, checked.contract.executionRoot, reportPath, { signal }).then(result => ({ result }), error => ({ error })) };
      });
      requireValue(launch, 'TASK_STOPPED');
      const execution = await launch.outcome;
      if (execution.error) throw execution.error;
      const result = execution.result;
      const stdout = await writeNew(this.store, `${prefix}.stdout`, result.stdout), stderr = await writeNew(this.store, `${prefix}.stderr`, result.stderr);
      let pytestAsset = null;
      if (result.pytest) { await noLinks(reportPath); const bytes = await fs.readFile(reportPath); pytestAsset = { file: reportName, bytes: bytes.length, sha256: digest(bytes) }; }
      let after, sourceError = null;
      try { after = await snapshot(checked.contract.executionRoot, contractFiles(checked.contract), checked.contract.textFiles); }
      catch (e) { sourceError = ['UNSAFE_EXECUTION_PATH', 'INVALID_EXECUTION_FILE'].includes(e.code) ? e.code : 'SOURCE_VERIFICATION_FAILED'; after = { fingerprint: null }; }
      let testFingerprintAfter = null;
      try { testFingerprintAfter = (await testIdentity(plan, after.fingerprint, contractSha)).fingerprint; } catch { sourceError ||= 'RUNTIME_VERIFICATION_FAILED'; }
      const receipt = { schema: 'dsh-run/v1', runId, task, contractSha, caseId, owner, scope: plan.scope, purpose: plan.purpose, domain: plan.domain, runner: plan.runner, expectedNodeids: plan.expectedNodeids, executable, argv: result.argv, testFingerprint: fingerprint, reusable, sourceBefore: checked.sourceFingerprint, sourceAfter: after.fingerprint, sourceError, exitCode: result.exitCode, signal: result.signal, termination: result.termination, cleanup: result.termination === 'exited' ? 'DIRECT_CHILD_EXITED' : 'UNVERIFIED', stdout, stderr, pytest: result.pytest, pytestAsset, rerunReason: rerunReason || null, limits: 'Local child execution, no OS sandbox or descendant containment; command runner has no test collection proof. Reuse requires an explicit complete runtimeInputs inventory.' };
      Object.assign(receipt, { testFingerprintAfter, byteSourceBefore: checked.current.byteFingerprint, byteSourceAfter: after.byteFingerprint ?? null, cwd: await fs.realpath(checked.contract.executionRoot) });
      const ref = await writeNew(this.store, `${prefix}.json`, JSON.stringify(receipt));
      await this.store.transaction(state => {
        (state.tasks[task].contractRuns ||= []).push({ ...ref, id: runId });
        const pending = state.tasks[task].executionIntents.find(item => item.runId === runId);
        pending.state = result.termination === 'exited' ? 'SETTLED' : 'UNKNOWN';
        pending.receiptRef = ref;
      });
      const valid = reusable && after.fingerprint === checked.sourceFingerprint && fingerprint === testFingerprintAfter;
      return { ...receipt, valid, evidenceComplete: evidencePass(receipt), passed: valid && evidencePass(receipt), reused: false };
    }, { timeoutMs: 310000 });
  }
}
