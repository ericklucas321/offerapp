import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeOfferInput } from '../src/domain/messages.mjs';
import { findProducts } from '../extension/store-adapters.js';
import { Store } from '../src/infrastructure/repository.mjs';
import { Offers } from '../src/application/offers.mjs';
import { Platform } from '../src/application/platform.mjs';
import { PublicationPolicy } from '../src/domain/publication.mjs';

const catalog = 'https://www.mercadolivre.com.br/item/p/MLB12345678';
const input = {
  title: 'Produto de teste',
  price: 100,
  affiliateUrl: 'https://meli.la/teste',
  affiliateConfirmed: true,
};
test('normalização preserva anúncio e seletores materiais do fragmento de catálogo', () => {
  for (const id of ['MLB999999999', 'MLB888888888']) {
    const offer = normalizeOfferInput({
      ...input,
      productUrl: `${catalog}#wid=${id}&variation=123&variation_id=456&attributes=COLOR:PRETO&tracking_id=ignored`,
    });
    assert.equal(offer.productKey, id);
    const url = new URL(offer.productUrl);
    assert.equal(url.searchParams.get('wid'), id);
    assert.equal(url.searchParams.get('variation'), '123');
    assert.equal(url.searchParams.get('variation_id'), '456');
    assert.equal(url.searchParams.get('attributes'), 'COLOR:PRETO');
    assert.equal(url.hash, '');
    assert.equal(url.searchParams.has('tracking_id'), false);
  }
  const query = normalizeOfferInput({
    ...input,
    productUrl: `${catalog}?wid=MLB777777777#tracking_id=ignored`,
  });
  assert.equal(query.productKey, 'MLB777777777');
});

test('descoberta preserva o anúncio selecionado em links de catálogo', (t) => {
  const old = globalThis.document;
  t.after(() => {
    if (old === undefined) delete globalThis.document;
    else globalThis.document = old;
  });
  globalThis.document = {
    body: { innerText: 'Resultados' },
    querySelectorAll: () => [{ href: `${catalog}#wid=MLB999999999&variation=123` }],
  };
  const [url] = findProducts('mercadolivre');
  const offer = normalizeOfferInput({ ...input, productUrl: url });
  assert.equal(offer.productKey, 'MLB999999999');
  assert.equal(new URL(offer.productUrl).searchParams.get('variation'), '123');
});

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-followup-'));
  const store = new Store({ dataDir });
  t.after(() => {
    store.close();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('offer-followup-'));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const now = Date.now(),
    clock = () => now;
  const policy = new PublicationPolicy({ store, now: clock });
  const offers = new Offers({ store, policy, now: clock });
  const platform = new Platform({ store, offers, policy, now: clock });
  store.setSetting('publication_paused', 'false');
  for (const id of ['123@g.us', '456@g.us'])
    platform.saveGroup({ id, startMinute: 0, endMinute: 0 }, [{ id, name: id }]);
  const observation = {
    ...input,
    productUrl: 'https://produto.mercadolivre.com.br/MLB-123456789-teste',
    priceCents: 10000,
    stockStatus: 'available',
    priceCondition: 'À vista',
    observedAt: new Date(now).toISOString(),
    affiliateObserved: true,
  };
  const observe = (o) => {
    const id = platform.validateConnection('mercadolivre', o.productUrl);
    assert.equal(platform.claimJob().id, id);
    platform.completeJob(id, { observation: o });
  };
  return { store, offers, platform, policy, observation, observe };
}

test('validação browser aceita wid no fragmento e conserva a identidade selecionada', (t) => {
  const { store, observe, observation } = fixture(t);
  observe({
    ...observation,
    productUrl: `${catalog}#wid=MLB999999999&variation=123`,
    variant: '123',
  });
  assert.equal(store.listOffers()[0].product_key, 'MLB999999999');
});

test('nova captura atualiza imagem de oferta ainda não enviada e exige revisão da aprovação antiga', (t) => {
  const { store, platform, observation, observe } = fixture(t);
  const thumbnail = 'https://http2.mlstatic.com/thumbnail.webp';
  const original = 'https://http2.mlstatic.com/original.webp';
  observe({ ...observation, imageUrl: thumbnail });
  const offer = store.listOffers()[0];
  platform.approveBatch({
    ...platform.batchPreview([{ offerId: offer.id, groupIds: ['123@g.us'] }]),
    confirmed: true,
  });
  observe({ ...observation, imageUrl: original });
  assert.equal(store.getOffer(offer.id).image_url, original);
  const delivery = store.listDeliveries()[0];
  assert.equal(delivery.state, 'cancelled');
  assert.equal(JSON.parse(delivery.approved_metadata).image, thumbnail);
});

for (const state of ['sent', 'uncertain']) {
  test(`nova captura não altera imagem com histórico ${state}`, (t) => {
    const { store, platform, observation, observe } = fixture(t);
    const thumbnail = 'https://http2.mlstatic.com/thumbnail.webp';
    observe({ ...observation, imageUrl: thumbnail });
    const offer = store.listOffers()[0];
    platform.approveBatch({
      ...platform.batchPreview([{ offerId: offer.id, groupIds: ['123@g.us'] }]),
      confirmed: true,
    });
    const delivery = store.listDeliveries()[0];
    store.markSending(delivery.id);
    if (state === 'sent') store.markSent(delivery.id, offer.id);
    else store.markUncertain(delivery.id, offer.id);
    observe({ ...observation, imageUrl: 'https://http2.mlstatic.com/original.webp' });
    assert.equal(store.getOffer(offer.id).image_url, thumbnail);
    assert.equal(store.listDeliveries()[0].state, state);
  });
}

for (const change of [{ priceCents: 11000 }, { priceCondition: 'Pix' }]) {
  test(`refresh após envio parcial permite revisar dados atuais: ${JSON.stringify(change)}`, (t) => {
    const { store, platform, policy, observation, observe } = fixture(t);
    observe(observation);
    const original = store.listOffers()[0];
    platform.approveBatch({
      ...platform.batchPreview([{ offerId: original.id, groupIds: ['123@g.us', '456@g.us'] }]),
      confirmed: true,
    });
    const first = store.listDeliveries().find((d) => d.destination === '123@g.us');
    const second = store.listDeliveries().find((d) => d.destination === '456@g.us');
    store.markSending(first.id);
    store.markSent(first.id, original.id);
    const frozenOffer = store.getOffer(original.id),
      frozenSent = store.listDeliveries().find((d) => d.id === first.id);
    const refresh = platform.addJob(
      'mercadolivre',
      'refresh',
      { productUrl: observation.productUrl },
      { deliveryId: second.id },
    );
    assert.equal(platform.claimJob().id, refresh);
    const result = { observation: { ...observation, ...change } };
    platform.completeJob(refresh, result);
    if (store.nextDelivery()) policy.preflight(store.nextDelivery());
    const current = platform.reviewItems().find((i) => i.ready);
    assert.ok(current, 'deve existir uma revisão pronta com os dados atuais');
    assert.notEqual(current.id, original.id);
    assert.equal(current.priceCents, change.priceCents ?? 10000);
    assert.deepEqual(current.eligibleGroups, ['456@g.us']);
    assert.deepEqual(store.getOffer(original.id), frozenOffer);
    assert.deepEqual(
      store.listDeliveries().find((d) => d.id === first.id),
      frozenSent,
    );
    assert.equal(store.listDeliveries().find((d) => d.id === second.id).state, 'cancelled');
    assert.equal(store.listDeliveries().filter((d) => d.state === 'queued').length, 0);
    platform.completeJob(refresh, result);
    assert.equal(store.listOffers().length, 2, 'repetir o resultado não cria revisões duplicadas');
    const batch = platform.batchPreview([{ offerId: current.id, groupIds: ['456@g.us'] }]);
    assert.ok(batch.rows[0].message.includes(change.priceCondition ?? 'À vista'));
    platform.approveBatch({ ...batch, confirmed: true });
    assert.equal(store.listDeliveries().filter((d) => d.state === 'queued').length, 1);
    assert.equal(store.listDeliveries().filter((d) => d.state === 'sent').length, 1);
  });
}

test('refreshes antigos cancelados não criam sucessoras nem escondem a curadoria nova', (t) => {
  const { store, platform, offers, observation, observe } = fixture(t);
  observe(observation);
  const original = store.listOffers()[0];
  platform.approveBatch({
    ...platform.batchPreview([{ offerId: original.id, groupIds: ['123@g.us', '456@g.us'] }]),
    confirmed: true,
  });
  const sent = store.listDeliveries().find((d) => d.destination === '123@g.us');
  const pending = store.listDeliveries().find((d) => d.destination === '456@g.us');
  store.markSending(sent.id);
  store.markSent(sent.id, original.id);
  const first = platform.addJob(
    'mercadolivre',
    'refresh',
    { productUrl: observation.productUrl },
    { deliveryId: pending.id },
  );
  const late = platform.addJob(
    'mercadolivre',
    'refresh',
    { productUrl: observation.productUrl },
    { deliveryId: pending.id },
  );
  assert.equal(platform.claimJob().id, first);
  assert.equal(platform.claimJob().id, late);
  platform.completeJob(first, { observation: { ...observation, priceCents: 11000 } });
  const revised = store.listOffers()[0];
  offers.manual({ title: 'Curadoria revisada', note: 'Nota preservada' }, revised.id);
  platform.completeJob(late, { observation: { ...observation, priceCents: 12000 } });
  assert.equal(store.listOffers().length, 2);
  assert.equal(platform.reviewItems()[0].id, revised.id);
  assert.equal(platform.reviewItems()[0].title, 'Curadoria revisada');
  assert.equal(platform.reviewItems()[0].note, 'Nota preservada');
});
