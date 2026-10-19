import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dsh-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: await StateStore.open(path.join(root, 'private')) };
}
test('existing arbitrary directory is rejected without changing it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dsh-existing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'keep'), 'unchanged');
  await assert.rejects(StateStore.open(root), { code: 'STATE_DIRECTORY_NOT_OWNED' });
  assert.deepEqual(await fs.readdir(root), ['keep']);
});
test('concurrent transactions retain every update and credentials stay only in private JSON', async t => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, () => store.transaction(state => { state.count = (state.count ?? 0) + 1; })));
  assert.equal(await store.transaction(state => state.count), 12);
  await store.transaction(state => { state.connections.secret = { cookie: 'sensitive-test-cookie' }; });
  assert.match(await store.readFile('state.json'), /sensitive-test-cookie/);
  assert.deepEqual((await fs.readdir(store.directory)).sort(), ['.gitignore', 'marker.json', 'state.json']);
  assert.equal(await store.readFile('.gitignore'), '*\n');
  if (process.platform !== 'win32') assert.equal((await fs.stat(store.file('state.json'))).mode & 0o777, 0o600);
});
test('orphan lock fails closed rather than guessing a prior process died', async t => {
  const { store } = await fixture(t);
  await fs.writeFile(store.file('state.lock'), '{"pid":999999999}');
  await assert.rejects(store.transaction(state => { state.lost = true; }, { timeoutMs: 40 }), { code: 'STATE_LOCKED' });
  await assert.rejects(fs.readFile(store.file('state.json')), { code: 'ENOENT' });
});
test('path traversal and hardlinked state are rejected', async t => {
  const { root, store } = await fixture(t);
  await assert.rejects(store.writeFile('../escape', 'x'), { code: 'UNSAFE_STATE_PATH' });
  await fs.writeFile(path.join(root, 'outside'), 'do-not-replace');
  await fs.link(path.join(root, 'outside'), store.file('state.json'));
  await assert.rejects(store.transaction(() => {}), { code: 'UNSAFE_STATE_PATH' });
  assert.equal(await fs.readFile(path.join(root, 'outside'), 'utf8'), 'do-not-replace');
});
