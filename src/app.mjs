import { VERSION } from './shared/version.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform } from './application/platform.mjs';
import { Store } from './infrastructure/repository.mjs';
import { WhatsAppPublisher } from './infrastructure/whatsapp.mjs';
import { Offers } from './application/offers.mjs';
import { PublicationPolicy } from './domain/publication.mjs';
import { createQueueWorker } from './jobs/queue.mjs';
import { createServer } from './http/server.mjs';
import { acquireRuntimeLock } from './infrastructure/runtime-lock.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const port = Number(process.env.PORT ?? 3210);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error('invalid_configuration_port');
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
const releaseLock = acquireRuntimeLock(dataDir);
process.on('exit', releaseLock);
const store = new Store({ dataDir });
if (store.setting('automatic_enabled', 'false') !== 'true')
  store.setSetting('publication_paused', 'true');
const publisher = new WhatsAppPublisher({ dataDir: store.dataDir });
const policy = new PublicationPolicy({ store });
const offers = new Offers({ store, policy, env: process.env });
const platform = new Platform({ store, offers, policy, publisherReady: () => publisher.isReady() });
const worker = createQueueWorker({
  store,
  publisher,
  intervalMs: 5000,
  maxAttempts: 3,
  preflight: (job) => platform.preflight(job),
  finalCheck: (job) => policy.preflight(job),
});
const server = createServer({ store, publisher, offers, root, platform });
server.listen(port, '127.0.0.1', () => {
  console.log(`Offer Machine ${VERSION} → http://127.0.0.1:${server.address().port}`);
  worker.start();
  platform.start();
  if (fs.existsSync(path.join(store.dataDir, 'wa-auth/creds.json')))
    publisher.connect().catch(() => {});
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  const drained = worker.stop();
  platform.stop();
  server.close(async () => {
    await drained;
    await publisher.close();
    store.close();
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
