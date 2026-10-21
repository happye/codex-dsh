import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const root = resolve(import.meta.dirname, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const enabled = process.platform === 'win32' && process.env.DSH_ROOT && process.env.DSH_APPROVAL_SOURCE_FIXTURE === '1';

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

test('native approval listener keeps a live lease for separate CLI decisions', {
  skip: enabled ? false : 'Requires Windows, DSH_ROOT and DSH_APPROVAL_SOURCE_FIXTURE=1; skip is not acceptance',
  timeout: 180_000,
}, async () => {
  const cache = join(root, '.cache/approval-listen');
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
    kind: 'LOCAL_MOCK', executionMode: 'SOURCE_FIXTURE', status: 'FAIL',
    owner: 'approval_listener_native', scope: 'C11 live approval lease, two independent native sessions',
    command: ['DSH_ROOT=<installed-native-root>', 'DSH_APPROVAL_SOURCE_FIXTURE=1', 'node', '--test', 'test/native/approval-listen.test.mjs'],
    expectedMockRequests: 4, maxMockRequests: 6, checks: [], commands: [], sessions: [],
    limits: ['Source fixture compiles installed user-approval and sandbox source; installed built bypass is unchanged', 'No real provider requests or model quality claim', 'COMPLETED is turn completion; file effects are checked separately', 'Author execution evidence requires independent acceptance'],
  };
  const startedAt = Date.now();
  const selected = ['apps/cli/lib/bin.js', 'packages/interaction/user-approval/lib/index.js', 'packages/sandbox/sandbox/lib/index.js', 'packages/api/session-controller/lib/index.js', 'packages/core/agent-loop/lib/index.js', 'packages/llm/llm-deepseek/lib/index.js'];
  const hashes = async () => Object.fromEntries(await Promise.all(selected.map(async file => [file, hash(await readFile(join(process.env.DSH_ROOT, file)))])));
  const before = await hashes();
  report.fingerprints = await Promise.all(['src/controller.mjs', 'src/cli.mjs', 'src/view.mjs', 'test/native/approval-listen.test.mjs', 'test/helpers/native_fixture.py', 'test/helpers/runtime-record.cjs', 'test/helpers/approval-source-fixture.cjs', 'test/helpers/windows_job.py'].map(async file => ({ file, sha256: hash(await readFile(join(root, file))) })));
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
  const fixture = spawn('python', ['-B', join(root, 'test/helpers/native_fixture.py'), run, process.env.DSH_ROOT], { env: { ...process.env, DSH_NODE_EXECUTABLE: hostNode, E2E_MOCK_MAX_REQUESTS: '6' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
    for (const phase of ['REJECT', 'ALLOW']) {
      const task = `listen-${phase.toLowerCase()}`;
      const started = await cli(['start', '--connection', 'native', '--cwd', join(run, 'workspace'), '--task', task, '--title', `LOCAL_MOCK approval listen ${phase}`]);
      check(`${phase}: new exclusive native session has an explicit title`, started.code === 0 && started.value.scope === 'exclusive');
      const listener = launch(['listen', '--task', task, '--wait', '20']);
      await until(() => listener.frames.find(frame => frame.leaseOpen === true), `${phase} initial live lease`);
      check(`${phase}: initial JSONL lease remains alive before send`, listener.child.exitCode === null && !listener.child.killed);
      const prompt = join(run, `${phase.toLowerCase()}.txt`);
      await writeFile(prompt, `[E2E:${phase}] Perform the owned native outbox approval action.`);
      const sent = await cli(['send', '--task', task, '--text-file', prompt, '--allow-model', '--wait', '0']);
      check(`${phase}: separate send submits without taking the listener lease`, sent.code === 0 && sent.value.requests?.length === 1);
      const pending = await until(() => {
        assert.ok(listener.child.exitCode === null && !listener.child.killed, `${phase} listener must remain alive for approval`);
        return listener.frames.flatMap(frame => frame.leaseOpen ? frame.approvals ?? [] : []).find(approval => approval.state === 'PENDING');
      }, `${phase} pending native approval`);
      const current = await cli(['approvals', '--task', task]);
      check(`${phase}: pending approval is valid while JSONL listener stays alive`, current.code === 0 && current.value.approvals?.some(approval => approval.eventId === pending.eventId && approval.state === 'PENDING') && listener.child.exitCode === null);
      const decision = phase === 'ALLOW' ? 'allowed-once' : 'rejected';
      const approved = await cli(['approve', '--task', task, '--approval', pending.eventId, '--decision', decision]);
      check(`${phase}: another CLI process queues ${decision}`, approved.code === 0 && approved.value.state === 'DECISION_QUEUED');
      const settled = await listener.done;
      check(`${phase}: listener reports completed native turn before clean exit`, settled.code === 0 && !settled.invalid && !settled.timedOut && settled.frames.some(frame => frame.leaseOpen === true && frame.requests?.some(request => request.state === 'COMPLETED')));
      check(`${phase}: final JSONL explicitly closes its approval lease`, settled.frames.at(-1)?.leaseOpen === false);
      const stale = await cli(['approve', '--task', task, '--approval', pending.eventId, '--decision', decision]);
      check(`${phase}: closed approval cannot be reused`, stale.code === 3 && stale.value.error === 'APPROVAL_EXPIRED');
      const ledger = JSON.parse(await readFile(join(state, 'state.json'), 'utf8'));
      const stored = ledger.tasks[task];
      check(`${phase}: listener delivered the queued result through native broker`, stored.approvals[pending.eventId]?.state === 'RESULT_SENT_UNCONFIRMED');
      check(`${phase}: completion is associated with native write tool and turn`, stored.requests[0].state === 'COMPLETED' && stored.requests[0].turn != null && stored.requests[0].tools?.some(tool => tool.name === 'write'));
      report.sessions.push({ task, sessionId: started.value.sessionId, requestId: stored.requests[0].requestId, turn: stored.requests[0].turn, decision, approvalState: stored.approvals[pending.eventId].state, frames: settled.frames.map(frame => ({ leaseOpen: frame.leaseOpen, state: frame.state, cursor: frame.cursor, generation: frame.generation, approvalStates: frame.approvals?.map(approval => approval.state) ?? [] })) });
    }
    check('approval actions use distinct native sessions', report.sessions[0].sessionId !== report.sessions[1].sessionId);
    const outbox = await readdir(join(run, 'outbox'));
    check('rejected native write produced no artifact', !outbox.includes('reject.txt'));
    check('allowed native write has exactly version 1 content', await readFile(join(run, 'outbox/allow.txt'), 'utf8') === 'version=1\n');
    report.status = 'PASS_LOCAL_MOCK_APPROVAL_LISTEN';
  } catch (error) {
    // Never copy raw native stderr, credentials, prompt text or reply bodies into receipts.
    report.failure = error instanceof assert.AssertionError ? error.message : 'Native approval listener fixture failed; private evidence retained';
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
    if (!cliClean || !clean || report.fixtureIncomplete || report.jobActiveAfterCleanup !== 0 || !report.hostPortReleased || !report.mockPortReleased || report.hostExecutableUnchanged !== true || report.egressDenied || report.logOverflow || !report.selectedNativeFilesUnchanged || provider?.errors?.length || !(provider?.count >= 4 && provider.count <= 6) || provider?.records?.some(record => !['REJECT', 'ALLOW', 'TITLE'].includes(record.phase))) report.status = 'FAIL_BOUNDARY_OR_CLEANUP';
    report.wallSeconds = (Date.now() - startedAt) / 1000;
    report.fixtureStderrBytes = fixtureStderrBytes;
    report.sourceFixtureFiles = [];
    try {
      const source = join(run, 'approval-source-fixture');
      for (const file of await readdir(source, { recursive: true })) if (/\.(ts|mjs)$/.test(file)) report.sourceFixtureFiles.push({ path: file.replaceAll('\\', '/'), sha256: hash(await readFile(join(source, file))) });
    } catch { report.sourceFixtureMissing = true; report.status = 'FAIL_BOUNDARY_OR_CLEANUP'; }
    await writeFile(join(run, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    assert.equal(report.status, 'PASS_LOCAL_MOCK_APPROVAL_LISTEN', report.failure ?? 'Native approval listener cleanup or boundary check failed');
  }
});
