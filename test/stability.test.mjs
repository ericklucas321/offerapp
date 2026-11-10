import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../src/infrastructure/repository.mjs';
import { Offers } from '../src/application/offers.mjs';
import { Platform } from '../src/application/platform.mjs';
import { PublicationPolicy } from '../src/domain/publication.mjs';

const productUrl = 'https://produto.mercadolivre.com.br/MLB-123456789-test';
function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-stability-'));
  const store = new Store({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const now = Date.now();
  const clock = () => now;
  const policy = new PublicationPolicy({ store, now: clock });
  const offers = new Offers({ store, policy, now: clock });
  const platform = new Platform({ store, offers, policy, now: clock });
  platform.saveGroup({ id: '123@g.us', startMinute: 0, endMinute: 0 }, [
    { id: '123@g.us', name: 'Teste' },
  ]);
  store.setSetting('publication_paused', 'false');
  const input = {
    productUrl,
    affiliateUrl: 'https://meli.la/test',
    affiliateConfirmed: true,
    availableConfirmed: true,
    title: 'Teste',
    price: 100,
  };
  return { store, offers, platform, policy, now, input };
}

test('reinício da aplicação exige retomada explícita mesmo se a fila estava ativa', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-startup-'));
  const store = new Store({ dataDir });
  store.setSetting('publication_paused', 'false');
  store.close();
  const child = spawn(process.execPath, ['src/app.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('startup_timeout')), 10000);
    child.once('error', reject);
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error('startup_failed'));
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
  });
  const response = await fetch(url + '/api/state');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).publicationPaused, true);
});

test('lote manual não agenda evidência que expirará antes do envio e faz rollback integral', (t) => {
  const { offers, platform, store, input } = setup(t);
  const a = offers.manual(input);
  const b = offers.manual({ ...input, productUrl: productUrl.replace('123456789', '987654321') });
  const batch = platform.batchPreview(
    [a, b].map((o) => ({ offerId: o.id, groupIds: ['123@g.us'] })),
  );
  assert.throws(
    () => platform.approveBatch({ ...batch, confirmed: true }),
    /publication_evidence_expires_before_schedule/,
  );
  assert.equal(store.queueStats().queued, 0);
  assert.equal(
    store.prepare('SELECT completed_at FROM platform_review_batches WHERE id=?').get(batch.id)
      .completed_at,
    null,
  );
});

test('agendamento individual também rejeita confirmação manual que vencerá', (t) => {
  const { offers, store, input, now } = setup(t);
  store.saveDestination('123@g.us', 'Teste');
  const offer = offers.manual(input);
  const reviewed = offers.preview(offer.id);
  assert.throws(
    () =>
      offers.publish(offer.id, {
        confirmed: true,
        reviewToken: reviewed.reviewToken,
        scheduledAt: new Date(now + 3600000).toISOString(),
      }),
    /publication_evidence_expires_before_schedule/,
  );
  assert.equal(store.queueStats().queued, 0);
});

test('URL observada com tracking diferente mantém a identidade do produto browser', (t) => {
  const { platform, policy, store, input, now } = setup(t);
  const observe = (url) => {
    const id = platform.validateConnection('mercadolivre', input.productUrl);
    platform.claimJob();
    platform.completeJob(id, {
      observation: {
        ...input,
        productUrl: url,
        priceCents: 10000,
        stockStatus: 'available',
        priceCondition: 'À vista',
        observedAt: new Date(now).toISOString(),
        affiliateObserved: true,
      },
    });
  };
  observe(input.productUrl);
  const offer = store.listOffers()[0];
  assert.equal(policy.ready(offer, '123@g.us').allowed, true);
  observe(input.productUrl + '?tracking=changed');
  assert.equal(policy.ready(store.getOffer(offer.id), '123@g.us').allowed, true);
  assert.throws(
    () => observe(input.productUrl.replace('123456789', '987654321')),
    /product_marketplace_mismatch/,
  );
});

test('sem grupos habilitados a pendência explica a ação necessária', (t) => {
  const { offers, platform, input, store } = setup(t);
  const offer = offers.manual(input);
  store.prepare('UPDATE destination_groups SET enabled=0').run();
  const item = platform.reviewItems().find((i) => i.id === offer.id);
  assert.equal(item.ready, false);
  assert.equal(item.state, 'pending');
  assert.match(item.reason, /grupo.*Canais/i);
});

test('oferta manual que expira em fila é cancelada e pode ser revalidada para nova aprovação', (t) => {
  const { offers, platform, policy, input, store, now } = setup(t);
  const offer = offers.manual(input);
  const batch = platform.batchPreview([{ offerId: offer.id, groupIds: ['123@g.us'] }]);
  platform.approveBatch({ ...batch, confirmed: true });
  policy.now = () => now + 900001;
  const check = policy.preflight(store.nextDelivery());
  assert.equal(check.allowed, false);
  assert.match(check.reason, /expirou/);
  assert.equal(store.listDeliveries()[0].state, 'cancelled');
  assert.doesNotThrow(() => offers.manual(input, offer.id));
});

test('revalidar manual após envio parcial preserva conteúdo e histórico e libera só destino não enviado', (t) => {
  const { offers, platform, policy, input, store, now } = setup(t);
  platform.saveGroup({ id: '456@g.us', startMinute: 0, endMinute: 0 }, [
    { id: '456@g.us', name: 'Segundo' },
  ]);
  const offer = offers.manual(input);
  platform.approveBatch({
    ...platform.batchPreview([{ offerId: offer.id, groupIds: ['123@g.us', '456@g.us'] }]),
    confirmed: true,
  });
  const first = store.listDeliveries()[0];
  store.markSending(first.id);
  store.markSent(first.id, first.offer_id);
  const publishedAt = store.getOffer(offer.id).published_at;
  const later = now + 900001;
  policy.now = offers.now = platform.now = () => later;
  assert.equal(policy.preflight(store.nextDelivery()).allowed, false);
  assert.equal(
    platform.reviewItems().some((i) => i.id === offer.id),
    true,
  );
  assert.throws(
    () => offers.manual({ ...input, availableConfirmed: false }, offer.id),
    /offer_not_editable/,
  );
  assert.doesNotThrow(() => offers.manual(input, offer.id));
  assert.equal(store.getOffer(offer.id).verified_at, new Date(later).toISOString());
  assert.equal(store.getOffer(offer.id).published_at, publishedAt);
  assert.equal(store.listDeliveries().filter((d) => d.state === 'sent').length, 1);
  const remaining = first.destination === '123@g.us' ? '456@g.us' : '123@g.us';
  assert.deepEqual(platform.reviewItems()[0].eligibleGroups, [remaining]);
  assert.throws(() => offers.manual({ ...input, price: 90 }, offer.id), /offer_not_editable/);
  assert.throws(
    () => offers.manual({ ...input, title: 'Alterado' }, offer.id),
    /offer_not_editable/,
  );
  const batch = platform.batchPreview([{ offerId: offer.id, groupIds: [remaining] }]);
  platform.approveBatch({ ...batch, confirmed: true });
  assert.throws(() => offers.manual(input, offer.id), /offer_not_editable/);
  assert.equal(store.listDeliveries().filter((d) => d.state === 'queued').length, 1);
  assert.equal(store.listDeliveries().filter((d) => d.state === 'sent').length, 1);
  const last = store.listDeliveries().find((d) => d.state === 'queued');
  store.markSending(last.id);
  store.markSent(last.id, last.offer_id);
  assert.equal(
    platform.reviewItems().some((i) => i.id === offer.id),
    false,
  );
});
