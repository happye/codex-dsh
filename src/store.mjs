import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const SCHEMA = 'codex-dsh-private-v1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function fault(code, message = code) { return Object.assign(new Error(message), { code }); }
export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw fault('INVALID_ID');
  return value;
}
async function noLinks(target, allowMissing = false) {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink > 1)) throw fault('UNSAFE_STATE_PATH');
    } catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
  }
}
export class StateStore {
  constructor(directory) { this.directory = path.resolve(directory); }
  static async open(directory = path.join(process.cwd(), '.codex-dsh')) {
    const store = new StateStore(directory);
    await noLinks(store.directory, true);
    let created = false;
    try { await fs.mkdir(store.directory, { mode: 0o700 }); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (created) {
      if (process.platform === 'win32') {
        try {
          const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-[0-9-]+/)?.[0];
          if (!sid) throw fault('STATE_ACL_FAILED');
          execFileSync('icacls.exe', [store.directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true });
        } catch { throw fault('STATE_ACL_FAILED'); }
      }
      await store.writeFile('.gitignore', '*\n');
      await store.writeFile('marker.json', JSON.stringify({ schema: SCHEMA }));
    }
    await noLinks(store.directory);
    let marker;
    try { await noLinks(path.join(store.directory, 'marker.json')); marker = JSON.parse(await fs.readFile(path.join(store.directory, 'marker.json'), 'utf8')); }
    catch { throw fault('STATE_DIRECTORY_NOT_OWNED', 'Existing state directory requires the controller schema marker'); }
    if (marker.schema !== SCHEMA) throw fault('STATE_DIRECTORY_NOT_OWNED');
    if (!created) await store.writeFile('.gitignore', '*\n');
    return store;
  }
  file(name) {
    if (name !== '.gitignore' && (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || name.includes('..'))) throw fault('UNSAFE_STATE_PATH');
    return path.join(this.directory, name);
  }
  async readFile(name) { const target = this.file(name); await noLinks(target); return fs.readFile(target, 'utf8'); }
  async writeFile(name, content) {
    const target = this.file(name); await noLinks(this.directory); await noLinks(target, true);
    const temp = this.file(`tmp-${randomUUID()}`);
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    try { await noLinks(target, true); await fs.rename(temp, target); }
    finally { await fs.rm(temp, { force: true }); }
    return target;
  }
  async withLock(name, callback, { timeoutMs = 5000 } = {}) {
    await noLinks(this.directory);
    const lock = this.file(name), deadline = Date.now() + timeoutMs;
    let handle;
    while (!handle) {
      try { handle = await fs.open(lock, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw fault('STATE_LOCKED', `State is locked; verify the previous controller exited before removing ${name}`);
        await sleep(25);
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return await callback();
    } finally { await handle.close(); await fs.unlink(lock); }
  }
  async transaction(callback, options) {
    return this.withLock('state.lock', async () => {
      let state;
      try { state = JSON.parse(await this.readFile('state.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; state = { schema: SCHEMA, connections: {}, tasks: {} }; }
      if (state.schema !== SCHEMA) throw fault('INVALID_STATE_SCHEMA');
      const result = await callback(state);
      await this.writeFile('state.json', JSON.stringify(state));
      return result;
    }, options);
  }
  async task(id) { identifier(id); return this.transaction(state => { if (!state.tasks[id]) throw fault('TASK_NOT_FOUND'); return structuredClone(state.tasks[id]); }); }
}
