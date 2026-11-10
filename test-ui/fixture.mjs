import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/infrastructure/repository.mjs';
import { Offers } from '../src/application/offers.mjs';
import { Platform } from '../src/application/platform.mjs';
import { PublicationPolicy } from '../src/domain/publication.mjs';
import { createServer } from '../src/http/server.mjs';
export async function startFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-ui-'));
  const store = new Store({ dataDir });
  store.setSetting('publication_paused', 'true');
  const policy = new PublicationPolicy({ store });
  const offers = new Offers({ store, policy });
  const platform = new Platform({ store, offers, policy });
  const knownGroups = [{ id: '123456789@g.us', name: 'Grupo de teste local' }];
  const publisher = {
    status: () => ({ state: 'connected', lastError: null }),
    groups: async () => knownGroups,
    qrDataUrl: async () => null,
    connect: async () => ({ state: 'connected' }),
    reconnect: async () => ({ state: 'connected' }),
    logout: async () => ({ state: 'disconnected' }),
    send: async () => {
      throw new Error('External transport forbidden in UI fixture');
    },
  };
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = createServer({ store, offers, platform, publisher, root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    store,
    platform,
    offers,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
