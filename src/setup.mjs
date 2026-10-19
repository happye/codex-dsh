import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { StateStore, fault, identifier } from './store.mjs';
import { Controller } from './controller.mjs';

export const toolRoot = fileURLToPath(new URL('../', import.meta.url));
export function personalPaths(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  if (!path.isAbsolute(codexHome)) throw fault('INVALID_CODEX_HOME');
  const skillDir = path.join(codexHome, 'skills', 'codex-dsh-collab');
  return { codexHome, skillDir, profilePath: path.join(skillDir, 'local-settings.json') };
}
async function safePath(target, missing = false) {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink > 1)) throw fault('UNSAFE_PROFILE_PATH');
    } catch (error) { if (missing && error.code === 'ENOENT') return; throw error; }
  }
}
export function connectionOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw fault('INVALID_URL'); }
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw fault('INVALID_URL');
  return url.origin;
}
export async function readProfile(paths) {
  await safePath(paths.profilePath, true);
  let profile;
  try { profile = JSON.parse(await fs.readFile(paths.profilePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw fault('INVALID_LOCAL_PROFILE'); }
  try {
    if (!profile || profile.schema !== 1 || !path.isAbsolute(profile.toolRoot) || !path.isAbsolute(profile.stateDir) ||
        Object.keys(profile).some(key => !['schema', 'toolRoot', 'stateDir', 'connection', 'url'].includes(key)) ||
        connectionOrigin(profile.url) !== profile.url) throw fault('INVALID_LOCAL_PROFILE');
    identifier(profile.connection);
  } catch { throw fault('INVALID_LOCAL_PROFILE'); }
  return profile;
}
export async function resolveStateDirectory(explicit, { cwd = process.cwd(), codexHome } = {}) {
  if (explicit !== undefined) return path.resolve(cwd, explicit);
  const profile = await readProfile(personalPaths(codexHome));
  if (!profile) return path.join(cwd, '.codex-dsh');
  await requireExistingState(profile.stateDir);
  return profile.stateDir;
}
async function requireExistingState(directory) {
  try { await safePath(path.join(directory, 'marker.json')); }
  catch (error) { if (error.code === 'ENOENT') throw fault('STATE_PROFILE_MISSING'); throw error; }
}
async function replaceFile(target, content) {
  await safePath(target, true);
  const temporary = path.join(path.dirname(target), `.setup-${randomUUID()}`);
  await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  try { await safePath(target, true); await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
}
export async function setup(options, { codexHome, token } = {}) {
  const paths = personalPaths(codexHome);
  await safePath(paths.skillDir, true);
  const previous = await readProfile(paths);
  const url = connectionOrigin(options.url ?? previous?.url);
  const connection = identifier(options.name ?? previous?.connection ?? 'native');
  const stateDir = options['state-dir'] ?? previous?.stateDir ?? path.join(paths.codexHome, 'codex-dsh-state');
  if (!path.isAbsolute(stateDir)) throw fault('INVALID_STATE_DIR');
  if (previous && !options['state-dir']) await requireExistingState(stateDir);
  // A URL change needs a distinct explicit alias; never repoint the existing task profile silently.
  if (previous && previous.url !== url && (!options.name || connection === previous.connection)) throw fault('CONNECTION_IDENTITY_CONFLICT');
  const sources = ['SKILL.md', path.join('agents', 'openai.yaml')];
  const contents = await Promise.all(sources.map(name => fs.readFile(path.join(toolRoot, '.agents', 'skills', 'codex-dsh-collab', name))));
  for (const name of sources) await safePath(path.join(paths.skillDir, name), true);
  try {
    const entries = await fs.readdir(paths.skillDir);
    if (previous || entries.length) {
      const skill = await fs.readFile(path.join(paths.skillDir, 'SKILL.md'), 'utf8');
      if (!/^---\r?\n[^]*?^name:\s*codex-dsh-collab\s*\r?\n[^]*?^---\s*$/m.test(skill)) throw fault('UNSAFE_SKILL_DIRECTORY');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { if ((await fs.readdir(paths.skillDir)).length || previous) throw fault('UNSAFE_SKILL_DIRECTORY'); }
    catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
  }
  await fs.mkdir(paths.skillDir, { recursive: true });
  const lockPath = path.join(paths.skillDir, '.setup.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw fault('STATE_SETUP_LOCKED'); throw error; }
  try {
    // Recheck under the installation lock before replacing personal settings.
    if (JSON.stringify(await readProfile(paths)) !== JSON.stringify(previous)) throw fault('STATE_PROFILE_CHANGED');
    await safePath(stateDir, true);
    await fs.mkdir(path.dirname(stateDir), { recursive: true });
    const store = await StateStore.open(stateDir);
    const known = await store.transaction(state => {
      const existing = state.connections[connection];
      if (existing && existing.baseUrl !== url) throw fault('CONNECTION_IDENTITY_CONFLICT');
      return !!existing?.cookie;
    });
    if (token !== undefined) await new Controller({ store }).attach({ name: connection, url, token });
    await fs.mkdir(path.join(paths.skillDir, 'agents'), { recursive: true });
    for (let i = 0; i < sources.length; i++) await replaceFile(path.join(paths.skillDir, sources[i]), contents[i]);
    const profile = { schema: 1, toolRoot, stateDir, connection, url };
    await replaceFile(paths.profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    return { skillInstalled: true, profilePath: paths.profilePath, ...profile, authenticationRequired: token === undefined && !known };
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
export async function connections(store) {
  return store.transaction(state => ({ connections: Object.entries(state.connections).map(([name, item]) => ({
    name, baseUrl: connectionOrigin(item.baseUrl),
    tasks: Object.values(state.tasks).filter(task => task.connection === name).map(task => ({ id: task.id, cwd: task.cwd, sessionId: task.sessionId })),
  })) }));
}
