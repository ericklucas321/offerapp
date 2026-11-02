import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/infrastructure/repository.mjs';
import { Offers } from '../src/application/offers.mjs';
import { PublicationPolicy, nextPublicationAt } from '../src/domain/publication.mjs';
import { publicationWindow } from '../src/domain/rules.mjs';
import { Platform } from '../src/application/platform.mjs';
import { createQueueWorker } from '../src/jobs/queue.mjs';
import { DatabaseSync } from 'node:sqlite';

const NOW = Date.parse('2026-10-05T15:00:00Z');
const GROUPS = [
  { id: '123@g.us', name: 'Casa' },
  { id: '456@g.us', name: 'Achadinhos' },
];
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-platform-'));
  const store = new Store({ dataDir: dir });
  t.after(() => store.close());
  store.saveDestination(GROUPS[0].id, GROUPS[0].name);
  store.setSetting('publication_paused', 'false');
  const policy = new PublicationPolicy({ store, now: () => NOW }),
    offers = new Offers({ store, policy, now: () => NOW }),
    platform = new Platform({ store, offers, policy, now: () => NOW });
  platform.saveGroup({ id: '456@g.us' }, GROUPS);
  const create = (n = 1) =>
    offers.manual({
      title: `Cafeteira ${n}`,
      price: 100,
      productUrl: `https://produto.mercadolivre.com.br/MLB-${123456780 + n}-fixture`,
      affiliateUrl: `https://meli.la/test${n}`,
      affiliateConfirmed: true,
      availableConfirmed: true,
    });
  return { store, policy, offers, platform, create };
}
const selection = (offer, groupIds = ['123@g.us', '456@g.us']) => [{ offerId: offer.id, groupIds }];

test('migração preserva tabela de lotes arquivada sem colisão com os novos lotes', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-legacy-batches-'));
  const legacy = new DatabaseSync(path.join(dataDir, 'offers.sqlite'));
  legacy.exec(
    "CREATE TABLE review_batches(id INTEGER PRIMARY KEY,created_at TEXT NOT NULL) STRICT; INSERT INTO review_batches VALUES(42,'2026-10-01')",
  );
  legacy.close();
  const store = new Store({ dataDir });
  t.after(() => store.close());
  assert.equal(store.db.prepare('SELECT id FROM review_batches').get().id, 42);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM platform_review_batches').get().n, 0);
});

test('migração preserva destino antigo e grupos, temas e lotes sobrevivem ao reinício', (t) => {
  const { store, platform, create } = fixture(t);
  platform.saveTopic({
    name: 'Cozinha',
    keywords: ['cafeteira'],
    stores: ['mercadolivre'],
    groupIds: ['123@g.us'],
    maxCents: 20000,
  });
  const batch = platform.batchPreview(selection(create()));
  platform.approveBatch({ ...batch, confirmed: true });
  const reopened = new Store({ dataDir: store.dataDir });
  t.after(() => reopened.close());
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM destination_groups').get().n, 2);
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM topics').get().n, 1);
  assert.equal(
    reopened.db
      .prepare('SELECT count(*) AS n FROM platform_review_batches WHERE completed_at IS NOT NULL')
      .get().n,
    1,
  );
  assert.equal(reopened.listDeliveries().length, 2);
  assert.equal(reopened.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
test('aprovação de lote é idempotente e organiza entregas independentes por grupo', (t) => {
  const { store, platform, create } = fixture(t),
    a = create(1),
    b = create(2);
  platform.saveGroup({ id: '123@g.us', intervalMinutes: 15 }, GROUPS);
  platform.saveGroup({ id: '456@g.us', intervalMinutes: 10 }, GROUPS);
  const batch = platform.batchPreview([...selection(a), ...selection(b)]);
  const result = platform.approveBatch({ ...batch, confirmed: true });
  assert.deepEqual(platform.approveBatch({ ...batch, confirmed: true }), result);
  assert.equal(store.listDeliveries().length, 4);
  const rows = store.listDeliveries().sort((a, b) => a.id - b.id);
  assert.equal(rows[0].scheduled_at, new Date(NOW).toISOString());
  assert.equal(rows[1].scheduled_at, new Date(NOW).toISOString());
  assert.equal(rows[2].scheduled_at, new Date(NOW + 15 * 60000).toISOString());
  assert.equal(rows[3].scheduled_at, new Date(NOW + 10 * 60000).toISOString());
});
test('mudança de mensagem ou regra após prévia invalida todo o lote sem entregas parciais', (t) => {
  for (const kind of ['message', 'group']) {
    const { store, platform, create } = fixture(t),
      a = create(1),
      b = create(2),
      batch = platform.batchPreview([...selection(a), ...selection(b)]);
    if (kind === 'message')
      store.db.prepare("UPDATE offers SET title='Outro título' WHERE id=?").run(b.id);
    else platform.saveGroup({ id: '456@g.us', intervalMinutes: 7 }, GROUPS);
    assert.throws(
      () => platform.approveBatch({ ...batch, confirmed: true }),
      /publication_review_changed/,
    );
    assert.equal(store.listDeliveries().length, 0);
  }
});
test('sem teto diário, janelas e intervalos são próprios do grupo, inclusive janela noturna', () => {
  const sent = Array.from({ length: 100 }, () => ({
    sent_at: new Date(NOW - 3600001).toISOString(),
  }));
  assert.equal(publicationWindow(sent, NOW).allowed, true);
  assert.equal(
    publicationWindow([{ sent_at: new Date(NOW - 120000).toISOString() }], NOW, {
      interval_minutes: 1,
    }).allowed,
    true,
  );
  assert.equal(
    publicationWindow([], Date.parse('2026-10-06T02:00:00Z'), {
      start_minute: 1320,
      end_minute: 120,
    }).allowed,
    true,
  );
  assert.equal(
    nextPublicationAt([], Date.parse('2026-10-05T14:00:00Z'), {
      start_minute: 720,
      end_minute: 780,
    }),
    '2026-10-05T15:00:00.000Z',
  );
});
test('envio confirmado em um grupo não bloqueia o mesmo produto em outro', async (t) => {
  const { store, platform, create } = fixture(t),
    offer = create(),
    batch = platform.batchPreview(selection(offer));
  platform.approveBatch({ ...batch, confirmed: true });
  let sends = 0;
  const worker = createQueueWorker({
    store,
    publisher: { send: async () => sends++ },
    preflight: (job) => platform.preflight(job),
  });
  await worker.tick();
  await worker.tick();
  assert.equal(sends, 2);
  assert.equal(store.queueStats().sent, 2);
});
test('descartar persiste e oferta com envio pendente não pode ser descartada', (t) => {
  const { platform, create } = fixture(t),
    a = create(1),
    b = create(2);
  platform.discard({ offerId: a.id });
  assert.equal(
    platform.reviewItems().some((i) => i.id === a.id),
    false,
  );
  const batch = platform.batchPreview(selection(b));
  platform.approveBatch({ ...batch, confirmed: true });
  assert.throws(() => platform.discard({ offerId: b.id }), /offer_not_editable/);
});
test('conexões iniciam indisponíveis; ponte exige token e coleta não cria publicações', (t) => {
  const { store, platform } = fixture(t);
  assert.equal(
    platform.status().connections.every((c) => c.state === 'unconfigured'),
    true,
  );
  const { token } = platform.pair('a'.repeat(32));
  assert.equal(platform.authenticate(token), true);
  assert.equal(platform.authenticate('b'.repeat(64)), false);
  const id = platform.validateConnection(
    'mercadolivre',
    'https://produto.mercadolivre.com.br/MLB-123456789-test',
  );
  assert.equal(platform.claimJob().id, id);
  platform.completeJob(id, {
    observation: {
      productUrl: 'https://produto.mercadolivre.com.br/MLB-123456789-test',
      title: 'Cafeteira',
      priceCents: 10000,
      stockStatus: 'available',
      priceCondition: 'Preço à vista anunciado',
      observedAt: new Date(NOW).toISOString(),
      affiliateUrl: 'https://meli.la/observed',
      affiliateObserved: true,
    },
  });
  assert.equal(
    platform.status().connections.find((c) => c.marketplace === 'mercadolivre').state,
    'ready',
  );
  assert.equal(store.listDeliveries().length, 0);
  assert.equal(platform.reviewItems()[0].ready, true);
});
test('validação inconclusiva não habilita loja; falha suspende só a loja afetada', (t) => {
  const { platform, store } = fixture(t);
  const id = platform.validateConnection(
    'mercadolivre',
    'https://produto.mercadolivre.com.br/MLB-123456789-test',
  );
  platform.claimJob();
  assert.throws(
    () =>
      platform.completeJob(id, {
        observation: {
          productUrl: 'https://produto.mercadolivre.com.br/MLB-123456789-test',
          title: 'Produto',
          priceCents: 10000,
          stockStatus: 'unknown',
          priceCondition: 'À vista',
          observedAt: new Date(NOW).toISOString(),
          affiliateUrl: 'https://meli.la/no-stock',
          affiliateObserved: true,
        },
      }),
    /stock_confirmation_required/,
  );
  platform.completeJob(id, { error: 'Verificação necessária' });
  assert.equal(
    platform.status().connections.find((c) => c.marketplace === 'mercadolivre').state,
    'attention',
  );
  assert.equal(
    platform.status().connections.find((c) => c.marketplace === 'amazon').state,
    'unconfigured',
  );
  assert.equal(store.listOffers().length, 0);
});
test('busca obedece temas, não se sobrepõe e gera trabalhos sem publicar', (t) => {
  const { platform, store } = fixture(t);
  platform.saveTopic({
    name: 'Casa',
    keywords: ['cafeteira', 'panela'],
    stores: ['mercadolivre', 'amazon'],
    groupIds: ['123@g.us'],
    minCents: 1000,
    maxCents: 30000,
  });
  store.db
    .prepare("UPDATE store_connections SET state='ready' WHERE marketplace='mercadolivre'")
    .run();
  store.setSetting('search_enabled', 'true');
  platform.tick();
  platform.tick(true);
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM browser_jobs WHERE kind='search'").get().n,
    2,
  );
  assert.equal(store.listDeliveries().length, 0);
});

test('busca bloqueada não inventa data de pesquisa e informa a loja que exige atenção', (t) => {
  const { platform, store } = fixture(t);
  platform.saveTopic({
    name: 'Casa',
    keywords: ['cafeteira'],
    stores: ['mercadolivre'],
    groupIds: ['123@g.us'],
    maxCents: 30000,
  });
  store.setSetting('search_enabled', 'true');
  store
    .prepare(
      "UPDATE store_connections SET state='attention',last_error='Verificação necessária' WHERE marketplace='mercadolivre'",
    )
    .run();
  platform.tick();
  assert.equal(platform.status().lastSearchAt, '');
  assert.match(platform.status().searchBlockedReason, /Mercado Livre.*Verificação necessária/);
});

test('falha transitória de busca mantém a loja e as outras pesquisas habilitadas', (t) => {
  const { platform, store } = fixture(t);
  platform.saveTopic({
    name: 'Casa',
    keywords: ['cafeteira', 'mesa'],
    stores: ['mercadolivre'],
    groupIds: ['123@g.us'],
    maxCents: 30000,
  });
  store.setSetting('search_enabled', 'true');
  store
    .prepare("UPDATE store_connections SET state='ready' WHERE marketplace='mercadolivre'")
    .run();
  platform.tick();
  const job = platform.claimJob();
  platform.completeJob(job.id, { error: 'Resultados não carregaram', code: 'search_read_failed' });
  assert.equal(
    platform.status().connections.find((c) => c.marketplace === 'mercadolivre').state,
    'ready',
  );
  assert.equal(platform.claimJob().payload.keyword, 'mesa');
});

test('preço ambíguo em um produto não suspende as outras leituras da loja', (t) => {
  const { platform, store } = fixture(t);
  store.setSetting('search_enabled', 'true');
  store
    .prepare("UPDATE store_connections SET state='ready' WHERE marketplace='mercadolivre'")
    .run();
  platform.addJob('mercadolivre', 'product', {
    productUrl: 'https://produto.mercadolivre.com.br/MLB-123456789-teste',
  });
  platform.addJob('mercadolivre', 'product', {
    productUrl: 'https://produto.mercadolivre.com.br/MLB-987654321-teste',
  });
  const job = platform.claimJob();
  platform.completeJob(job.id, { error: 'Preço ambíguo', code: 'source_browser_price_ambiguous' });
  assert.equal(
    platform.status().connections.find((c) => c.marketplace === 'mercadolivre').state,
    'ready',
  );
  assert.equal(platform.claimJob().kind, 'product');
});
test('oferta de navegador exige atualização antes do transporte e só então chega à política', async (t) => {
  const { platform, store, policy } = fixture(t);
  const observation = {
    productUrl: 'https://produto.mercadolivre.com.br/MLB-123456789-test',
    title: 'Produto',
    priceCents: 10000,
    stockStatus: 'available',
    priceCondition: 'À vista',
    observedAt: new Date(NOW).toISOString(),
    affiliateUrl: 'https://meli.la/auto',
    affiliateObserved: true,
  };
  const id = platform.validateConnection('mercadolivre', observation.productUrl);
  platform.claimJob();
  platform.completeJob(id, { observation });
  const offer = store.listOffers()[0],
    batch = platform.batchPreview(selection(offer));
  platform.approveBatch({ ...batch, confirmed: true });
  let job = store.nextDelivery();
  let checked = await platform.preflight(job);
  assert.equal(checked.allowed, false);
  assert.match(checked.reason, /Atualizando/);
  const refresh = platform.claimJob();
  assert.equal(refresh.kind, 'refresh');
  platform.completeJob(refresh.id, { observation: { ...observation, priceCents: 9000 } });
  job = store.nextDelivery();
  checked = await platform.preflight(job);
  assert.equal(checked.allowed, true);
  assert.equal(store.getOffer(offer.id).price_cents, 9000);
  assert.equal(policy.ready(store.getOffer(offer.id), '123@g.us').allowed, true);
});

test('aumento ou condição diferente cancela aprovações e devolve o preço atual para nova revisão', (t) => {
  for (const change of [{ priceCents: 11000 }, { priceCondition: 'Pix' }]) {
    const { platform, store } = fixture(t);
    const observation = {
      productUrl: 'https://produto.mercadolivre.com.br/MLB-123456789-test',
      title: 'Produto',
      priceCents: 10000,
      stockStatus: 'available',
      priceCondition: 'À vista',
      observedAt: new Date(NOW).toISOString(),
      affiliateUrl: 'https://meli.la/auto',
      affiliateObserved: true,
    };
    const id = platform.validateConnection('mercadolivre', observation.productUrl);
    platform.claimJob();
    platform.completeJob(id, { observation });
    const offer = store.listOffers()[0],
      batch = platform.batchPreview(selection(offer));
    platform.approveBatch({ ...batch, confirmed: true });
    const delivery = store.listDeliveries()[0];
    const refreshId = platform.addJob(
      'mercadolivre',
      'refresh',
      { productUrl: observation.productUrl },
      { deliveryId: delivery.id },
    );
    platform.claimJob();
    platform.completeJob(refreshId, { observation: { ...observation, ...change } });
    assert.equal(
      store.listDeliveries().every((d) => d.state === 'cancelled'),
      true,
    );
    const item = platform.reviewItems().find((i) => i.id === offer.id);
    assert.equal(item.ready, true);
    assert.equal(item.priceCents, change.priceCents || 10000);
    if (change.priceCondition) assert.match(item.message, /Pix/);
  }
});
test('alterar regras cancela apenas a fila do grupo afetado; salvar sem mudanças preserva aprovação', (t) => {
  const { platform, store, create } = fixture(t),
    batch = platform.batchPreview(selection(create()));
  platform.approveBatch({ ...batch, confirmed: true });
  platform.saveGroup({ id: '123@g.us' }, GROUPS);
  assert.equal(store.queueStats().queued, 2);
  platform.saveGroup({ id: '123@g.us', intervalMinutes: 10 }, GROUPS);
  assert.equal(store.listDeliveries().find((d) => d.destination === '123@g.us').state, 'cancelled');
  assert.equal(store.listDeliveries().find((d) => d.destination === '456@g.us').state, 'queued');
});
test('preço enviado fica preservado por destino mesmo que a oferta mude depois', (t) => {
  const { store, create } = fixture(t),
    offer = create();
  const delivery = store.enqueue(offer.id, '123@g.us');
  store.markSent(delivery.id, offer.id);
  store.db
    .prepare('UPDATE offers SET final_price_cents=5000,price_cents=5000 WHERE id=?')
    .run(offer.id);
  assert.equal(
    store.lastPublication(offer.product_key, offer.variant, '123@g.us', 'mercadolivre')
      .final_price_cents,
    10000,
  );
});

test('Amazon e Shopee usam a mesma revisão, mantendo identidade e vínculo da própria loja', (t) => {
  for (const [marketplace, productUrl, affiliateUrl] of [
    [
      'amazon',
      'https://www.amazon.com.br/dp/B012345678',
      'https://www.amazon.com.br/dp/B012345678?tag=fixture-20',
    ],
    ['shopee', 'https://shopee.com.br/product/123/456', 'https://s.shopee.com.br/fixture'],
  ]) {
    const { platform, store } = fixture(t),
      observation = {
        title: 'Produto de teste',
        productUrl,
        affiliateUrl,
        priceCents: 9990,
        stockStatus: 'available',
        priceCondition: 'À vista',
        observedAt: new Date(NOW).toISOString(),
        affiliateObserved: true,
      };
    const id = platform.validateConnection(marketplace, productUrl);
    platform.claimJob();
    platform.completeJob(id, { observation });
    const item = platform.reviewItems()[0];
    assert.equal(item.marketplace, marketplace);
    assert.equal(item.ready, true);
    platform.approveBatch({
      ...platform.batchPreview(selection(store.getOffer(item.id))),
      confirmed: true,
    });
    assert.equal(store.listDeliveries().length, 2);
  }
});
