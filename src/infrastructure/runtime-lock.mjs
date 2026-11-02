import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function acquireRuntimeLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filename = path.join(dataDir, '.offer-runtime.lock');
  const recovery = path.join(dataDir, '.offer-runtime-recovery.lock');
  const text = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let recovering = false;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.writeFileSync(filename, text, { flag: 'wx', mode: 0o600 });
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try {
            if (fs.readFileSync(filename, 'utf8') === text) fs.unlinkSync(filename);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!recovering) {
          try {
            fs.writeFileSync(recovery, text, { flag: 'wx', mode: 0o600 });
            recovering = true;
          } catch (guard) {
            if (guard.code === 'EEXIST') throw new Error('runtime_already_running');
            throw guard;
          }
        }
        let existing;
        try {
          existing = JSON.parse(fs.readFileSync(filename, 'utf8'));
        } catch (read) {
          if (read.code === 'ENOENT') continue;
          throw new Error('runtime_lock_invalid');
        }
        if (!Number.isSafeInteger(existing.pid) || existing.pid < 1)
          throw new Error('runtime_lock_invalid');
        try {
          process.kill(existing.pid, 0);
          throw new Error('runtime_already_running');
        } catch (alive) {
          if (alive.code !== 'ESRCH') throw alive;
        }
        fs.unlinkSync(filename);
      }
    }
    throw new Error('runtime_already_running');
  } finally {
    if (recovering && fs.readFileSync(recovery, 'utf8') === text) fs.unlinkSync(recovery);
  }
}
