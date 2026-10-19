import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const root = resolve(import.meta.dirname, '../..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = value => createHash('sha256').update(value).digest('hex');

test('full native Web and separate product CLI processes collaborate through LOCAL_MOCK', {
  skip: !process.env.DSH_ROOT ? 'Set DSH_ROOT to an installed complete built native Harness (Windows and Python required)' : false,
  timeout: 230_000,
}, async t => {
  assert.equal(process.platform, 'win32', 'This fixture requires Windows Job Objects');
  const cache = join(root, '.cache/controller-e2e');
  await mkdir(cache, { recursive: true });
  const run = await mkdtemp(join(cache, 'run-'));
  const startedAt = Date.now();
  const state = join(run, 'controller-state');
  const codexHome = join(run, 'codex-home');
  const callerA = join(run, 'caller-a');
  const callerB = join(run, 'caller-b');
  await Promise.all([mkdir(callerA), mkdir(callerB)]);
  const report = { kind: 'LOCAL_MOCK', status: 'FAIL', checks: [], commands: [], limits: ['Native root HTTP availability is not visual UI parity', 'Loopback guard and fixture directories are not an OS sandbox', 'No real model quality, full context or provider cost claim', 'Author execution evidence; independent acceptance required'] };
  const entry = join(process.env.DSH_ROOT, 'apps/cli/lib/bin.js');
  const before = hash(await readFile(entry));
  const nativePaths = ['apps/cli/lib/bin.js', 'packages/interaction/user-approval/lib/index.js', 'packages/sandbox/sandbox/lib/index.js'];
  const nativeBefore = Object.fromEntries(await Promise.all(nativePaths.map(async p => [p, hash(await readFile(join(process.env.DSH_ROOT, p)))])));
  const approvalEntry = join(process.env.DSH_ROOT, 'packages/interaction/user-approval/lib/index.js');
  const approvalBytes = await readFile(approvalEntry);
  const sourceFixture = process.env.DSH_APPROVAL_SOURCE_FIXTURE === '1';
  report.executionMode = sourceFixture ? 'SOURCE_FIXTURE' : 'INSTALLED_BUILT';
  report.command = ['DSH_ROOT=<installed-native-root>', ...(sourceFixture ? ['DSH_APPROVAL_SOURCE_FIXTURE=1'] : []), 'node', '--test', 'test/native/*.test.mjs'];
  report.hostCommand = ['node', '--require', 'test/helpers/loopback-only.cjs', ...(sourceFixture ? ['--require', 'test/helpers/approval-source-fixture.cjs'] : []), '<DSH_ROOT>/apps/cli/lib/bin.js', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'];
  report.processOwnership = { kind: 'Windows Job Object', attachBeforeGo: true, watchdogSeconds: 240, parentDeathCleanup: 'stdin EOF and kill-on-job-close' };
  const approvalBypass = !sourceFixture && approvalBytes.includes(Buffer.from('[dsh-purge] approval bypass'));
  report.nativeApproval = { entry: 'packages/interaction/user-approval/lib/index.js', sha256: hash(approvalBytes), status: approvalBypass ? 'BLOCKED_NATIVE_APPROVAL_BYPASS' : 'UNVERIFIED' };
  if (sourceFixture) report.nativeApproval.sourceSha256 = hash(await readFile(join(process.env.DSH_ROOT, 'packages/interaction/user-approval/src/index.ts')));
  const fixture = spawn('python', ['-B', join(root, 'test/helpers/native_fixture.py'), run, process.env.DSH_ROOT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let ready;
  const lines = createInterface({ input: fixture.stdout });
  const readyPromise = new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Native fixture readiness timeout')), 60_000);
    lines.on('line', line => {
      const value = JSON.parse(line);
      if (value.ready) { clearTimeout(timer); accept(value); }
      if (value.fixtureError) { clearTimeout(timer); reject(new Error(value.fixtureError)); }
    });
    fixture.once('exit', () => { clearTimeout(timer); reject(new Error('Native fixture exited before readiness')); });
  });
  const check = (name, ok) => { report.checks.push({ name, passed: !!ok }); assert.ok(ok, name); };
  const cli = (args, { input = '', timeout = 30_000, useProfile = false, cwd = root } = {}) => new Promise((accept, reject) => {
    const stateArgs = useProfile ? [] : ['--state-dir', state];
    report.commands.push(['CODEX_HOME=<fixture>/codex-home', `cwd=${cwd.replaceAll(run, '<fixture>').replaceAll(root, '<tool-root>')}`, 'node', '<tool-root>/bin/codex-dsh.mjs', ...[...args, ...stateArgs].map(a => String(a).replaceAll(run, '<fixture>').replace(/^http:\/\/127\.0\.0\.1:\d+$/, '<native-loopback-base>'))]);
    const child = spawn(process.execPath, [join(root, 'bin/codex-dsh.mjs'), ...args, ...stateArgs], { cwd, env: { ...process.env, CODEX_HOME: codexHome }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errorBytes = 0;
    child.stdout.on('data', d => { output += d; if (output.length > 4 * 1024 * 1024) child.kill(); });
    child.stderr.on('data', d => { errorBytes += d.length; });
    child.stdin.end(input);
    const timer = setTimeout(() => child.kill(), timeout);
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timer);
      try { accept({ code, value: JSON.parse(output), errorBytes }); }
      catch { reject(new Error(`CLI ${args[0]} did not return JSON (exit ${code}; stderr bytes ${errorBytes})`)); }
    });
  });
  const status = async task => (await cli(['status', '--task', task])).value;
  const mockState = async () => (await fetch(`http://127.0.0.1:${ready.mockPort}/state`)).json();
  const until = async (fn, ms = 15_000) => {
    const end = Date.now() + ms;
    do { const value = await fn(); if (value) return value; await sleep(150); } while (Date.now() < end);
    throw new Error('E2E condition timeout');
  };
  const send = async (task, phase, wait = '15') => {
    const file = join(run, `${phase}.txt`);
    await writeFile(file, `[E2E:${phase}] Perform the requested fixture action through native tools.`);
    return cli(['send', '--task', task, '--text-file', file, '--allow-model', '--wait', wait], { timeout: 35_000 });
  };
  try {
    ready = await readyPromise;
    const profileOptions = { useProfile: true, cwd: callerA };
    const setup = await cli(['setup', '--url', `http://127.0.0.1:${ready.port}`, '--token-stdin'], { ...profileOptions, input: ready.token + '\n' });
    check('setup authenticates native Host in isolated CODEX_HOME', setup.code === 0 && setup.value.skillInstalled === true && setup.value.authenticationRequired === false);
    const profileState = join(codexHome, 'codex-dsh-state');
    check('setup selects personal shared state inside fixture', setup.value.stateDir === profileState);
    const installedSkillRoot = join(codexHome, 'skills/codex-dsh-collab');
    const installedSkill = await readFile(join(installedSkillRoot, 'SKILL.md'));
    check('setup installs unchanged portable Skill body', installedSkill.equals(await readFile(join(root, '.agents/skills/codex-dsh-collab/SKILL.md'))));
    const settingsBytes = await readFile(join(installedSkillRoot, 'local-settings.json'));
    const settings = JSON.parse(settingsBytes);
    check('generated local settings locate tool and shared ledger', resolve(settings.toolRoot) === root && settings.stateDir === profileState && settings.connection === 'native');
    check('generated local settings exclude native token and cookie', !settingsBytes.includes(Buffer.from(ready.token)) && !/cookie/i.test(settingsBytes.toString()));
    const connections = await cli(['connections'], { useProfile: true, cwd: callerB });
    check('another working directory discovers setup connection without state flag', connections.code === 0 && connections.value.connections?.some(c => c.name === 'native'));
    const profileStarted = await cli(['start', '--connection', 'native', '--cwd', join(run, 'workspace'), '--task', 'setup-e2e', '--title', 'LOCAL_MOCK portable setup E2E'], profileOptions);
    check('profile start creates native session without explicit state directory', profileStarted.code === 0 && profileStarted.value.scope === 'exclusive');
    const profilePrompt = join(run, 'profile-prompt.txt');
    await writeFile(profilePrompt, '[E2E:OTHER] Complete this isolated portable setup fixture turn.');
    const profileSent = await cli(['send', '--task', 'setup-e2e', '--text-file', profilePrompt, '--allow-model', '--wait', '15'], { useProfile: true, cwd: callerB, timeout: 35_000 });
    check('profile send from different directory completes native turn', profileSent.value.requests?.at(-1)?.state === 'COMPLETED');
    const profileStatus = await cli(['status', '--task', 'setup-e2e'], profileOptions);
    check('profile status recovers same session and request from original directory', profileStatus.value.sessionId === profileStarted.value.sessionId && profileStatus.value.requests?.[0]?.requestId === profileSent.value.requests?.[0]?.requestId);
    check('profile reply remains available in shared ledger', profileStatus.value.requests?.[0]?.resultFile?.startsWith(profileState) && (await readFile(profileStatus.value.requests[0].resultFile, 'utf8')) === 'E2E_DONE');
    const setupAgain = await cli(['setup', '--url', `http://127.0.0.1:${ready.port}`, '--token-stdin'], { useProfile: true, cwd: callerB, input: ready.token + '\n' });
    const profileRecovered = await cli(['status', '--task', 'setup-e2e'], { useProfile: true, cwd: callerB });
    check('repeated setup preserves existing native request ledger', setupAgain.code === 0 && profileRecovered.value.requests?.[0]?.requestId === profileSent.value.requests?.[0]?.requestId);
    const discovered = (await cli(['connections'], { useProfile: true, cwd: callerB })).value.connections?.find(c => c.name === 'native');
    check('connections exposes existing task locator across projects', discovered?.tasks?.some(task => task.id === 'setup-e2e' && task.sessionId === profileStarted.value.sessionId));
    check('cross-directory profile use never creates cwd fallback ledgers', !(await readdir(callerA)).includes('.codex-dsh') && !(await readdir(callerB)).includes('.codex-dsh'));
    report.portableSetup = { codexHome: '<fixture>/codex-home', profile: '<fixture>/codex-home/skills/codex-dsh-collab/local-settings.json', stateDir: '<fixture>/codex-home/codex-dsh-state', skillSha256: hash(installedSkill), task: 'setup-e2e', sessionId: profileStarted.value.sessionId, requestId: profileSent.value.requests?.[0]?.requestId };
    const attach = await cli(['attach', '--name', 'native', '--url', `http://127.0.0.1:${ready.port}`, '--token-stdin'], { input: ready.token + '\n' });
    check('product attach authenticates full native Host', attach.code === 0);
    const started = await cli(['start', '--connection', 'native', '--cwd', join(run, 'workspace'), '--task', 'e2e', '--title', 'LOCAL_MOCK native CLI E2E']);
    check('product creates native exclusive session', started.code === 0 && started.value.scope === 'exclusive');
    const task = started.value.task;
    const build = await send(task, 'BUILD');
    check('native write completes via product CLI', build.value.requests?.at(-1)?.state === 'COMPLETED');
    check('Codex reads native write artifact', await readFile(join(run, 'workspace/result.txt'), 'utf8') === 'version=1\n');
    const first = await status(task);
    const followed = await cli(['follow', '--task', task, '--wait', '1']);
    check('independent follow recovers completed request', followed.value.requests?.[0]?.requestId === first.requests?.[0]?.requestId);
    const countBefore = (await mockState()).count;
    const resumed = await cli(['resume', '--task', task]);
    check('separate CLI process recovers persisted request ID', resumed.value.requests?.[0]?.requestId === first.requests?.[0]?.requestId);
    check('resume never resends completed prompt', (await mockState()).count === countBefore);
    const fixed = await send(task, 'FIX');
    check('second native edit completes', fixed.value.requests?.at(-1)?.state === 'COMPLETED');
    const artifact = await readFile(join(run, 'workspace/result.txt'));
    check('Codex acceptance observes second-round edit', artifact.toString() === 'version=2\n');
    report.artifact = { path: 'workspace/result.txt', sha256: hash(artifact) };
    await t.test('native approval broker allowed-once and rejected', { skip: approvalBypass ? 'Installed native built approval service auto-grants before waterfall; external install unchanged' : false }, async () => {
      for (const phase of ['REJECT', 'ALLOW']) {
        const watching = send(task, phase, '20');
        const approval = await until(async () => {
          const current = (await cli(['approvals', '--task', task])).value;
          return current.approvals?.find(a => a.state === 'PENDING' || a.state === 'pending');
        });
        const decision = phase === 'ALLOW' ? 'allowed-once' : 'rejected';
        const approved = await cli(['approve', '--task', task, '--approval', approval.eventId, '--decision', decision]);
        check(`separate CLI ${decision} accepted by live native broker`, approved.code === 0);
        const settled = await watching;
        check(`${decision} native turn completes`, settled.value.requests?.at(-1)?.state === 'COMPLETED');
      }
      check('approved write exists only in owned outbox', await readFile(join(run, 'outbox/allow.txt'), 'utf8') === 'version=1\n');
      let rejectedExists = true;
      try { await readFile(join(run, 'outbox/reject.txt')); } catch (e) { if (e.code === 'ENOENT') rejectedExists = false; else throw e; }
      check('rejected native write produces no file', !rejectedExists);
      report.nativeApproval.status = 'VERIFIED_LOCAL_MOCK';
    });
    const other = await cli(['start', '--connection', 'native', '--cwd', join(run, 'workspace'), '--task', 'other']);
    check('second native session exists on same shared Host', other.code === 0 && other.value.sessionId !== started.value.sessionId);
    const hold = await send(task, 'HOLD', '1');
    check('observation timeout does not mark completion', hold.value.observationTimedOut === true && hold.value.requests?.at(-1)?.state !== 'COMPLETED');
    await until(async () => (await mockState()).holdStarted);
    check('observation timeout leaves provider connected', !(await mockState()).disconnected);
    const stopped = await cli(['stop', '--task', task]);
    check('stop retains STOP_PENDING after observed native tools', stopped.value.state === 'STOP_PENDING');
    await until(async () => (await mockState()).disconnected);
    check('stop interrupts owned provider stream', (await mockState()).disconnected);
    check('another native session remains accessible', (await status(other.value.task)).sessionId === other.value.sessionId);
    check('another session can still execute native prompt after stop', (await send(other.value.task, 'OTHER')).value.requests?.at(-1)?.state === 'COMPLETED');
    const privateState = JSON.parse(await readFile(join(state, 'state.json'), 'utf8'));
    check('authenticated native UI root remains HTTP 200', (await fetch(`http://127.0.0.1:${ready.port}/`, { headers: { cookie: privateState.connections.native.cookie } })).status === 200);
    report.requestLinks = (await status(task)).requests?.map(r => ({ requestId: r.requestId, turn: r.turn, state: r.state }));
    check('every completed request retains native turn association', report.requestLinks.filter(r => r.state === 'COMPLETED').every(r => r.turn != null));
    const recoveredProfile = await cli(['status', '--task', 'setup-e2e'], { useProfile: true, cwd: callerB });
    const profileLedger = JSON.parse(await readFile(join(profileState, 'state.json'), 'utf8'));
    check('explicit state-directory scenario preserves separate personal ledger', recoveredProfile.value.requests?.[0]?.requestId === profileSent.value.requests?.[0]?.requestId && !profileLedger.tasks.e2e && !!privateState.tasks.e2e);
    report.status = approvalBypass ? 'PARTIAL_LOCAL_MOCK_NATIVE_APPROVAL_BLOCKED' : 'PASS_LOCAL_MOCK_PRODUCT_NATIVE_E2E';
  } catch (error) {
    report.failure = error.message.replaceAll(run, '<fixture>');
    throw error;
  } finally {
    const exited = once(fixture, 'exit');
    fixture.stdin.end();
    let cleanupTimer;
    await Promise.race([exited, new Promise(resolve => { cleanupTimer = setTimeout(() => { fixture.kill(); resolve(); }, 15_000); })]);
    clearTimeout(cleanupTimer);
    lines.close();
    try { Object.assign(report, JSON.parse(await readFile(join(run, 'fixture-result.json'), 'utf8'))); } catch { report.fixtureIncomplete = true; }
    report.selectedNativeEntryUnchanged = before === hash(await readFile(entry));
    report.wallSeconds = (Date.now() - startedAt) / 1000;
    report.nativeEntrySha256 = { before, after: hash(await readFile(entry)) };
    const nativeAfter = Object.fromEntries(await Promise.all(nativePaths.map(async p => [p, hash(await readFile(join(process.env.DSH_ROOT, p)))])));
    report.nativeFileHashes = { before: nativeBefore, after: nativeAfter };
    report.selectedNativeFilesUnchanged = JSON.stringify(nativeBefore) === JSON.stringify(nativeAfter);
    if (sourceFixture) {
      const sourceRoot = join(run, 'approval-source-fixture');
      report.sourceFixtureFiles = [];
      for (const name of await readdir(sourceRoot, { recursive: true })) {
        if (/\.(ts|mjs)$/.test(name)) report.sourceFixtureFiles.push({ path: name.replaceAll('\\', '/'), sha256: hash(await readFile(join(sourceRoot, name))) });
      }
    }
    if (report.checks.some(c => !c.passed)) report.status = 'FAIL_CHECK';
    if (report.jobActiveAfterCleanup !== 0 || !report.hostPortReleased || !report.mockPortReleased || report.provider?.errors?.length || report.provider?.count > 40 || report.egressDenied || report.logOverflow || !report.selectedNativeFilesUnchanged) report.status = 'FAIL_BOUNDARY_OR_CLEANUP';
    const reportFile = join(root, 'docs/references/controller-native-e2e.json');
    await mkdir(join(root, 'docs/references'), { recursive: true });
    let receipt = report;
    if (sourceFixture) {
      let installedBuilt;
      try { const prior = JSON.parse(await readFile(reportFile, 'utf8')); installedBuilt = prior.installedBuilt ?? prior; } catch {}
      receipt = { installedBuilt, sourceFixture: report, limits: ['SOURCE_FIXTURE recompiles user-approval and sandbox packages from installed TypeScript source using existing TypeScript; current installed built approval and escalation remain bypassed'] };
    }
    await writeFile(reportFile, JSON.stringify(receipt, null, 2) + '\n');
    await writeFile(join(run, 'e2e-result.json'), JSON.stringify(report, null, 2) + '\n');
    assert.ok(['PASS_LOCAL_MOCK_PRODUCT_NATIVE_E2E', 'PARTIAL_LOCAL_MOCK_NATIVE_APPROVAL_BLOCKED'].includes(report.status), report.failure ?? 'Fixture cleanup/boundary failed');
  }
});
