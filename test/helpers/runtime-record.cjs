const fs = require('node:fs');
const { createHash } = require('node:crypto');
const target = process.env.E2E_RUNTIME_RECORD;
if (target) fs.writeFileSync(target, JSON.stringify({
  execPath: process.execPath, version: process.version, undici: process.versions.undici ?? null,
  executableSha256: createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
}), { flag: 'wx' });
