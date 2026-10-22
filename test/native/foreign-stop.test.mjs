import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { NativeClient, readHistory } from '../../src/native.mjs';
import { projectSession } from '../../src/events.mjs';

const root = resolve(import.meta.dirname, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const enabled = process.platform === 'win32' && process.env.DSH_ROOT && process.env.DSH_APPROVAL_SOURCE_FIXTURE !== '1';

// Each worker is assigned before GO; its native CLI descendants inherit the Job.
// Closing the supervisor's Job handle also cleans up after unexpected owner death.
const cliJob = String.raw`
import json, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from windows_job import Job
if sys.argv[2] == '--worker':
    if sys.stdin.buffer.readline().strip() != b'GO':
        sys.exit(3)
    config = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    sys.exit(subprocess.run(config['argv'], input=config['input'].encode('utf-8')).returncode)
config = json.loads(sys.stdin.buffer.read().decode('utf-8'))
job, child = Job(), None
try:
    child = subprocess.Popen([sys.executable, '-B', __file__, sys.argv[1], '--worker'], stdin=subprocess.PIPE)
    job.attach(child)
    child.stdin.write(('GO\n' + json.dumps(config)).encode('utf-8'))
    child.stdin.close()
    code = child.wait(timeout=40)
finally:
    job.terminate()
    for _ in range(100):
        if job.active() == 0:
            break
        time.sleep(.02)
    active = job.active()
    job.close()
    Path(config['cleanup']).write_text(json.dumps({'jobActiveAfterCleanup': active}), encoding='utf-8')
sys.exit(code)
`;

test('exclusive CLI stop preserves observed foreign native work', {
  skip: enabled ? false : 'Requires Windows and DSH_ROOT installed mode; source mode skipped, skip is not acceptance',
  timeout: 180_000,
}, async () => {
  const cache = join(root, '.cache/foreign-stop');
  await mkdir(cache, { recursive: true });
  const run = await mkdtemp(join(cache, 'run-'));
  const state = join(run, 'controller-state');
  const codexHome = join(run, 'codex-home');
  const launcher = join(run, 'cli-job.py');
  await writeFile(launcher, cliJob);
  const node = process.execPath;
  const hostNode = process.env.DSH_NODE_EXECUTABLE || node;
  const children = new Set();
  const launches = [];
  const report = {
    kind: 'LOCAL_MOCK', executionMode: 'INSTALLED_BUILT', status: 'FAIL',
    owner: 'foreign_stop_native', scope: 'Observed foreign running turn and foreign queue survive exclusive CLI stop',
    command: ['DSH_ROOT=<installed-native-root>', 'node', '--test', 'test/native/foreign-stop.test.mjs'],
    expectedMockRequests: 4, maxMockRequests: 7, checks: [], commands: [], sessions: [],
    processOwnership: { kind: 'Windows Job Object', attachBeforeGo: true, cliWatchdogSeconds: 40, parentDeathCleanup: 'Supervisor watchdog expires within 40 seconds; supervisor death closes kill-on-close Job; Host stdin EOF is separately supervised' },
    limits: ['Native check-to-cancel race without atomic conditional cancel is outside this test', 'Concurrent visual UI is not verified', 'No real provider requests or model quality claim', 'COMPLETED is turn completion; file effects are checked separately', 'Author execution evidence requires independent acceptance'],
  };
  const startedAt = Date.now();
  const selected = ['apps/cli/lib/bin.js', 'packages/interaction/user-approval/lib/index.js', 'packages/sandbox/sandbox/lib/index.js', 'packages/api/session-controller/lib/index.js', 'packages/core/agent-loop/lib/index.js', 'packages/llm/llm-deepseek/lib/index.js'];
  const hashes = async () => Object.fromEntries(await Promise.all(selected.map(async file => [file, hash(await readFile(join(process.env.DSH_ROOT, file)))])));
  const before = await hashes();
  report.fingerprints = await Promise.all(['src/controller.mjs', 'src/cli.mjs', 'src/view.mjs', 'test/native/foreign-stop.test.mjs', 'test/helpers/native_fixture.py', 'test/helpers/runtime-record.cjs', 'src/events.mjs', 'src/native.mjs', 'test/helpers/windows_job.py'].map(async file => ({ file, sha256: hash(await readFile(join(root, file))) })));
  const check = (name, passed) => { report.checks.push({ name, passed: !!passed }); assert.ok(passed, name); };
  const until = async (fn, label, ms = 15_000) => {
    const deadline = Date.now() + ms;
    do { const value = await fn(); if (value) return value; await sleep(100); } while (Date.now() < deadline);
    throw new Error(`Timeout: ${label}`);
  };
  const launch = (args, input = '') => {
    const number = launches.length + 1;
    const runtimeFile = join(run, `cli-runtime-${number}.json`);
    const cleanupFile = join(run, `cli-cleanup-${number}.json`);
    const stderrFile = join(run, `cli-stderr-${number}.bin`);
    const argv = [node, '--require', join(root, 'test/helpers/runtime-record.cjs'), join(root, 'bin/codex-dsh.mjs'), ...args, '--state-dir', state];
    const record = { args: args.map(value => value.replaceAll(run, '<fixture>').replace(/^http:\/\/127\.0\.0\.1:\d+$/, '<native-loopback-base>')), runtimeFile, cleanupFile, stderrFile };
    report.commands.push({ command: ['node', '--require', '<tool-root>/test/helpers/runtime-record.cjs', '<tool-root>/bin/codex-dsh.mjs', ...record.args, '--state-dir', '<fixture>/controller-state'], code: null });
    const command = report.commands.at(-1);
    const child = spawn('python', ['-B', launcher, join(root, 'test/helpers'), '--supervisor'], { cwd: root, env: { ...process.env, CODEX_HOME: codexHome, E2E_RUNTIME_RECORD: runtimeFile }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    const frames = [], lines = createInterface({ input: child.stdout });
    const stderr = [];
    let stdoutBytes = 0, stderrBytes = 0, invalid = false, timedOut = false, spawnFailed = false, overflow = false;
    lines.on('line', line => {
      stdoutBytes += Buffer.byteLength(line) + 1;
      if (stdoutBytes + stderrBytes > 4 * 1024 * 1024) { invalid = true; overflow = true; child.kill(); return; }
      try { frames.push(JSON.parse(line)); } catch { invalid = true; }
    });
    child.stderr.on('data', chunk => {
      const remaining = Math.max(0, 4 * 1024 * 1024 - stderrBytes);
      if (remaining) stderr.push(chunk.subarray(0, remaining));
      stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > 4 * 1024 * 1024) { invalid = true; overflow = true; child.kill(); }
    });
    const done = new Promise(accept => {
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45_000);
      child.once('error', () => { invalid = true; spawnFailed = true; });
      child.once('close', async code => {
        clearTimeout(timer); children.delete(child); lines.close(); command.code = code;
        const rawStderr = Buffer.concat(stderr);
        let errorValue;
        if (rawStderr.toString('utf8').trim()) { try { errorValue = JSON.parse(rawStderr.toString('utf8')); } catch { invalid = true; } }
        // Raw diagnostics stay in this unique private run; summaries contain only metadata.
        try { await writeFile(stderrFile, rawStderr, { flag: 'wx' }); } catch { invalid = true; }
        Object.assign(command, { invalid, timedOut, spawnFailed, overflow, stdoutBytes, stderrBytes, stderrFile: `<fixture>/cli-stderr-${number}.bin` });
        accept({ code, frames, value: frames.at(-1) ?? errorValue, invalid, timedOut });
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ argv, input, cleanup: cleanupFile }));
    const result = { child, frames, done, record };
    launches.push(result);
    return result;
  };
  const cli = async (args, input) => {
    const result = await launch(args, input).done;
    assert.ok(!result.invalid && !result.timedOut, `${args[0]} returns bounded JSON`);
    return result;
  };
  const fixture = spawn('python', ['-B', join(root, 'test/helpers/native_fixture.py'), run, process.env.DSH_ROOT], { env: { ...process.env, DSH_NODE_EXECUTABLE: hostNode, E2E_MOCK_MAX_REQUESTS: '7' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const fixtureLines = createInterface({ input: fixture.stdout });
  let fixtureError = false, fixtureStderrBytes = 0, ready;
  fixture.on('error', () => { fixtureError = true; });
  fixture.stderr.on('data', chunk => { fixtureStderrBytes += chunk.length; if (fixtureStderrBytes > 1024 * 1024) { fixtureError = true; fixture.kill(); } });
  fixtureLines.on('line', line => {
    try { const value = JSON.parse(line); if (value.ready) ready = value; if (value.fixtureError) fixtureError = true; }
    catch { fixtureError = true; }
  });
  const fixtureClosed = new Promise(done => fixture.once('close', done));
  try {
    await until(() => { assert.ok(!fixtureError && fixture.exitCode === null, 'isolated fixture remains healthy'); return ready; }, 'fixture readiness', 60_000);
    check('Host runtime reports the explicitly selected executable', ready.hostRuntime?.executableSha256 === hash(await readFile(hostNode)) && typeof ready.hostRuntime?.version === 'string');
    const attached = await cli(['attach', '--name', 'native', '--url', `http://127.0.0.1:${ready.port}`, '--token-stdin'], ready.token + '\n');
    check('isolated CLI ledger authenticates the native fixture', attached.code === 0);
    const task = 'foreign-stop';
    const started = await cli(['start', '--connection', 'native', '--cwd', join(run, 'workspace'), '--task', task, '--title', 'LOCAL_MOCK foreign stop']);
    check('CLI creates explicitly titled exclusive session', started.code === 0 && started.value.scope === 'exclusive');
    const sessionId = started.value.sessionId;
    const external = new NativeClient(await NativeClient.connect({ url: `http://127.0.0.1:${ready.port}`, token: ready.token }));
    const holdId = randomUUID(), buildId = randomUUID();
    const mockState = async () => (await fetch(`http://127.0.0.1:${ready.mockPort}/state`, { signal: AbortSignal.timeout(5000) })).json();
    const queue = async () => {
      const value = await external.rpc('session/projections', { request: { sessionId } });
      const inbox = value?.values?.inbox;
      assert.ok(Array.isArray(inbox?.['next-turn']) && Array.isArray(inbox?.['next-step']), 'native queue projection is understood');
      return [...inbox['next-turn'], ...inbox['next-step']];
    };
    const prompt = async (requestId, phase) => external.rpc('session/prompt', { request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: `[E2E:${phase}] Perform the isolated native fixture action.` }] } });
    await prompt(holdId, 'HOLD');
    await until(async () => (await mockState()).holdStarted, 'external HOLD stream begins');
    check('HOLD is the only model request before queue setup', (await mockState()).count === 1);
    await prompt(buildId, 'BUILD');
    const ownedPrompt = join(run, 'owned-other.txt');
    await writeFile(ownedPrompt, '[E2E:OTHER] Owned queued work must be removed by stop.');
    const sent = await cli(['send', '--task', task, '--text-file', ownedPrompt, '--allow-model', '--wait', '0']);
    const ownedId = sent.value.requests?.at(-1)?.requestId;
    check('separate CLI queues its own request', sent.code === 0 && typeof ownedId === 'string');
    const beforeQueue = await queue();
    check('real native queue contains both foreign BUILD and owned OTHER', beforeQueue.some(item => item.source?.rpcId === buildId) && beforeQueue.some(item => item.source?.rpcId === ownedId));
    const stopped = await cli(['stop', '--task', task]);
    check('stop remains pending and never requests native cancellation', stopped.code === 0 && stopped.value.blocked === true && stopped.value.state === 'STOP_PENDING' && stopped.value.stopAttempt?.cancelRequested === false);
    const ledger = JSON.parse(await readFile(join(state, 'state.json'), 'utf8'));
    check('stop intent is persisted and foreign sharing recorded', ledger.tasks[task].stopRequested === true && ledger.tasks[task].sharedStopRequired === true);
    const afterQueue = await queue();
    check('stop preserves foreign queue and removes only owned queue', afterQueue.some(item => item.source?.rpcId === buildId) && !afterQueue.some(item => item.source?.rpcId === ownedId));
    await sleep(500);
    const held = await mockState();
    check('foreign held model stream survives stop heartbeats', held.count === 1 && held.disconnected === false);
    for (const command of ['resume', 'status']) {
      const observed = await cli([command, '--task', task]);
      check(`${command} preserves pending stop without dispatch`, observed.code === 0 && observed.value.state === 'STOP_PENDING' && (await mockState()).count === 1);
    }
    const rejected = await cli(['send', '--task', task, '--text-file', ownedPrompt, '--allow-model', '--wait', '0']);
    check('stop rejects new owned send without model dispatch', rejected.code === 3 && rejected.value.error === 'TASK_STOPPED' && (await mockState()).count === 1);
    const released = await fetch(`http://127.0.0.1:${ready.mockPort}/release`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    check('mock control endpoint releases HOLD without model dispatch', released.ok);
    const completed = await until(async () => {
      const history = await readHistory(external, sessionId);
      const view = projectSession(history.events, { requestIds: [holdId, buildId] });
      return view.requests[holdId].state === 'COMPLETED' && view.requests[buildId].state === 'COMPLETED' ? view : null;
    }, 'both external native request IDs complete', 30_000);
    check('external completion includes actual native BUILD write', completed.requests[buildId].tools.some(tool => tool.name === 'write') && await readFile(join(run, 'workspace/result.txt'), 'utf8') === 'version=1\n');
    const other = await cli(['start', '--connection', 'native', '--cwd', join(run, 'workspace'), '--task', 'other', '--title', 'LOCAL_MOCK unaffected session']);
    check('another exclusive session is independently created', other.code === 0 && other.value.sessionId !== sessionId);
    const otherSent = await cli(['send', '--task', 'other', '--text-file', ownedPrompt, '--allow-model', '--wait', '15']);
    check('another CLI session completes normally on the same Host', otherSent.code === 0 && otherSent.value.requests?.at(-1)?.state === 'COMPLETED');
    const final = await mockState();
    check('only HOLD, two BUILD steps and other session OTHER reached mock', final.count === 4 && final.disconnected === false && final.records.map(item => item.phase).join(',') === 'HOLD,BUILD,BUILD,OTHER');
    report.sessions = [{ task, sessionId, holdId, buildId, ownedId }, { task: 'other', sessionId: other.value.sessionId }];
    report.status = 'PASS_LOCAL_MOCK_FOREIGN_STOP';
  } catch (error) {
    // Never copy raw native stderr, credentials, prompt text or reply bodies into receipts.
    report.failure = error instanceof assert.AssertionError ? error.message : 'Native foreign stop fixture failed; private evidence retained';
    throw error;
  } finally {
    for (const child of children) child.kill();
    await Promise.race([Promise.all(launches.map(item => item.done)), sleep(5000)]);
    fixture.stdin.end();
    const clean = await Promise.race([fixtureClosed.then(() => true), sleep(15_000).then(() => false)]);
    if (!clean) { fixture.kill(); await Promise.race([fixtureClosed, sleep(5000)]); }
    fixtureLines.close();
    try { Object.assign(report, JSON.parse(await readFile(join(run, 'fixture-result.json'), 'utf8'))); } catch { report.fixtureIncomplete = true; }
    report.nativeFileHashes = { before, after: await hashes() };
    report.selectedNativeFilesUnchanged = JSON.stringify(report.nativeFileHashes.before) === JSON.stringify(report.nativeFileHashes.after);
    report.cliProcesses = [];
    for (const launched of launches) {
      let cleanup, runtime;
      try { cleanup = JSON.parse(await readFile(launched.record.cleanupFile, 'utf8')); } catch { cleanup = { missingCleanupReceipt: true }; }
      try { runtime = JSON.parse(await readFile(launched.record.runtimeFile, 'utf8')); } catch { runtime = null; }
      report.cliProcesses.push({ ...cleanup, runtime, code: launched.child.exitCode, stillAlive: launched.child.exitCode === null });
    }
    const cliHash = hash(await readFile(node));
    const cliClean = report.cliProcesses.every(child => child.jobActiveAfterCleanup === 0 && !child.stillAlive && child.runtime?.executableSha256 === cliHash && child.runtime.version === process.version && child.runtime.undici === (process.versions.undici ?? null));
    const provider = report.provider;
    if (!cliClean || !clean || report.fixtureIncomplete || report.jobActiveAfterCleanup !== 0 || !report.hostPortReleased || !report.mockPortReleased || report.hostExecutableUnchanged !== true || report.egressDenied || report.logOverflow || !report.selectedNativeFilesUnchanged || provider?.errors?.length || provider?.count !== 4 || provider?.records?.some(record => !['HOLD', 'BUILD', 'OTHER'].includes(record.phase))) report.status = 'FAIL_BOUNDARY_OR_CLEANUP';
    report.wallSeconds = (Date.now() - startedAt) / 1000;
    report.fixtureStderrBytes = fixtureStderrBytes;
    await writeFile(join(run, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    assert.equal(report.status, 'PASS_LOCAL_MOCK_FOREIGN_STOP', report.failure ?? 'Native foreign stop cleanup or boundary check failed');
  }
});
