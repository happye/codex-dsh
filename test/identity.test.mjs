import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { directoryIdentity, sameDirectory, verifySessionDirectory } from '../src/identity.mjs';

test('filesystem identity accepts realpath aliases and rejects distinct same-name directories', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dsh-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'a', 'project'), second = path.join(root, 'b', 'project');
  await fs.mkdir(first, { recursive: true }); await fs.mkdir(second, { recursive: true });
  const alias = path.join(root, 'alias');
  await fs.symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const expected = await directoryIdentity(first);
  assert.equal(sameDirectory(expected, await directoryIdentity(alias)), true);
  assert.equal(sameDirectory(expected, await directoryIdentity(second)), false);
  await verifySessionDirectory({ sessionId: 'session', nativeCwd: first, cwdIdentity: expected }, { id: 'session', cwd: alias });
  if (process.platform === 'win32') {
    assert.equal(sameDirectory(expected, await directoryIdentity(first.toUpperCase().replaceAll('\\', '/'))), true);
  }
  await assert.rejects(verifySessionDirectory({ sessionId: 'session', cwd: first }, { id: 'session', cwd: second }), { code: 'SESSION_CWD_MISMATCH' });
});

test('unknown, missing, non-directory and replaced cwd fail closed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dsh-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'project'); await fs.mkdir(directory);
  const expected = await directoryIdentity(directory);
  const task = { sessionId: 'session', cwd: directory, cwdIdentity: expected };
  await assert.rejects(verifySessionDirectory(task, { id: 'session' }), { code: 'SESSION_CWD_UNKNOWN' });
  await assert.rejects(verifySessionDirectory(task, { id: 'other', cwd: directory }), { code: 'SESSION_ID_MISMATCH' });
  await fs.rename(directory, path.join(root, 'original')); await fs.mkdir(directory);
  await assert.rejects(verifySessionDirectory(task, { id: 'session', cwd: directory }), { code: 'SESSION_CWD_MISMATCH' });
  await assert.rejects(directoryIdentity(path.join(root, 'missing')), { code: 'CWD_UNRESOLVABLE' });
  const file = path.join(root, 'file'); await fs.writeFile(file, 'fixture');
  await assert.rejects(directoryIdentity(file), { code: 'CWD_UNRESOLVABLE' });
  await assert.rejects(directoryIdentity('relative'), { code: 'ABSOLUTE_CWD_REQUIRED' });
});
