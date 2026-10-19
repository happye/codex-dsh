import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { runCli } from '../src/cli.mjs';
import { personalPaths, toolRoot } from '../src/setup.mjs';
import { StateStore } from '../src/store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dsh-setup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'home'), cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  const paths = personalPaths(codexHome);
  async function cli(args, overrides = {}) {
    let output = '', error = '';
    const code = await runCli(args, { codexHome, cwd, stdout: { write: text => { output += text; } }, stderr: { write: text => { error += text; } }, ...overrides });
    return { code, output, error, value: output ? JSON.parse(output) : undefined };
  }
  return { root, codexHome, cwd, paths, cli };
}
test('setup installs identical portable Skill and agent metadata from any cwd, without authentication', async t => {
  const f = await fixture(t);
  const result = await f.cli(['setup', '--url', 'http://localhost:1234/path']);
  assert.equal(result.code, 0, result.error);
  assert.equal(result.value.authenticationRequired, true);
  assert.equal(result.value.url, 'http://localhost:1234');
  assert.equal(result.value.stateDir, path.join(f.codexHome, 'codex-dsh-state'));
  for (const name of ['SKILL.md', path.join('agents', 'openai.yaml')]) assert.deepEqual(
    await fs.readFile(path.join(f.paths.skillDir, name)), await fs.readFile(path.join(toolRoot, '.agents/skills/codex-dsh-collab', name)));
  assert.deepEqual(JSON.parse(await fs.readFile(f.paths.profilePath, 'utf8')), {
    schema: 1, toolRoot, stateDir: result.value.stateDir, connection: 'native', url: 'http://localhost:1234',
  });
  await assert.rejects(fs.stat(path.join(f.cwd, '.codex-dsh')), { code: 'ENOENT' });
});
test('token-file authenticates only against mock Host; reuse preserves tasks, cookie and custom files', async t => {
  const f = await fixture(t), token = 'private-token-test', cookie = 'private-cookie-test';
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    assert.equal(new URL(req.url, 'http://localhost').searchParams.get('token'), token);
    res.writeHead(200, { 'set-cookie': `session=${cookie}; HttpOnly` }); res.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const tokenFile = path.join(f.root, 'token.txt'); await fs.writeFile(tokenFile, token);
  const first = await f.cli(['setup', '--url', url, '--name', 'my-host', '--token-file', tokenFile]);
  assert.equal(first.code, 0, first.error); assert.equal(first.value.authenticationRequired, false);
  const store = await StateStore.open(first.value.stateDir);
  await store.transaction(state => { state.tasks.work = { id: 'work', connection: 'my-host', cwd: f.cwd, sessionId: 'native-session', prompt: 'private-prompt', requests: [] }; });
  await fs.writeFile(path.join(f.paths.skillDir, 'custom.txt'), 'keep');
  const second = await f.cli(['setup']);
  assert.equal(second.code, 0, second.error); assert.equal(second.value.authenticationRequired, false);
  assert.equal(second.value.connection, 'my-host'); assert.equal(second.value.url, url);
  assert.equal(hits, 1);
  assert.equal(await fs.readFile(path.join(f.paths.skillDir, 'custom.txt'), 'utf8'), 'keep');
  const otherCwd = path.join(f.root, 'different-project'); await fs.mkdir(otherCwd);
  const listed = await f.cli(['connections'], { cwd: otherCwd });
  assert.equal(listed.code, 0, listed.error);
  assert.deepEqual(listed.value, { connections: [{ name: 'my-host', baseUrl: url, tasks: [{ id: 'work', cwd: f.cwd, sessionId: 'native-session' }] }] });
  const shared = `${first.output}${second.output}${listed.output}${await fs.readFile(f.paths.profilePath, 'utf8')}`;
  for (const secret of [token, cookie, 'private-prompt']) assert.ok(!shared.includes(secret));
  const state = await store.transaction(state => structuredClone(state));
  assert.equal(state.connections['my-host'].cookie, `session=${cookie}`);
  assert.equal(state.tasks.work.sessionId, 'native-session');
});
test('real CLI process honors CODEX_HOME across project changes and explicit state override', async t => {
  const f = await fixture(t);
  const first = await f.cli(['setup', '--url', 'http://localhost:1234']);
  const store = await StateStore.open(first.value.stateDir);
  await store.transaction(state => { state.connections.native = { baseUrl: 'http://localhost:1234', cookie: 'secret' }; });
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(toolRoot, 'bin/codex-dsh.mjs'), 'connections'], { cwd: f.cwd, env: { ...process.env, CODEX_HOME: f.codexHome }, windowsHide: true });
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
  assert.equal(JSON.parse(output).connections[0].name, 'native');
  const override = await f.cli(['connections', '--state-dir', path.join(f.root, 'separate')]);
  assert.deepEqual(override.value, { connections: [] });
});
test('existing connection origins cannot be silently repointed; explicit new alias preserves old tasks', async t => {
  const f = await fixture(t);
  const first = await f.cli(['setup', '--url', 'http://localhost:1234']);
  const store = await StateStore.open(first.value.stateDir);
  await store.transaction(state => { state.connections.native = { baseUrl: first.value.url, cookie: 'keep' }; state.tasks.old = { id: 'old', connection: 'native' }; });
  const bad = await f.cli(['setup', '--url', 'http://localhost:5678']);
  assert.equal(bad.code, 3); assert.match(bad.error, /CONNECTION_IDENTITY_CONFLICT/);
  assert.equal(JSON.parse(await fs.readFile(f.paths.profilePath, 'utf8')).url, first.value.url);
  const changed = await f.cli(['setup', '--url', 'http://localhost:5678', '--name', 'new-host']);
  assert.equal(changed.code, 0, changed.error); assert.equal(changed.value.authenticationRequired, true);
  assert.equal((await store.task('old')).connection, 'native');
});
test('malformed configured profile and missing configured ledger fail without cwd fallback', async t => {
  const f = await fixture(t);
  const first = await f.cli(['setup', '--url', 'http://localhost:1234']);
  const valid = await fs.readFile(f.paths.profilePath, 'utf8');
  for (const content of ['{', '{"schema":2}', JSON.stringify({ ...JSON.parse(valid), token: 'do-not-echo' })]) {
    await fs.writeFile(f.paths.profilePath, content);
    const result = await f.cli(['connections']); assert.equal(result.code, 2); assert.match(result.error, /INVALID_LOCAL_PROFILE/); assert.ok(!result.error.includes('do-not-echo'));
  }
  await fs.writeFile(f.paths.profilePath, JSON.stringify({ ...JSON.parse(valid), stateDir: path.join(f.root, 'missing') }));
  const result = await f.cli(['connections']); assert.equal(result.code, 3); assert.match(result.error, /STATE_PROFILE_MISSING/);
  await assert.rejects(fs.stat(path.join(f.root, 'missing')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.cwd, '.codex-dsh')), { code: 'ENOENT' });
  assert.ok(first.value.skillInstalled);
});
test('setup rejects unrelated directories, linked files and malformed prior installation', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.paths.skillDir, { recursive: true }); await fs.writeFile(path.join(f.paths.skillDir, 'custom.txt'), 'keep');
  const refused = await f.cli(['setup', '--url', 'http://localhost:1234']);
  assert.equal(refused.code, 3); assert.match(refused.error, /UNSAFE_SKILL_DIRECTORY/);
  assert.deepEqual(await fs.readdir(f.paths.skillDir), ['custom.txt']);
  await fs.unlink(path.join(f.paths.skillDir, 'custom.txt'));
  const first = await f.cli(['setup', '--url', 'http://localhost:1234']); assert.equal(first.code, 0);
  const outside = path.join(f.root, 'outside'); await fs.writeFile(outside, 'keep-outside');
  const skill = path.join(f.paths.skillDir, 'SKILL.md'); await fs.unlink(skill); await fs.link(outside, skill);
  const linked = await f.cli(['setup']); assert.equal(linked.code, 3);
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep-outside');
});
test('URL credentials and mixed token options are rejected before creating settings or network requests', async t => {
  const f = await fixture(t);
  for (const url of ['http://localhost:1234/?token=do-not-echo', 'http://user:do-not-echo@localhost:1234', 'http://localhost:1234/#do-not-echo']) {
    for (const command of ['setup', 'attach']) {
      const args = [command, '--url', url, ...(command === 'attach' ? ['--name', 'native'] : [])];
      const result = await f.cli(args); assert.equal(result.code, 2); assert.ok(!result.error.includes('do-not-echo'));
    }
  }
  const mixed = await f.cli(['setup', '--url', 'http://localhost:1234', '--token-stdin', '--token-file', 'unused']); assert.equal(mixed.code, 2);
  await assert.rejects(fs.stat(f.paths.profilePath), { code: 'ENOENT' });
});
test('setup upgrades a previously installed repository Skill without local settings, preserving custom files', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.paths.skillDir, { recursive: true });
  await fs.copyFile(path.join(toolRoot, '.agents/skills/codex-dsh-collab/SKILL.md'), path.join(f.paths.skillDir, 'SKILL.md'));
  await fs.writeFile(path.join(f.paths.skillDir, 'custom.txt'), 'keep');
  const result = await f.cli(['setup', '--url', 'http://localhost:1234']);
  assert.equal(result.code, 0, result.error);
  assert.equal(await fs.readFile(path.join(f.paths.skillDir, 'custom.txt'), 'utf8'), 'keep');
});
test('authentication failure prints only a code and does not publish credentials', async t => {
  const f = await fixture(t), tokenFile = path.join(f.root, 'token'); await fs.writeFile(tokenFile, 'private-rejected-token');
  const server = http.createServer((req, res) => { res.writeHead(403); res.end('private-rejected-token'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await f.cli(['setup', '--url', `http://127.0.0.1:${server.address().port}`, '--token-file', tokenFile]);
  assert.equal(result.code, 4); assert.equal(result.output, ''); assert.equal(result.error, '{"error":"AUTH_REJECTED"}\n');
  await assert.rejects(fs.stat(f.paths.profilePath), { code: 'ENOENT' });
});
