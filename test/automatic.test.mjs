import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/infrastructure/repository.mjs';
import { Offers } from '../src/application/offers.mjs';
import { Platform } from '../src/application/platform.mjs';
import { PublicationPolicy } from '../src/domain/publication.mjs';
import { createQueueWorker } from '../src/jobs/queue.mjs';

function fixture(t) {
  let now = Date.parse('2026-11-02T15:00:00Z'),
    connected = true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-auto-'));
  const store = new Store({ dataDir: dir });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const policy = new PublicationPolicy({ store, now: () => now });
  const offers = new Offers({ store, policy, now: () => now });
  const platform = new Platform({
    store,
    offers,
    policy,
    now: () => now,
    publisherReady: () => connected,
  });
  const groups = [
    { id: '123@g.us', name: 'Teste' },
    { id: '456@g.us', name: 'Outro' },
  ];
  for (const g of groups) platform.saveGroup({ ...g, intervalMinutes: 5 }, groups);
  platform.saveTopic({
    name: 'Casa',
    keywords: ['cafeteira'],
    stores: ['mercadolivre'],
    groupIds: ['123@g.us'],
    minCents: 100,
    maxCents: 20000,
  });
  store.setSetting('publication_paused', 'false');
  store.setSetting('bridge_last_seen', String(now));
  store
    .prepare("UPDATE store_connections SET state='ready' WHERE marketplace='mercadolivre'")
    .run();
  let seq = 0;
  const product = (overrides = {}) => {
    const id = platform.addJob(
      'mercadolivre',
      'product',
      { productUrl: `https://produto.mercadolivre.com.br/MLB-${123456780 + ++seq}-cafeteira` },
      { topicId: 1 },
    );
    store.setSetting('search_enabled', 'true');
    const job = platform.claimJob();
    assert.equal(job.id, id);
    platform.completeJob(id, {
      observation: {
        title: 'Cafeteira italiana',
        productUrl: job.payload.productUrl,
        priceCents: 10000,
        stockStatus: 'available',
        priceCondition: 'Pix',
        observedAt: new Date(now).toISOString(),
        affiliateUrl: 'https://meli.la/teste',
        affiliateObserved: true,
        ...overrides,
      },
    });
    return store.listOffers()[0];
  };
  return {
    store,
    platform,
    policy,
    product,
    advance: (ms) => {
      now += ms;
      store.setSetting('bridge_last_seen', String(now));
    },
    offline: () => {
      connected = false;
    },
  };
}

test('automático exige habilitação explícita e agenda uma entrega por grupo sem duplicar', (t) => {
  const { store, platform, product } = fixture(t);
  product();
  product();
  platform.automation.tick();
  assert.equal(store.listDeliveries().length, 0);
  platform.automation.configure({ enabled: true, groupIds: ['123@g.us'] });
  platform.automation.tick();
  platform.automation.tick();
  const rows = store.listDeliveries();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mode, 'automatic');
  assert.equal(rows[0].destination, '123@g.us');
  assert.match(rows[0].approved_message, /Cafeteira/);
  assert.equal(platform.status().automaticEnabled, true);
});

test('automático respeita faixa, tema, título e origem da oferta', (t) => {
  const { store, platform, product } = fixture(t);
  product({ title: 'Geladeira nova' });
  platform.automation.configure({ enabled: true, groupIds: ['123@g.us', '456@g.us'] });
  platform.automation.tick();
  assert.equal(store.listDeliveries().length, 0);
  const offer = product();
  store.prepare('UPDATE topics SET max_cents=5000 WHERE id=1').run();
  platform.automation.tick();
  assert.equal(store.listDeliveries().length, 0);
  store.prepare('UPDATE topics SET max_cents=20000 WHERE id=1').run();
  store.prepare("UPDATE offers SET source='manual' WHERE id=?").run(offer.id);
  platform.automation.tick();
  assert.equal(store.listDeliveries().length, 0);
});

test('pausa, desconexão e janela de horário impedem agendamento automático', (t) => {
  for (const mode of ['paused', 'offline', 'bridge', 'night']) {
    const f = fixture(t);
    f.product();
    f.platform.automation.configure({ enabled: true, groupIds: ['123@g.us'] });
    if (mode === 'paused') f.store.setSetting('publication_paused', 'true');
    if (mode === 'offline') f.offline();
    if (mode === 'bridge') f.store.setSetting('bridge_last_seen', '0');
    if (mode === 'night') f.advance(12 * 3600000);
    f.platform.automation.tick();
    assert.equal(f.store.listDeliveries().length, 0, mode);
  }
});

test('desligar modo cancela sua fila e regras alteradas bloqueiam também a verificação final', (t) => {
  const { store, platform, policy, product } = fixture(t);
  product();
  platform.automation.configure({ enabled: true, groupIds: ['123@g.us'] });
  platform.automation.tick();
  const job = store.nextDelivery();
  store.prepare('UPDATE topics SET enabled=0 WHERE id=1').run();
  assert.equal(policy.preflight(job).allowed, false);
  assert.equal(store.listDeliveries()[0].state, 'cancelled');
  store.prepare('UPDATE topics SET enabled=1 WHERE id=1').run();
  platform.automation.tick();
  platform.automation.configure({ enabled: false });
  assert.equal(
    store.listDeliveries().some((d) => d.state === 'queued'),
    false,
  );
});

test('automático não repete outro registro do mesmo produto com envio incerto ou falha esgotada', (t) => {
  for (const state of ['uncertain', 'failed', 'failed-approved']) {
    const { store, platform, product } = fixture(t);
    const offer = product();
    platform.automation.configure({ enabled: true, groupIds: ['123@g.us'] });
    platform.automation.tick();
    store
      .prepare('UPDATE deliveries SET state=?,mode=?')
      .run(
        state === 'failed-approved' ? 'failed' : state,
        state === 'failed-approved' ? 'approved' : 'automatic',
      );
    store.prepare("UPDATE offers SET published_at='2026-10-01T15:00:00Z' WHERE id=?").run(offer.id);
    const duplicate = store.createOffer(
      {
        title: 'Cafeteira italiana',
        price: 100,
        productUrl: offer.product_url,
        affiliateUrl: 'https://meli.la/novo',
        affiliateConfirmed: true,
        availableConfirmed: true,
      },
      { deduplicate: false },
    );
    store.setOfferEvidence(duplicate.id, {
      source: 'browser',
      verifiedAt: offer.verified_at,
      stockStatus: 'available',
    });
    store.prepare('INSERT INTO offer_topics VALUES(?,1)').run(duplicate.id);
    platform.automation.tick();
    assert.equal(store.listDeliveries().length, 1, state);
  }
});

test('pausar depois de agendar e remover o grupo da autorização impede transporte', (t) => {
  const { store, platform, policy, product } = fixture(t);
  product();
  platform.automation.configure({ enabled: true, groupIds: ['123@g.us'] });
  platform.automation.tick();
  const job = store.nextDelivery();
  store.setSetting('publication_paused', 'true');
  assert.equal(policy.preflight(job).allowed, false);
  store.setSetting('publication_paused', 'false');
  platform.automation.configure({ enabled: true, groupIds: ['456@g.us'] });
  assert.equal(policy.preflight(job).allowed, false);
  assert.equal(store.listDeliveries()[0].state, 'cancelled');
});

test('falha de preço em atualização cancela só a oferta e não paralisa a loja nem reencadeia o snapshot', async (t) => {
  const { store, platform, product } = fixture(t);
  const offer = product();
  platform.automation.configure({ enabled: true, groupIds: ['123@g.us'] });
  platform.automation.tick();
  await platform.preflight(store.nextDelivery());
  const refresh = platform.claimJob();
  platform.completeJob(refresh.id, {
    error: 'Preço ambíguo',
    code: 'source_browser_price_ambiguous',
  });
  assert.equal(store.listDeliveries()[0].state, 'cancelled');
  assert.equal(
    platform.status().connections.find((c) => c.marketplace === 'mercadolivre').state,
    'ready',
  );
  assert.equal(store.evidenceFor(offer).stock_status, 'unknown');
  platform.automation.tick();
  assert.equal(store.listDeliveries().length, 1);
});

test('ciclo automático atualiza pelo navegador antes do transporte e respeita intervalo e histórico', async (t) => {
  const f = fixture(t);
  f.product();
  f.platform.automation.configure({ enabled: true, groupIds: ['123@g.us'] });
  f.platform.automation.tick();
  const sent = [];
  const worker = createQueueWorker({
    store: f.store,
    publisher: { isReady: () => true, send: async (...args) => sent.push(args) },
    preflight: (job) => f.platform.preflight(job),
    finalCheck: (job) => f.policy.preflight(job),
  });
  // The production queue uses wall time, so make this isolated delivery immediately due.
  f.store
    .prepare("UPDATE deliveries SET scheduled_at='2020-01-01',next_attempt_at='2020-01-01'")
    .run();
  await worker.tick();
  assert.equal(sent.length, 0);
  const refresh = f.platform.claimJob();
  assert.equal(refresh.kind, 'refresh');
  f.platform.completeJob(refresh.id, {
    observation: {
      title: 'Cafeteira italiana',
      productUrl: refresh.payload.productUrl,
      priceCents: 10000,
      stockStatus: 'available',
      priceCondition: 'Pix',
      observedAt: '2026-11-02T15:00:00Z',
      affiliateUrl: 'https://meli.la/teste',
      affiliateObserved: true,
    },
  });
  f.store.prepare("UPDATE deliveries SET next_attempt_at='2020-01-01'").run();
  await worker.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], '123@g.us');
  assert.match(sent[0][1], /Pix/);
  f.platform.automation.tick();
  assert.equal(f.store.listDeliveries().length, 1);
});
