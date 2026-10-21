import fs from 'node:fs/promises';
import path from 'node:path';
import { fault } from './store.mjs';

// Resolve through the filesystem: string folding alone conflates distinct case-sensitive directories.
export async function directoryIdentity(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fault('ABSOLUTE_CWD_REQUIRED');
  try {
    const canonical = await fs.realpath(cwd);
    const stat = await fs.stat(canonical, { bigint: true });
    if (!stat.isDirectory()) throw fault('CWD_UNRESOLVABLE');
    return { path: canonical, dev: String(stat.dev), ino: String(stat.ino) };
  } catch { throw fault('CWD_UNRESOLVABLE'); }
}

export function sameDirectory(a, b) {
  if (a.ino !== '0' && b.ino !== '0') return a.dev === b.dev && a.ino === b.ino;
  return a.path === b.path;
}

export async function verifySessionDirectory(task, header) {
  if (header?.id !== task.sessionId) throw fault('SESSION_ID_MISMATCH');
  if (typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)) throw fault('SESSION_CWD_UNKNOWN');
  const expected = await directoryIdentity(task.nativeCwd ?? task.cwd);
  if (task.cwdIdentity && !sameDirectory(expected, task.cwdIdentity)) throw fault('SESSION_CWD_MISMATCH');
  const actual = await directoryIdentity(header.cwd);
  if (!sameDirectory(expected, actual)) throw fault('SESSION_CWD_MISMATCH');
  return expected;
}
