import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { files } from './files.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const folder of ['src', 'public', 'extension', 'scripts', 'test', 'test-ui'])
  for (const file of files(path.join(root, folder))) {
    const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
  }
console.log('All operational modules, UI, extension, scripts and tests parse.');
