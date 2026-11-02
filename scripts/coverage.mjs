import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { files } from './files.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suites = files(path.join(root, 'test')).filter((name) => name.endsWith('.test.mjs'));
const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--experimental-test-coverage',
    '--test-coverage-include=**/src/**',
    '--test-coverage-include=**/extension/**',
    ...suites,
  ],
  { cwd: root, stdio: 'inherit' },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
