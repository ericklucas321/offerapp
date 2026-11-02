import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireRuntimeLock } from '../src/infrastructure/runtime-lock.mjs';
test('mesmo banco admite uma instância e liberar não remove lock de outro proprietário', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-lock-'));
  const release = acquireRuntimeLock(dir);
  assert.throws(() => acquireRuntimeLock(dir), /runtime_already_running/);
  const file = path.join(dir, '.offer-runtime.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'other-owner' }));
  release();
  assert.equal(fs.existsSync(file), true);
});
test('lock com conteúdo inválido não é removido silenciosamente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-invalid-lock-'));
  fs.writeFileSync(path.join(dir, '.offer-runtime.lock'), 'invalid');
  assert.throws(() => acquireRuntimeLock(dir), /runtime_lock_invalid/);
});
test('release libera o lock e pode ser repetido', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-release-lock-'));
  const release = acquireRuntimeLock(dir);
  release();
  release();
  const second = acquireRuntimeLock(dir);
  second();
});

test('reinício recupera lock deixado por processo encerrado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-stale-lock-'));
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(child.status, 0);
  fs.writeFileSync(
    path.join(dir, '.offer-runtime.lock'),
    JSON.stringify({ pid: child.pid, token: 'stale' }),
  );
  const release = acquireRuntimeLock(dir);
  assert.equal(fs.existsSync(path.join(dir, '.offer-runtime-recovery.lock')), false);
  release();
});

test('outro processo não abre banco protegido por instância ativa', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-process-lock-'));
  const release = acquireRuntimeLock(dir);
  try {
    const moduleUrl = new URL('../src/infrastructure/runtime-lock.mjs', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {acquireRuntimeLock} from ${JSON.stringify(moduleUrl)}; acquireRuntimeLock(process.argv[1]);`,
        dir,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(child.status, 1);
    assert.match(child.stderr, /runtime_already_running/);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, '.offer-runtime.lock'))).pid,
      process.pid,
    );
  } finally {
    release();
  }
});
