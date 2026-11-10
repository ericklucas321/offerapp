import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/infrastructure/repository.mjs';
import { Offers } from '../src/application/offers.mjs';
import { PublicationPolicy } from '../src/domain/publication.mjs';
import { createQueueWorker } from '../src/jobs/queue.mjs';
import { snapshotFromDocument } from '../src/shared/market-parser.mjs';
import { publicationWindow, evaluateCandidate, repeatAllowed } from '../src/domain/rules.mjs';
import { captureStock, validateBrowserCapture } from '../src/shared/capture-contract.mjs';
const NOW = Date.parse('2026-10-04T15:00:00Z');
const ITEM = {
  stage: 'product',
  productKey: 'MLB123456789',
  variant: '500 ml',
  title: 'Cera de teste isolado',
  productUrl: 'https://produto.mercadolivre.com.br/MLB-123456789-teste',
  imageUrl: 'https://http2.mlstatic.com/test.jpg',
  priceCents: 6990,
  available: true,
  priceCondition: 'Preço à vista anunciado',
  observedAt: new Date(NOW).toISOString(),
};
const BIND = { affiliateUrl: 'https://meli.la/fixture', affiliateConfirmed: true };
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-operations-'));
  const store = new Store({ dataDir: dir });
  t.after(() => store.close());
  store.setSetting('publication_paused', 'true');
  store.saveDestination('123@g.us', 'Fixture');
  const policy = new PublicationPolicy({ store, now: () => NOW }),
    offers = new Offers({ store, policy, now: () => NOW });
  return { store, policy, offers, dir };
}
function approve(offers, id, options = {}) {
  return offers.publish(id, { reviewToken: offers.preview(id).reviewToken, ...options });
}
function prepare(t) {
  const x = setup(t);
  x.offers.capture({ version: 1, items: [ITEM] }, true);
  x.capture = x.store.captures()[0];
  x.offer = x.offers.prepare(x.capture.id, BIND);
  return x;
}
test('captura exige confirmação e contrato, sem criar oferta ou publicação', (t) => {
  const { store, offers } = setup(t);
  assert.throws(
    () => offers.capture({ version: 1, items: [ITEM] }, false),
    /browser_import_confirmation/,
  );
  offers.capture({ version: 1, items: [ITEM] }, true);
  assert.equal(offers.list().length, 1);
  assert.equal(store.listOffers().length, 0);
  assert.equal(store.listDeliveries().length, 0);
  assert.equal(store.setting('publication_paused'), 'true');
  assert.throws(() =>
    validateBrowserCapture(
      { version: 1, items: [{ ...ITEM, productUrl: 'https://evil.example/item' }] },
      NOW,
    ),
  );
  assert.throws(() =>
    validateBrowserCapture({ version: 1, items: [{ ...ITEM, priceCents: 1.5 }] }, NOW),
  );
  assert.throws(() => validateBrowserCapture({ version: 1, items: Array(21).fill(ITEM) }, NOW));
});
test('card tem estoque desconhecido, não pode preparar oferta e não substitui produto confirmado', (t) => {
  const { store, offers } = setup(t);
  offers.capture({ version: 1, items: [{ ...ITEM, stage: 'card' }] }, true);
  assert.equal(offers.list()[0].stock, 'unknown');
  assert.throws(
    () => offers.prepare(store.captures()[0].id, BIND),
    /browser_import_product_required/,
  );
  offers.capture({ version: 1, items: [ITEM] }, true);
  offers.capture({ version: 1, items: [{ ...ITEM, stage: 'card' }] }, true);
  assert.equal(store.captures()[0].stage, 'product');
  assert.equal(offers.list().length, 1);
});
test('captura prepara mensagem e preserva origem; outra rota não pode trocar origem para manual', (t) => {
  const { store, offers, offer, capture } = prepare(t);
  assert.equal(offer.source, 'extension');
  assert.equal(offer.capture_id, capture.id);
  assert.match(store.messageFor(offer), /69,90/);
  assert.equal(offers.list().length, 1);
  assert.equal(offers.list()[0].state, 'ready');
  assert.throws(
    () =>
      offers.manual(
        {
          ...BIND,
          title: 'Bypass',
          price: 1,
          productUrl: ITEM.productUrl,
          availableConfirmed: true,
        },
        offer.id,
      ),
    /offer_identity_locked/,
  );
  assert.equal(store.listDeliveries().length, 0);
});
test('pausa, revisão, estoque e dados antigos bloqueiam aprovação por qualquer entrada', (t) => {
  const { store, offers, offer, capture } = prepare(t);
  assert.throws(() => approve(offers, offer.id, { confirmed: true }), /publication_paused/);
  store.setSetting('publication_paused', 'false');
  assert.throws(() => approve(offers, offer.id, {}), /publication_confirmation_required/);
  store.db
    .prepare('UPDATE browser_import_drafts SET observed_at=? WHERE id=?')
    .run(new Date(NOW - 900001).toISOString(), capture.id);
  assert.throws(() => approve(offers, offer.id, { confirmed: true }), /publication_not_ready/);
  store.db
    .prepare('UPDATE browser_import_drafts SET observed_at=?,available=0 WHERE id=?')
    .run(new Date(NOW).toISOString(), capture.id);
  assert.throws(() => approve(offers, offer.id, { confirmed: true }), /publication_not_ready/);
  assert.equal(store.listDeliveries().length, 0);
});
test('aprovação e execução usam a política única, não duplicam e guardam mensagem', async (t) => {
  const { store, offers, policy, offer } = prepare(t);
  store.setSetting('publication_paused', 'false');
  const job = approve(offers, offer.id, { confirmed: true });
  assert.equal(approve(offers, offer.id, { confirmed: true }).id, job.id);
  let sends = 0;
  const worker = createQueueWorker({
    store,
    publisher: { isReady: () => true, send: async () => sends++ },
    preflight: (job) => policy.preflight(job),
  });
  await Promise.all([worker.tick(), worker.tick()]);
  assert.equal(sends, 1);
  assert.equal(store.listDeliveries()[0].state, 'sent');
  assert.match(store.listDeliveries()[0].sent_message, /69,90/);
  assert.ok(store.listDeliveries()[0].approved_message);
  await worker.tick();
  assert.equal(sends, 1);
});
test('aumento cancela agendamento, redução revalida e atualiza mensagem, estoque bloqueia', async (t) => {
  for (const [price, available, expected] of [
    [7990, true, 'cancelled'],
    [5990, true, 'sent'],
    [5990, false, 'queued'],
  ]) {
    const { store, offers, policy, offer } = prepare(t);
    store.setSetting('publication_paused', 'false');
    approve(offers, offer.id, { confirmed: true });
    offers.now = () => NOW + 1;
    offers.capture(
      {
        version: 1,
        items: [
          { ...ITEM, priceCents: price, available, observedAt: new Date(NOW + 1).toISOString() },
        ],
      },
      true,
    );
    policy.now = () => NOW + 1;
    let sends = 0;
    const worker = createQueueWorker({
      store,
      publisher: { isReady: () => true, send: async () => sends++ },
      preflight: (job) => policy.preflight(job),
    });
    await worker.tick();
    assert.equal(store.listDeliveries()[0].state, expected);
    assert.equal(sends, expected === 'sent' ? 1 : 0);
    if (expected === 'sent') assert.match(store.listDeliveries()[0].sent_message, /59,90/);
  }
});
test('mudança de condição, grupo ou mensagem cancela aprovação', (t) => {
  for (const kind of ['condition', 'destination', 'message']) {
    const { store, offers, policy, offer, capture } = prepare(t);
    store.setSetting('publication_paused', 'false');
    approve(offers, offer.id, { confirmed: true });
    if (kind === 'condition')
      store.db
        .prepare("UPDATE browser_import_drafts SET price_condition='Pix' WHERE id=?")
        .run(capture.id);
    if (kind === 'destination') store.saveDestination('456@g.us', 'Outro');
    if (kind === 'message')
      store.db.prepare("UPDATE offers SET title='Alterado' WHERE id=?").run(offer.id);
    assert.equal(policy.preflight(store.nextDelivery()).allowed, false);
    assert.equal(store.listDeliveries()[0].state, 'cancelled');
  }
});
test('resultado incerto não repete nem permite criar envio paralelo para o mesmo produto', async (t) => {
  const { store, offers, policy, offer } = prepare(t);
  store.setSetting('publication_paused', 'false');
  approve(offers, offer.id, { confirmed: true });
  let sends = 0;
  const worker = createQueueWorker({
    store,
    publisher: {
      send: async () => {
        sends++;
        throw new Error('timeout');
      },
    },
    preflight: (job) => policy.preflight(job),
    logger: { error() {} },
  });
  await worker.tick();
  await worker.tick();
  assert.equal(sends, 1);
  assert.equal(store.listDeliveries()[0].state, 'uncertain');
  assert.throws(() => approve(offers, offer.id, { confirmed: true }), /publication_not_ready/);
  assert.throws(
    () => store.retryUncertain(store.listDeliveries()[0].id, false),
    /delivery_confirmation_required/,
  );
});
test('cadastro manual requer confirmação de dados e rejeita link afiliado de outra loja', (t) => {
  const { store, offers } = setup(t);
  let offer = offers.manual({ ...BIND, productUrl: ITEM.productUrl, title: 'Manual', price: 10 });
  store.setSetting('publication_paused', 'false');
  assert.throws(() => approve(offers, offer.id, { confirmed: true }), /publication_not_ready/);
  offer = offers.manual(
    { ...BIND, productUrl: ITEM.productUrl, title: 'Manual', price: 10, availableConfirmed: true },
    offer.id,
  );
  assert.equal(approve(offers, offer.id, { confirmed: true }).state, 'queued');
  assert.throws(
    () =>
      offers.manual({
        ...BIND,
        productUrl: 'https://amazon.com.br/dp/B012345678',
        title: 'Outro',
        price: 10,
      }),
    /invalid_affiliate_domain/,
  );
});
test('janela de Brasília, intervalo, repetição e histórico continuam obrigatórios sem teto diário', () => {
  assert.equal(publicationWindow([], Date.parse('2026-10-04T10:59:00Z')).allowed, false);
  assert.equal(publicationWindow([], Date.parse('2026-10-05T01:00:00Z')).allowed, false);
  assert.equal(
    publicationWindow(Array(12).fill({ sent_at: new Date(NOW - 3600001).toISOString() }), NOW)
      .allowed,
    true,
  );
  assert.equal(
    publicationWindow([{ sent_at: new Date(NOW - 1000).toISOString() }], NOW).allowed,
    false,
  );
  const last = { sent_at: new Date(NOW - 1000).toISOString(), final_price_cents: 10000 };
  assert.equal(repeatAllowed(last, 9100, NOW), false);
  assert.equal(repeatAllowed(last, 9000, NOW), true);
  const c = {
    available: 1,
    observed_at: new Date(NOW).toISOString(),
    price_cents: 8500,
    affiliate_url: BIND.affiliateUrl,
    affiliate_confirmed: 1,
  };
  assert.equal(evaluateCandidate(c, [], NOW).eligible, false);
  const hist = Array.from({ length: 5 }, (_, i) => ({
    observed_at: new Date(NOW - 86400001 - i * 21600000).toISOString(),
    price_cents: 10000,
  }));
  assert.equal(evaluateCandidate(c, hist, NOW).eligible, true);
});

test('oferta antiga sem imagem aparece junto das capturas sem duplicar o produto', (t) => {
  const { store, offers } = setup(t);
  const offer = store.createOffer({
    ...BIND,
    productUrl: ITEM.productUrl,
    title: 'Manual anterior',
    variant: ITEM.variant,
    price: 69.9,
  });
  store.db
    .prepare("UPDATE offers SET status='published',published_at=? WHERE id=?")
    .run(new Date(NOW - 86400000).toISOString(), offer.id);
  assert.equal(offers.list().length, 1);
  assert.equal(offers.list()[0].imageUrl, '');
  offers.capture({ version: 1, items: [{ ...ITEM, stage: 'card' }] }, true);
  assert.equal(offers.list().length, 1);
});

test('executor exige política; preço que envelhece na fila não chega ao transporte', async (t) => {
  assert.throws(
    () => createQueueWorker({ store: {}, publisher: {} }),
    /publication_policy_required/,
  );
  const { store, offers, policy, offer } = prepare(t);
  store.setSetting('publication_paused', 'false');
  approve(offers, offer.id, { confirmed: true });
  policy.now = () => NOW + 900001;
  let sends = 0;
  const worker = createQueueWorker({
    store,
    publisher: { send: async () => sends++ },
    preflight: (job) => policy.preflight(job),
  });
  await worker.tick();
  assert.equal(sends, 0);
  assert.equal(store.listDeliveries()[0].state, 'queued');
  assert.match(store.listDeliveries()[0].last_error, /Preço antigo/);
});

test('pausa durante revalidação impede início do transporte', async (t) => {
  const { store, offers, policy, offer } = prepare(t);
  store.setSetting('publication_paused', 'false');
  approve(offers, offer.id, { confirmed: true });
  let sends = 0;
  const worker = createQueueWorker({
    store,
    publisher: { send: async () => sends++ },
    preflight: async (job) => {
      const result = policy.preflight(job);
      store.setSetting('publication_paused', 'true');
      return result;
    },
  });
  await worker.tick();
  assert.equal(sends, 0);
  assert.equal(store.listDeliveries()[0].state, 'queued');
});

test('reinício preserva captura, vínculo, aprovação, grupo e agendamento', (t) => {
  const { store, offers, offer, dir, capture } = prepare(t);
  store.setSetting('publication_paused', 'false');
  const job = approve(offers, offer.id, {
    confirmed: true,
    scheduledAt: new Date(NOW + 600000).toISOString(),
  });
  // A second connection simulates startup against the persisted database without touching a user session.
  const restarted = new Store({ dataDir: dir });
  t.after(() => restarted.close());
  assert.equal(restarted.getOffer(offer.id).capture_id, capture.id);
  assert.equal(restarted.capture(capture.id).offer_id, offer.id);
  const saved = restarted.deliveryDetails()[0];
  assert.equal(saved.id, job.id);
  assert.equal(saved.approved_message, job.approved_message);
  assert.equal(saved.next_attempt_at, job.next_attempt_at);
  assert.equal(saved.state, 'queued');
  assert.equal(restarted.setting('whatsapp_group_id'), '123@g.us');
  assert.equal(restarted.db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 4);
  assert.equal(restarted.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('captura distingue estoque disponível, indisponível e desconhecido sem inventar falta de estoque', (t) => {
  for (const [stockStatus, available] of [
    ['available', true],
    ['unavailable', false],
    ['unknown', false],
  ]) {
    const { store, offers } = setup(t);
    offers.capture({ version: 1, items: [{ ...ITEM, available, stockStatus }] }, true);
    assert.equal(offers.list()[0].stock, stockStatus);
    assert.equal(captureStock(store.captures()[0]), stockStatus);
    if (stockStatus !== 'available')
      assert.throws(
        () => offers.prepare(store.captures()[0].id, BIND),
        /browser_import_unavailable/,
      );
  }
  const { store, offers } = setup(t);
  offers.capture({ version: 1, items: [{ ...ITEM, available: false }] }, true);
  assert.equal(offers.list()[0].stock, 'unknown');
  assert.match(offers.list()[0].reason, /desconhecido/);
  assert.throws(
    () => offers.capture({ version: 1, items: [{ ...ITEM, stockStatus: 'unknown' }] }, true),
    /browser_import_invalid/,
  );
  assert.equal(store.listOffers().length, 0);
});

test('parser só afirma indisponibilidade quando observou evidência explícita', () => {
  const doc = {
    url: ITEM.productUrl,
    identityIds: [],
    schemas: [],
    title: ITEM.title,
    prices: [{ currency: 'R$', fraction: '69', cents: '90' }],
    priceContext: '',
    hasVariants: false,
    variants: [],
    variationId: '',
    stock: false,
    buyEnabled: true,
    image: '',
  };
  assert.equal(snapshotFromDocument(doc, ITEM.productUrl, NOW).stockStatus, 'unknown');
  assert.equal(
    snapshotFromDocument({ ...doc, stockUnavailable: true }, ITEM.productUrl, NOW).stockStatus,
    'unavailable',
  );
  assert.equal(
    snapshotFromDocument({ ...doc, stock: true }, ITEM.productUrl, NOW).stockStatus,
    'available',
  );
});

test('atualizar captura não antecipa horário aprovado e preserva o horário após reinício', (t) => {
  const { store, offers, offer, dir } = prepare(t);
  store.setSetting('publication_paused', 'false');
  const future = Date.now() + 2 * 86400000;
  const job = approve(offers, offer.id, {
    confirmed: true,
    scheduledAt: new Date(future).toISOString(),
  });
  offers.capture({ version: 1, items: [ITEM] }, true);
  const updated = store.deliveryDetails()[0];
  assert.equal(updated.scheduled_at, job.next_attempt_at);
  assert.equal(updated.next_attempt_at, job.next_attempt_at);
  assert.equal(store.nextDelivery(), undefined);
  store.db.prepare("UPDATE deliveries SET next_attempt_at='2000-01-01' WHERE id=?").run(job.id);
  assert.equal(store.nextDelivery(), undefined);
  const restarted = new Store({ dataDir: dir });
  t.after(() => restarted.close());
  assert.equal(restarted.deliveryDetails()[0].scheduled_at, job.next_attempt_at);
  assert.equal(restarted.nextDelivery(), undefined);
});

test('migração de estoque e horário preserva IDs, vínculo e dados do formato anterior', (t) => {
  const { store, offers, offer, capture, dir } = prepare(t);
  store.setSetting('publication_paused', 'false');
  const job = approve(offers, offer.id, { confirmed: true });
  store.db.exec(
    'ALTER TABLE browser_import_drafts DROP COLUMN stock_status; ALTER TABLE deliveries DROP COLUMN scheduled_at; DELETE FROM schema_migrations WHERE version=2',
  );
  store.db.prepare('UPDATE browser_import_drafts SET available=0 WHERE id=?').run(capture.id);
  const restarted = new Store({ dataDir: dir });
  t.after(() => restarted.close());
  assert.equal(restarted.capture(capture.id).stock_status, 'unknown');
  assert.equal(restarted.capture(capture.id).offer_id, offer.id);
  assert.equal(restarted.deliveryDetails()[0].id, job.id);
  assert.equal(restarted.deliveryDetails()[0].scheduled_at, job.next_attempt_at);
  assert.equal(restarted.getOffer(offer.id).stock_status, 'unknown');
  assert.equal(restarted.deliveryDetails()[0].approved_message, job.approved_message);
});

test('falha de preparação anterior ao transporte permite tentativa segura sem marcar resultado incerto', async (t) => {
  const { store, offers, policy, offer } = prepare(t);
  store.setSetting('publication_paused', 'false');
  approve(offers, offer.id, { confirmed: true });
  store.messageFor = () => {
    throw new Error('message_preparation_failed');
  };
  let sends = 0;
  const worker = createQueueWorker({
    store,
    publisher: { send: async () => sends++ },
    preflight: (job) => policy.preflight(job),
    logger: { error() {} },
  });
  await worker.tick();
  assert.equal(sends, 0);
  assert.equal(store.listDeliveries()[0].state, 'queued');
  assert.equal(store.listDeliveries()[0].attempts, 1);
  assert.equal(store.listDeliveries()[0].sent_message, '');
});

test('aprovação exige a prévia atual; alterações entre revisão e clique exigem nova confirmação', (t) => {
  for (const kind of ['price', 'message', 'stock', 'destination']) {
    const { store, offers, offer, capture } = prepare(t);
    store.setSetting('publication_paused', 'false');
    const before = offers.preview(offer.id);
    if (kind === 'price')
      store.db.prepare('UPDATE offers SET price_cents=7990 WHERE id=?').run(offer.id);
    if (kind === 'message')
      store.db.prepare("UPDATE offers SET title='Título atualizado' WHERE id=?").run(offer.id);
    if (kind === 'stock')
      store.db
        .prepare("UPDATE browser_import_drafts SET available=0,stock_status='unknown' WHERE id=?")
        .run(capture.id);
    if (kind === 'destination') store.saveDestination('456@g.us', 'Outro');
    assert.throws(
      () => offers.publish(offer.id, { confirmed: true, reviewToken: before.reviewToken }),
      /publication_review_changed/,
    );
    assert.equal(store.listDeliveries().length, 0);
  }
  const { store, offers, offer } = prepare(t);
  store.setSetting('publication_paused', 'false');
  assert.throws(() => offers.publish(offer.id, { confirmed: true }), /publication_review_required/);
});
