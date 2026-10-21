import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCase, relativeFile } from '../src/execution.mjs';

test('bounded executor closes stdin, captures rc and distinguishes timeout', async () => {
  const plan = { executable: process.execPath, argv: ['-e', 'process.stdin.on("end",()=>{console.log("EOF");process.exitCode=7});process.stdin.resume()'], runner: 'command', env: {}, timeoutMs: 3000 };
  const result = await executeCase(plan, process.cwd());
  assert.equal(result.stdout.toString().trim(), 'EOF'); assert.equal(result.exitCode, 7); assert.equal(result.termination, 'exited');
  const timeout = await executeCase({ ...plan, argv: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 50 }, process.cwd());
  assert.equal(timeout.termination, 'timeout');
});

test('relative allowlist rejects traversal, absolute and Git internals', () => {
  for (const value of ['../x', '/tmp/x', 'C:/x', 'a/../b', 'a\\b', '.git/config', '.GIT/config', 'x:stream', 'x.', 'x ', 'CON.txt']) assert.throws(() => relativeFile(value));
  assert.equal(relativeFile('src/valid.mjs'), 'src/valid.mjs');
});

test('controller abort differs from a test failure and only targets the owned child', async () => {
  const controller = new AbortController();
  const pending = executeCase({ executable: process.execPath, argv: ['-e', 'setInterval(()=>{},1000)'], runner: 'command', env: {}, timeoutMs: 3000 }, process.cwd(), undefined, { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).termination, 'controller-aborted');
});

test('argv is literal and does not invoke a shell', async () => {
  const literal = 'a & echo injected $(not-a-command)';
  const result = await executeCase({ executable: process.execPath, argv: ['-e', 'console.log(process.argv[1])', literal], runner: 'command', env: {}, timeoutMs: 3000 }, process.cwd());
  assert.equal(result.stdout.toString().trim(), literal); assert.equal(result.exitCode, 0);
});
