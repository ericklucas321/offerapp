import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/infrastructure/repository.mjs';
import { Offers } from '../src/application/offers.mjs';
import { Platform } from '../src/application/platform.mjs';
import { PublicationPolicy } from '../src/domain/publication.mjs';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-capture-auto-'));
  const store = new Store({ dataDir: dir });
  t.after(() => {
    store.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const now = Date.now();
  const policy = new PublicationPolicy({ store, now: () => now });
  const offers = new Offers({ store, policy, now: () => now });
  const platform = new Platform({ store, offers, policy, now: () => now });
  store.setSetting('bridge_last_seen', String(now));
  store.setSetting('publication_paused', 'true');
  platform.saveGroup({ id: '123@g.us', startMinute: 0, endMinute: 0 }, [
    { id: '123@g.us', name: 'Teste' },
  ]);
  const card = (id = 123456789) => ({
    stage: 'card',
    productKey: 'MLB' + id,
    variant: '',
    title: 'Purificador de teste',
    productUrl: `https://produto.mercadolivre.com.br/MLB-${id}-teste`,
    imageUrl: 'https://http2.mlstatic.com/card.webp',
    priceCents: 60030,
    available: false,
    stockStatus: 'unknown',
    priceCondition: 'Preço anunciado',
    observedAt: new Date(now).toISOString(),
  });
  const capture = (id) => {
    const value = card(id);
    offers.capture({ version: 1, items: [value] }, true);
    return store.captures().find((c) => c.product_key === value.productKey);
  };
  const observation = (c) => ({
    productUrl: c.product_url,
    title: c.title,
    variant: 'Cor:Preto / Bivolt',
    imageUrl: 'https://http2.mlstatic.com/original.webp',
    priceCents: 59900,
    priceCondition: 'Pix',
    stockStatus: 'available',
    observedAt: new Date(now).toISOString(),
    affiliateUrl: 'https://meli.la/generated',
    affiliateObserved: true,
  });
  return { store, offers, platform, capture, observation };
}
test('vitrine passa pela leitura real e geração afiliada, sem link manual ou envio', (t) => {
  const { store, platform, capture, observation } = fixture(t);
  const c = capture();
  const id = platform.resolveCapture(c.id);
  assert.equal(platform.resolveCapture(c.id), id);
  assert.equal(platform.captureResolution(c.id).state, 'pending');
  const job = platform.claimJob();
  assert.equal(job.id, id);
  assert.equal(job.payload.captureId, c.id);
  platform.completeJob(id, { observation: observation(c) });
  const result = platform.captureResolution(c.id);
  assert.equal(result.state, 'done');
  assert.ok(result.offerId);
  assert.equal(platform.resolveCapture(c.id), id);
  const offer = store.getOffer(result.offerId);
  assert.equal(offer.source, 'browser');
  assert.equal(offer.affiliate_url, 'https://meli.la/generated');
  assert.equal(offer.price_cents, 59900);
  assert.equal(offer.capture_id, null);
  assert.equal(store.capture(c.id).offer_id, offer.id);
  const items = platform.reviewItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, offer.id);
  assert.equal(items[0].ready, true);
  assert.equal(store.listDeliveries().length, 0);
});
test('preparação deduplica a mesma captura sem trocar produtos de solicitações diferentes', (t) => {
  const { platform, capture } = fixture(t);
  const a = capture(123456781),
    b = capture(123456782);
  const first = platform.resolveCapture(a.id),
    second = platform.resolveCapture(b.id);
  assert.notEqual(first, second);
  assert.equal(platform.resolveCapture(a.id), first);
  assert.equal(platform.captureResolution(a.id).jobId, first);
  assert.equal(platform.captureResolution(b.id).jobId, second);
});
test('falha mantém captura pendente e permite nova tentativa sem publicar', (t) => {
  const { store, platform, capture } = fixture(t);
  const c = capture();
  const id = platform.resolveCapture(c.id);
  platform.claimJob();
  platform.completeJob(id, { error: 'Gerador indisponível' });
  assert.equal(platform.captureResolution(c.id).state, 'failed');
  assert.match(platform.captureResolution(c.id).error, /Gerador/);
  assert.equal(store.capture(c.id).offer_id, null);
  const next = platform.resolveCapture(c.id);
  assert.notEqual(next, id);
  assert.equal(store.listDeliveries().length, 0);
});
test('captura descartada durante processamento não reaparece como oferta', (t) => {
  const { store, platform, capture, observation } = fixture(t);
  const c = capture();
  const id = platform.resolveCapture(c.id);
  platform.claimJob();
  platform.discard({ captureId: c.id });
  platform.completeJob(id, { observation: observation(c) });
  assert.equal(platform.captureResolution(c.id).state, 'cancelled');
  assert.equal(store.listOffers().length, 0);
  assert.equal(platform.reviewItems().length, 0);
});
test('sem navegador conectado não inicia uma falsa geração automática', (t) => {
  const { store, platform, capture } = fixture(t);
  const c = capture();
  store.setSetting('bridge_last_seen', '0');
  assert.throws(() => platform.resolveCapture(c.id), /capture_browser_required/);
  assert.equal(store.prepare('SELECT count(*) AS n FROM browser_jobs').get().n, 0);
});

test('nova validação recupera captura cujo rascunho anterior foi descartado', (t) => {
  const { store, platform, capture, observation } = fixture(t);
  const c = capture();
  let job = platform.resolveCapture(c.id);
  platform.claimJob();
  platform.completeJob(job, { observation: observation(c) });
  const original = platform.captureResolution(c.id).offerId;
  platform.discard({ offerId: original });
  assert.equal(platform.captureResolution(c.id).needsRefresh, true);
  job = platform.resolveCapture(c.id);
  platform.claimJob();
  platform.completeJob(job, { observation: observation(c) });
  const result = platform.captureResolution(c.id);
  assert.notEqual(result.offerId, original);
  assert.equal(platform.reviewItems().length, 1);
});

test('nova geração guarda o link afiliado atual sem reaproveitar aprovação antiga', (t) => {
  const { store, platform, capture, observation } = fixture(t);
  const c = capture();
  let job = platform.resolveCapture(c.id);
  platform.claimJob();
  platform.completeJob(job, { observation: observation(c) });
  const id = platform.captureResolution(c.id).offerId;
  store.setSetting('publication_paused', 'false');
  platform.approveBatch({
    ...platform.batchPreview([{ offerId: id, groupIds: ['123@g.us'] }]),
    confirmed: true,
  });
  store
    .prepare("UPDATE store_connections SET state='attention' WHERE marketplace='mercadolivre'")
    .run();
  job = platform.resolveCapture(c.id);
  platform.claimJob();
  platform.completeJob(job, {
    observation: { ...observation(c), affiliateUrl: 'https://meli.la/current' },
  });
  assert.equal(store.getOffer(id).affiliate_url, 'https://meli.la/current');
  assert.equal(store.listDeliveries()[0].state, 'cancelled');
  assert.match(store.listDeliveries()[0].approved_message, /meli.la\/generated/);
});

test('resultado concluído com preço vencido pede nova leitura ao tentar novamente', (t) => {
  const { store, platform, capture, observation } = fixture(t);
  const c = capture();
  const job = platform.resolveCapture(c.id);
  platform.claimJob();
  platform.completeJob(job, { observation: observation(c) });
  store
    .prepare('UPDATE platform_observations SET observed_at=?')
    .run(new Date(Date.now() - 3600000).toISOString());
  assert.equal(platform.captureResolution(c.id).needsRefresh, true);
  assert.notEqual(platform.resolveCapture(c.id), job);
});

test('produto validado substitui também sua sugestão de vitrine sem variante confirmada', (t) => {
  const { store, offers, platform, capture, observation } = fixture(t);
  const card = capture();
  const observed = observation(card);
  offers.capture(
    {
      version: 1,
      items: [
        {
          stage: 'product',
          productKey: card.product_key,
          variant: observed.variant,
          title: observed.title,
          productUrl: observed.productUrl,
          imageUrl: observed.imageUrl,
          priceCents: observed.priceCents,
          available: true,
          stockStatus: 'available',
          priceCondition: observed.priceCondition,
          observedAt: observed.observedAt,
        },
      ],
    },
    true,
  );
  const product = store.captures().find((c) => c.stage === 'product');
  const job = platform.resolveCapture(product.id);
  platform.claimJob();
  platform.completeJob(job, { observation: observed });
  assert.equal(platform.reviewItems().length, 1);
});
