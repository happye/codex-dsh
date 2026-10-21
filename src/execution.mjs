import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fault } from './store.mjs';

const exec = promisify(execFile);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const jsonDigest = value => digest(JSON.stringify(value));
export function fileIdentity(bytes, kind = 'raw') {
  if (!['raw', 'text'].includes(kind)) throw fault('INVALID_FILE_KIND');
  const content = Buffer.from(bytes), sha256 = digest(content);
  if (kind === 'raw') return { kind, sha256, contentSha256: sha256 };
  const text = content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(content)) throw fault('INVALID_TEXT_ENCODING');
  return { kind, sha256, contentSha256: digest(text.replaceAll('\r\n', '\n')) };
}
export function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.includes(':') || path.isAbsolute(value) || value.split('/').some(x => !x || x === '.' || x === '..' || /[. ]$/.test(x) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x)) || value.split('/')[0].toLowerCase() === '.git') throw fault('INVALID_CONTRACT_PATH');
  return value;
}
export async function safeFile(root, file, missing = false) {
  relativeFile(file);
  let current = root;
  for (const segment of file.split('/')) {
    if (process.platform === 'win32') {
      try { const actual = (await fs.readdir(current)).find(x => x.toLowerCase() === segment.toLowerCase()); if (actual && actual !== segment) throw fault('UNSAFE_EXECUTION_PATH'); }
      catch (e) { if (missing && e.code === 'ENOENT') return path.join(current, segment); throw e; }
    }
    current = path.join(current, segment);
    try { const st = await fs.lstat(current); if (st.isSymbolicLink() || (!st.isDirectory() && st.nlink > 1)) throw fault('UNSAFE_EXECUTION_PATH'); }
    catch (e) { if (missing && e.code === 'ENOENT') return current; throw e; }
  }
  return current;
}
export async function git(root, args) {
  return (await exec('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true })).stdout;
}
export async function snapshot(root, extraFiles = [], textFiles = []) {
  let ancestor = path.resolve(root);
  while (true) {
    if ((await fs.lstat(ancestor)).isSymbolicLink()) throw fault('UNSAFE_EXECUTION_PATH');
    const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  const real = await fs.realpath(root);
  if (path.resolve(root) !== path.resolve(real)) throw fault('UNSAFE_EXECUTION_PATH');
  const gitRoot = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  if (path.resolve(await fs.realpath(gitRoot)) !== path.resolve(real)) throw fault('EXECUTION_ROOT_NOT_GIT_ROOT');
  const names = [...new Set([...(await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean), ...extraFiles])].sort();
  const files = Object.create(null), text = new Set(textFiles);
  for (const name of names) {
    const target = await safeFile(root, name, true);
    try { const st = await fs.stat(target); if (!st.isFile()) throw fault('INVALID_EXECUTION_FILE'); files[name] = { ...fileIdentity(await fs.readFile(target), text.has(name) ? 'text' : 'raw'), executable: !!(st.mode & 0o111) }; }
    catch (e) { if (e.code !== 'ENOENT') throw e; files[name] = null; }
  }
  const index = (await git(root, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean);
  const rootStat = await fs.stat(real, { bigint: true });
  const result = { root: real, rootIdentity: { dev: rootStat.dev.toString(), ino: rootStat.ino.toString() }, head: (await git(root, ['rev-parse', 'HEAD'])).trim(), branch: (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim(), index, files };
  const semanticFiles = Object.fromEntries(Object.entries(files).map(([name,value]) => [name,value === null ? null : { kind:value.kind, sha256:value.contentSha256, executable:value.executable }]));
  return { ...result, byteFingerprint: jsonDigest(result), fingerprint: jsonDigest({ ...result, files:semanticFiles }) };
}
// A bounded local subprocess, not an operating-system sandbox. No command strings,
// shell expansion or inherited input. Descendant process containment is not claimed.
export async function executeCase(plan, root, reportPath, { signal } = {}) {
  const argv = [...plan.argv];
  const env = { ...plan.env };
  if (plan.runner === 'pytest') {
    const plugin = path.dirname(fileURLToPath(new URL('./pytest-reporter.py', import.meta.url)));
    env.PYTHONPATH = plugin;
    env.PYTEST_DISABLE_PLUGIN_AUTOLOAD = '1';
    env.PYTHONDONTWRITEBYTECODE = '1';
    env.CODEX_DSH_PYTEST_REPORT = reportPath;
    argv.push('-p', 'pytest-reporter');
  }
  let stdout = [], stderr = [], bytes = 0, termination = 'exited';
  const limit = 16 * 1024 * 1024;
  const result = await new Promise(resolve => {
    const child = spawn(plan.executable, argv, { cwd: root, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let settled = false, cleanupTimer, forceTimer, spawnError;
    const finish = (exitCode, childSignal) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(cleanupTimer); clearTimeout(forceTimer); signal?.removeEventListener('abort', abort);
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      resolve({ exitCode, signal: childSignal, termination, spawnError });
    };
    const stop = reason => {
      if (termination !== 'exited') return;
      termination = reason; child.kill();
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 200);
      cleanupTimer = setTimeout(() => finish(null, null), 1000);
    };
    const abort = () => stop('controller-aborted');
    const timer = setTimeout(() => stop('timeout'), plan.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const capture = sink => chunk => { bytes += chunk.length; if (bytes > limit) stop('output-limit'); else sink.push(chunk); };
    child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
    child.on('error', e => { spawnError = e.code || 'SPAWN_FAILED'; termination = 'spawn-error'; });
    child.on('close', finish);
  });
  let pytest = null;
  if (plan.runner === 'pytest') { try { pytest = JSON.parse(await fs.readFile(reportPath, 'utf8')); } catch { /* missing evidence cannot pass */ } }
  return { ...result, argv, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), pytest };
}
