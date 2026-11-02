import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './files.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const entries = [];
function include(relative) {
  if (relative.replaceAll(path.sep, '/') === 'test-ui/evidence') return;
  const full = path.join(root, relative),
    stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) throw new Error('package_symlink_rejected');
  if (stat.isDirectory())
    for (const name of fs.readdirSync(full).sort()) include(path.join(relative, name));
  else entries.push(['offer-machine/' + relative.replaceAll(path.sep, '/'), fs.readFileSync(full)]);
}
for (const name of [
  'src',
  'public',
  'extension',
  'scripts',
  'test',
  'test-ui',
  'docs',
  'package.json',
  'package-lock.json',
  'README.md',
  'ARQUITETURA.md',
  'AUDITORIA.md',
  'AUDITORIA-2026-10-21.md',
  '.env.example',
  '.gitignore',
  '.prettierignore',
  '.prettierrc',
  'RUNTIME.bat',
  'INICIAR.bat',
  'INSTALAR.bat',
  'TESTAR.bat',
])
  include(name);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const archive = zip(entries);
fs.writeFileSync(path.join(root, `dist/offer-machine-clean-${version}.zip`), archive);
console.log(
  `Clean distribution built: ${entries.length} files, ${archive.length} bytes. No data, .env, credentials or installed dependencies.`,
);
