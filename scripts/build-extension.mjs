import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './files.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  folder = path.join(root, 'extension');
const sources = ['src/shared/market-parser.mjs', 'src/shared/capture-contract.mjs'];
const bundle = sources
  .map((file) =>
    fs
      .readFileSync(path.join(root, file), 'utf8')
      .replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];\s*/gm, ''),
  )
  .join('\n');
fs.writeFileSync(
  path.join(folder, 'capture.js'),
  '// Generated from src/shared. Run npm run build:extension.\n' + bundle,
);
const names = [
  'manifest.json',
  'capture.js',
  'popup.js',
  'popup.html',
  'README.md',
  'background.js',
  'bridge.js',
  'store-adapters.js',
  'browser-worker.js',
];
const archive = zip(names.map((n) => [n, fs.readFileSync(path.join(folder, n))]));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/offer-machine-extension.zip'), archive);
fs.writeFileSync(path.join(root, 'public/browser-extension.zip'), archive);
console.log('Extension built from shared parser; no credentials or sessions included.');
