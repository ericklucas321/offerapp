import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/infrastructure/repository.mjs';
import { createQueueWorker } from '../src/jobs/queue.mjs';
import {
  normalizeOfferInput,
  extractProductKey,
  productIdentity,
} from '../src/domain/messages.mjs';
import { couponPrice } from '../src/domain/pricing.mjs';
const input = {
  productUrl: 'https://produto.mercadolivre.com.br/MLB-123456789-x',
  affiliateUrl: 'https://meli.la/test',
  affiliateConfirmed: true,
  title: 'Teste',
  price: 100,
  oldPrice: 150,
};
function db(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offers-test-'));
  const s = new Store({ dataDir: dir });
  t.after(() => s.close());
  return s;
}
test('bloqueia link comum, protocolo inseguro, marketplace divergente e confirmação ausente', () => {
  assert.throws(
    () => normalizeOfferInput({ ...input, affiliateUrl: input.productUrl }),
    /official_short_link_required/,
  );
  assert.throws(
    () =>
      normalizeOfferInput({ ...input, productUrl: input.productUrl.replace('https:', 'http:') }),
    /invalid_url/,
  );
  assert.throws(
    () => normalizeOfferInput({ ...input, marketplace: 'amazon' }),
    /product_marketplace_mismatch/,
  );
  assert.throws(
    () => normalizeOfferInput({ ...input, affiliateConfirmed: false }),
    /affiliate_confirmation_required/,
  );
  const amazon = {
    productUrl: 'https://amazon.com.br/dp/B012345678',
    affiliateUrl: 'https://amazon.com.br/dp/B012345678',
    title: 'Teste',
    price: 10,
  };
  assert.throws(() => normalizeOfferInput(amazon), /affiliate_tag_required/);
  assert.throws(
    () =>
      normalizeOfferInput(
        { ...amazon, affiliateUrl: amazon.affiliateUrl + '?tag=other' },
        { AMAZON_PARTNER_TAG: 'mine' },
      ),
    /affiliate_tag_mismatch/,
  );
  assert.equal(extractProductKey('shopee', 'https://shopee.com.br/product/123/456'), '123.456');
});
test('cupom respeita percentual, teto, mínimo, expiração e regras inválidas', () => {
  assert.equal(couponPrice(10000, 'X', { type: 'percent', value: 20, maximum: 10 }).final, 9000);
  assert.equal(couponPrice(10000, 'X', { type: 'fixed', value: 10, minimum: 200 }).final, 10000);
  assert.equal(couponPrice(10000, 'X', { type: 'fixed', value: 20 }).final, 8000);
  assert.throws(() => couponPrice(10000, 'X', { type: 'percent', value: 101 }), /invalid_coupon/);
  assert.throws(
    () => couponPrice(10000, 'X', { type: 'fixed', value: 10, expiresAt: '2020-01-01' }),
    /coupon_expired/,
  );
});
test('histórico inclui observações duplicadas, score explica componentes, variante é independente', (t) => {
  const s = db(t);
  const a = s.createOffer(input);
  assert.throws(() => s.createOffer(input), /duplicate_offer/);
  const b = s.createOffer({ ...input, price: 70 });
  assert.equal(s.history('mercadolivre', a.product_key).count, 3);
  assert.equal(s.history('mercadolivre', a.product_key).minimum_cents, 7000);
  assert.ok(JSON.parse(b.score_detail).components.historical > 0);
  assert.ok(s.createOffer({ ...input, variant: 'azul' }));
});
test('fila respeita agendamento, conexão, política e trava de concorrência', async (t) => {
  const s = db(t);
  const a = s.createOffer({ ...input, oldPrice: 100 });
  const b = s.createOffer({ ...input, price: 70 });
  s.enqueue(a.id, 'mock');
  s.enqueue(b.id, 'mock');
  assert.equal(s.nextDelivery().offer_id, a.id);
  let ready = false;
  let count = 0;
  const w = createQueueWorker({
    preflight: () => ({ allowed: count === 0, reason: 'Intervalo da política' }),
    store: s,
    publisher: {
      isReady: () => ready,
      async send() {
        count++;
      },
    },
  });
  await w.tick();
  assert.equal(count, 0);
  ready = true;
  await Promise.all([w.tick(), w.tick()]);
  assert.equal(count, 1);
  await w.tick();
  assert.equal(count, 1);
  assert.equal(s.enqueue(a.id, 'mock').state, 'sent');
});
test('falha isolada faz retry, persiste e chega ao limite', async (t) => {
  const s = db(t);
  const a = s.createOffer(input);
  s.enqueue(a.id, 'mock');
  const w = createQueueWorker({
    preflight: () => ({ allowed: true }),
    store: s,
    maxAttempts: 2,
    logger: { error() {} },
    publisher: {
      async send() {
        const error = new Error('offline');
        error.safeToRetry = true;
        throw error;
      },
    },
  });
  await w.tick();
  assert.equal(s.listDeliveries()[0].state, 'queued');
  s.db.prepare("UPDATE deliveries SET next_attempt_at='2000-01-01'").run();
  await w.tick();
  assert.equal(s.listDeliveries()[0].state, 'failed');
  assert.equal(s.listDeliveries()[0].attempts, 2);
});
test('reinício deixa envio interrompido para revisão e mantém a oferta', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offers-restart-'));
  let s = new Store({ dataDir: dir });
  const a = s.createOffer(input);
  const d = s.enqueue(a.id, 'mock');
  s.markSending(d.id);
  s.close();
  s = new Store({ dataDir: dir });
  t.after(() => s.close());
  assert.equal(s.listDeliveries()[0].state, 'uncertain');
  assert.equal(s.nextDelivery(), undefined);
  assert.ok(s.getOffer(a.id));
  assert.throws(() => s.retryUncertain(d.id, false), /delivery_confirmation_required/);
  s.retryUncertain(d.id, true);
  assert.equal(s.nextDelivery().offer_id, a.id);
});
test('migração preserva banco anterior e bloqueia links antigos até revalidação', (t) => {
  const s = db(t);
  const a = s.createOffer(input);
  s.db.prepare("UPDATE offers SET affiliate_validation='domain_only' WHERE id=?").run(a.id);
  assert.throws(() => s.enqueue(a.id, 'mock'), /affiliate_revalidation_required/);
});

test('oferta legada já enfileirada nunca passa ao publisher', async (t) => {
  const s = db(t);
  const a = s.createOffer(input);
  s.enqueue(a.id, 'mock');
  s.db.prepare("UPDATE offers SET affiliate_validation='domain_only' WHERE id=?").run(a.id);
  let sent = 0;
  const w = createQueueWorker({
    preflight: (job) => ({
      allowed: job.affiliate_validation !== 'domain_only',
      reason: 'Link antigo exige revisão',
    }),
    store: s,
    maxAttempts: 1,
    logger: { error() {} },
    publisher: {
      async send() {
        sent++;
      },
    },
  });
  await w.tick();
  assert.equal(sent, 0);
  assert.equal(s.listDeliveries()[0].state, 'queued');
});

test('oferta manual sem código no link não requer produto previamente cadastrado', (t) => {
  const s = db(t);
  const manual = {
    ...input,
    productUrl: 'https://mercadolivre.com.br/sec/EXEMPLO',
    affiliateUrl: 'https://meli.la/manual',
  };
  const offer = s.createOffer(manual);
  assert.match(offer.product_key, /^url:/);
  assert.equal(offer.status, 'ready');
  assert.throws(
    () => s.createOffer({ ...manual, productUrl: manual.productUrl + '?utm_source=whatsapp' }),
    /duplicate_offer/,
  );
  assert.equal(
    productIdentity('mercadolivre', 'https://mercadolivre.com.br/sec/EXEMPLO?a=1&b=2'),
    productIdentity(
      'mercadolivre',
      'https://www.mercadolivre.com.br/sec/EXEMPLO?b=2&a=1&utm_medium=social#share',
    ),
  );
  assert.notEqual(
    productIdentity('mercadolivre', 'https://mercadolivre.com.br/sec/EXEMPLO?variant=blue'),
    productIdentity('mercadolivre', 'https://mercadolivre.com.br/sec/EXEMPLO?variant=red'),
  );
  assert.equal(productIdentity('mercadolivre', input.productUrl), 'MLB123456789');
});
test('oferta aceita somente link afiliado oficial informado e exige confirmação', () => {
  const manual = {
    affiliateUrl: 'https://meli.la/ABC',
    affiliateConfirmed: true,
    title: 'Oferta manual',
    price: '50,00',
  };
  const offer = normalizeOfferInput(manual);
  assert.equal(offer.productUrl, manual.affiliateUrl);
  assert.match(offer.productKey, /^url:/);
  assert.equal(offer.marketplace, 'mercadolivre');
  assert.throws(
    () => normalizeOfferInput({ ...manual, affiliateConfirmed: false }),
    /affiliate_confirmation_required/,
  );
  assert.equal(
    normalizeOfferInput({ ...manual, affiliateUrl: '', productUrl: manual.affiliateUrl })
      .affiliateUrl,
    manual.affiliateUrl,
  );
});
test('grupo salvo persiste sem sessão WhatsApp ou cadastro de produtos', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offers-destination-'));
  let s = new Store({ dataDir: dir });
  assert.deepEqual(s.saveDestination('123@g.us', 'Ofertas'), { id: '123@g.us', name: 'Ofertas' });
  s.close();
  s = new Store({ dataDir: dir });
  t.after(() => s.close());
  assert.equal(s.setting('whatsapp_group_id'), '123@g.us');
  assert.equal(s.setting('whatsapp_group_name'), 'Ofertas');
  assert.equal(s.listOffers().length, 0);
});
