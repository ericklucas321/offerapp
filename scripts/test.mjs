import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { files } from './files.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suites = files(path.join(root, 'test')).filter((n) => n.endsWith('.test.mjs'));
const r = spawnSync(process.execPath, ['--test', ...suites], { stdio: 'inherit' });
if (r.error) console.error(r.error.message);
process.exit(r.status ?? 1);
