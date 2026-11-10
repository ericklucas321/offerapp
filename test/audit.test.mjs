import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/infrastructure/repository.mjs';
import { Offers } from '../src/application/offers.mjs';
import { Platform } from '../src/application/platform.mjs';
import { PublicationPolicy, nextPublicationAt } from '../src/domain/publication.mjs';
import { publicationWindow } from '../src/domain/rules.mjs';
import { createQueueWorker } from '../src/jobs/queue.mjs';
import { normalizeOfferInput } from '../src/domain/messages.mjs';
const NOW = Date.parse('2026-10-05T15:00:00Z');
const url = 'https://produto.mercadolivre.com.br/MLB-123456789-test';
function setup(t) {
  const store = new Store({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'offer-audit-')) });
  t.after(() => store.close());
  store.saveDestination('123@g.us', 'Grupo de teste');
  store.setSetting('publication_paused', 'false');
  let now = NOW;
  const policy = new PublicationPolicy({ store, now: () => now }),
    offers = new Offers({ store, policy, now: () => now }),
    platform = new Platform({ store, offers, policy, now: () => now });
  const input = {
    title: 'Produto de teste',
    productUrl: url,
    price: 100,
    affiliateUrl: 'https://meli.la/audit',
    affiliateConfirmed: true,
    availableConfirmed: true,
  };
  const observation = {
    ...input,
    priceCents: 10000,
    stockStatus: 'available',
    priceCondition: 'À vista',
    observedAt: new Date(NOW).toISOString(),
    affiliateObserved: true,
  };
  const create = (changes = {}) => offers.manual({ ...input, ...changes });
  const browser = () => {
    const id = platform.validateConnection('mercadolivre', url);
    platform.claimJob();
    platform.completeJob(id, { observation });
    return store.listOffers()[0];
  };
  const select = (...rows) => rows.map((o) => ({ offerId: o.id, groupIds: ['123@g.us'] }));
  return {
    store,
    offers,
    policy,
    platform,
    input,
    observation,
    create,
    browser,
    select,
    setNow: (v) => (now = v),
  };
}
test('auditoria: descartar após a prévia impede aprovação do lote', (t) => {
  const { platform, create, select, store } = setup(t),
    offer = create(),
    batch = platform.batchPreview(select(offer));
  platform.discard({ offerId: offer.id });
  assert.throws(() => platform.approveBatch({ ...batch, confirmed: true }));
  assert.equal(store.queueStats().queued, 0);
});
test('auditoria: duas versões do mesmo produto no mesmo lote não criam bloqueio mútuo', (t) => {
  const { platform, create, select, store } = setup(t),
    a = create(),
    b = create({ price: 90 });
  assert.throws(() => platform.batchPreview(select(a, b)), /publication_duplicate_product/);
  assert.equal(store.queueStats().queued, 0);
});
test('auditoria: fila pode reservar datas além de três dias sem teto diário', (t) => {
  const { platform, select, store, observation } = setup(t);
  platform.saveGroup({ id: '123@g.us', startMinute: 0, endMinute: 0, intervalMinutes: 1440 }, [
    { id: '123@g.us', name: 'Grupo' },
  ]);
  const offers = Array.from({ length: 5 }, (_, i) => {
    const productUrl = `https://produto.mercadolivre.com.br/MLB-${123456781 + i}-test`;
    const id = platform.validateConnection('mercadolivre', productUrl);
    platform.claimJob();
    platform.completeJob(id, { observation: { ...observation, productUrl } });
    return store.listOffers()[0];
  });
  const batch = platform.batchPreview(select(...offers));
  platform.approveBatch({ ...batch, confirmed: true });
  assert.equal(store.queueStats().queued, 5);
});
test('auditoria: preço registrado é o da mensagem, mesmo com atualização durante transporte', async (t) => {
  const { platform, create, select, store } = setup(t),
    offer = create();
  platform.approveBatch({ ...platform.batchPreview(select(offer)), confirmed: true });
  const worker = createQueueWorker({
    store,
    preflight: (j) => platform.preflight(j),
    publisher: {
      send: async () => {
        store.db
          .prepare('UPDATE offers SET price_cents=5000,final_price_cents=5000 WHERE id=?')
          .run(offer.id);
      },
    },
  });
  await worker.tick();
  const d = store.listDeliveries()[0];
  assert.match(d.sent_message, /100,00/);
  assert.equal(d.sent_price_cents, 10000);
});
test('auditoria: atualização é vinculada ao envio original, mesmo existindo oferta mais nova', (t) => {
  const { platform, browser, select, store, observation, input } = setup(t),
    offer = browser();
  platform.approveBatch({ ...platform.batchPreview(select(offer)), confirmed: true });
  const newer = store.createOffer({ ...input, price: 90 });
  store.setOfferEvidence(newer.id, {
    source: 'browser',
    verifiedAt: observation.observedAt,
    stockStatus: 'available',
  });
  const delivery = store.listDeliveries()[0],
    id = platform.addJob(
      'mercadolivre',
      'refresh',
      { productUrl: url },
      { deliveryId: delivery.id },
    );
  platform.claimJob();
  assert.doesNotThrow(() => platform.completeJob(id, { observation }));
});
test('auditoria: repetição de resultado após perda da resposta é idempotente', (t) => {
  const { platform, observation } = setup(t),
    id = platform.validateConnection('mercadolivre', url);
  platform.claimJob();
  platform.completeJob(id, { observation });
  assert.doesNotThrow(() => platform.completeJob(id, { observation }));
  assert.throws(() => platform.completeJob(id, { observation: { ...observation, priceCents: 1 } }));
});
test('auditoria: suspender loja cancela leituras de produto ainda pendentes', (t) => {
  const { platform, store } = setup(t);
  store.db
    .prepare("UPDATE store_connections SET state='ready' WHERE marketplace='mercadolivre'")
    .run();
  const id = platform.addJob('mercadolivre', 'search', { keyword: 'teste' });
  platform.addJob('mercadolivre', 'product', { productUrl: url });
  platform.claimJob();
  platform.completeJob(id, {
    error: 'Verificação necessária',
    code: 'store_verification_required',
  });
  assert.equal(platform.claimJob(), null);
});
test('auditoria: captura antiga de vitrine não esconde oferta automática pronta', (t) => {
  const { platform, offers, browser } = setup(t);
  offers.capture(
    {
      version: 1,
      items: [
        {
          stage: 'card',
          productKey: 'MLB123456789',
          variant: '',
          title: 'Vitrine antiga',
          productUrl: url,
          imageUrl: '',
          priceCents: 10000,
          available: false,
          priceCondition: 'Preço à vista anunciado',
          observedAt: new Date(NOW).toISOString(),
        },
      ],
    },
    true,
  );
  const offer = browser(),
    item = platform.reviewItems()[0];
  assert.equal(item.id, offer.id);
  assert.equal(item.ready, true);
});
test('auditoria: autenticação rejeita caracteres multibyte sem lançar exceção', (t) => {
  const { platform } = setup(t);
  platform.pair('a'.repeat(32));
  assert.equal(platform.authenticate('ç'.repeat(64)), false);
});
test('auditoria: histórico de horário inválido bloqueia publicação', () => {
  assert.equal(publicationWindow([{ sent_at: 'inválido' }], NOW).allowed, false);
  assert.throws(() => nextPublicationAt([{ sent_at: 'inválido' }], NOW), /invalid_schedule/);
});
test('auditoria: imagem local ou de domínio externo não pode ser buscada pelo transporte', (t) => {
  const { input } = setup(t);
  for (const imageUrl of [
    'http://127.0.0.1/private',
    'https://localhost/private',
    'https://evil.example/pixel',
  ])
    assert.throws(() => normalizeOfferInput({ ...input, imageUrl }), /invalid_image_url/);
});

test('auditoria: verificação final bloqueia mudança durante preflight assíncrono', async (t) => {
  const { platform, policy, store, create, select } = setup(t),
    offer = create();
  platform.approveBatch({ ...platform.batchPreview(select(offer)), confirmed: true });
  let sends = 0;
  const worker = createQueueWorker({
    store,
    publisher: { send: async () => sends++ },
    preflight: async (job) => {
      const result = policy.preflight(job);
      store.db.prepare("UPDATE destination_groups SET enabled=0 WHERE id='123@g.us'").run();
      return result;
    },
    finalCheck: (j) => policy.preflight(j),
  });
  await worker.tick();
  assert.equal(sends, 0);
  assert.equal(store.listDeliveries()[0].state, 'cancelled');
});
test('auditoria: parar executor durante consulta aguarda encerramento e não inicia transporte', async (t) => {
  const { platform, store, create, select } = setup(t);
  platform.approveBatch({ ...platform.batchPreview(select(create())), confirmed: true });
  let release,
    sends = 0;
  const gate = new Promise((resolve) => (release = resolve)),
    worker = createQueueWorker({
      store,
      publisher: { send: async () => sends++ },
      preflight: async () => {
        await gate;
        return { allowed: true };
      },
    });
  const tick = worker.tick(),
    stopped = worker.stop();
  release();
  await Promise.all([tick, stopped]);
  assert.equal(sends, 0);
  assert.equal(store.queueStats().queued, 1);
});

test('auditoria: dados novos não sobrescrevem observação mais recente', (t) => {
  const { platform, browser, observation, setNow, store } = setup(t);
  browser();
  setNow(NOW + 30000);
  const id = platform.validateConnection('mercadolivre', url);
  platform.claimJob();
  platform.completeJob(id, {
    observation: {
      ...observation,
      observedAt: new Date(NOW + 30000).toISOString(),
      priceCents: 9000,
    },
  });
  const stale = platform.validateConnection('mercadolivre', url);
  platform.claimJob();
  assert.throws(() => platform.completeJob(stale, { observation }), /browser_import_stale/);
  assert.equal(store.evidenceFor(store.listOffers()[0]).price_cents, 9000);
});
test('auditoria: atualizar tema descarta trabalhos antigos sem suspender a conta', (t) => {
  const { platform, store } = setup(t);
  platform.saveTopic({
    name: 'Tema',
    keywords: ['teste'],
    stores: ['mercadolivre'],
    groupIds: ['123@g.us'],
  });
  store.db
    .prepare("UPDATE store_connections SET state='ready' WHERE marketplace='mercadolivre'")
    .run();
  const id = platform.addJob('mercadolivre', 'product', { productUrl: url }, { topicId: 1 });
  platform.claimJob();
  platform.saveTopic({
    id: 1,
    name: 'Tema',
    keywords: ['novo'],
    stores: ['mercadolivre'],
    groupIds: ['123@g.us'],
    enabled: false,
  });
  platform.completeJob(id, { error: 'Resposta de trabalho cancelado' });
  assert.equal(store.listOffers().length, 0);
  assert.equal(platform.status().connections[0].state, 'ready');
});
test('auditoria: observação automática convive com manual sem perder origem', (t) => {
  const { create, browser, platform, store } = setup(t),
    manual = create(),
    automatic = browser();
  assert.notEqual(manual.id, automatic.id);
  assert.equal(automatic.source, 'browser');
  assert.equal(platform.reviewItems()[0].id, automatic.id);
  assert.equal(store.getOffer(manual.id).source, 'manual');
});
test('auditoria: queda adicional de 10% permite nova sugestão antes de 72 horas', (t) => {
  const { platform, browser, store, observation, setNow } = setup(t),
    offer = browser(),
    d = store.enqueue(offer.id, '123@g.us');
  store.markSent(d.id, offer.id);
  setNow(Date.now() + 1000);
  const id = platform.validateConnection('mercadolivre', url);
  platform.claimJob();
  platform.completeJob(id, {
    observation: {
      ...observation,
      observedAt: new Date(Date.now()).toISOString(),
      priceCents: 9000,
    },
  });
  const latest = store.listOffers()[0];
  assert.notEqual(latest.id, offer.id);
  assert.equal(latest.price_cents, 9000);
});
test('auditoria: atualizar captura conserva cálculo de cupom da oferta', (t) => {
  const { store, create } = setup(t),
    offer = create({ coupon: 'TESTE', couponRules: { type: 'percent', value: 10 } });
  const updated = store.updateCapturePrice(offer.id, {
    stage: 'product',
    available: true,
    stock_status: 'available',
    price_cents: 9000,
    observed_at: new Date(NOW).toISOString(),
  });
  assert.equal(updated.final_price_cents, 8100);
});
test('auditoria: paginação permite conferir e cancelar envios anteriores aos últimos 200', (t) => {
  const { store, create } = setup(t),
    offer = create();
  const insert = store.db.prepare(
    "INSERT INTO deliveries(offer_id,destination,state,attempts,next_attempt_at,scheduled_at,mode) VALUES(?,'123@g.us','queued',0,?,?,'approved')",
  );
  for (let i = 0; i < 225; i++)
    insert.run(offer.id, new Date(NOW).toISOString(), new Date(NOW).toISOString());
  let cursor = null,
    ids = [];
  do {
    const page = store.deliveryPage({ filter: 'active', before: cursor });
    ids.push(...page.deliveries.map((d) => d.id));
    cursor = page.pagination.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 225);
  assert.equal(new Set(ids).size, 225);
  assert.equal(store.cancelDelivery(Math.min(...ids)).state, 'cancelled');
});

test('auditoria: suspender loja bloqueia transporte mesmo após leitura recente concluída', async (t) => {
  const { platform, store, browser, select, observation, policy } = setup(t);
  const offer = browser();
  platform.approveBatch({ ...platform.batchPreview(select(offer)), confirmed: true });
  let job = store.nextDelivery();
  assert.equal((await platform.preflight(job)).allowed, false);
  const refresh = platform.claimJob();
  platform.completeJob(refresh.id, { observation });
  job = store.nextDelivery();
  assert.equal((await platform.preflight(job)).allowed, true);
  platform.suspendStore('mercadolivre', 'Ferramenta afiliada indisponível');
  assert.equal((await platform.preflight(job)).allowed, false);
  assert.equal(policy.preflight(job).allowed, false);
  assert.equal(store.queueStats().queued, 1);
});
