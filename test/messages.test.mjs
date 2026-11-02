import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatOfferMessage } from '../src/domain/messages.mjs';
import { couponPrice } from '../src/domain/pricing.mjs';
import { Store } from '../src/infrastructure/repository.mjs';
const offer = {
  marketplace: 'mercadolivre',
  title: 'Organizador de cozinha',
  price_cents: 8000,
  old_price_cents: 10000,
  affiliate_url: 'https://meli.la/exemplo',
  note: '',
};
test('mensagem destaca título/preço, referência informada e preserva link exato', () => {
  const message = formatOfferMessage(offer);
  assert.match(message, /^\*Organizador de cozinha\*\n\n/);
  assert.match(message, /De ~R\$.*100,00~/);
  assert.match(message, /💰 \*R\$.*80,00\*/);
  assert.ok(message.includes(offer.affiliate_url));
  assert.match(message, /Link afiliado/);
  assert.doesNotMatch(message, /menor preço|últimas unidades|histórico|Cupom|estimativa/i);
});

test('legenda enxuta reúne preço e pagamento, limita título e mantém variante e link exatos', () => {
  const message = formatOfferMessage({
    ...offer,
    title:
      'Cafeteira Italiana Premium Moka 6 Xícaras 300ml Alumínio Café Expresso Manual Casa Portátil Compacta Restaurante Padaria',
    price_cents: 4108,
    old_price_cents: null,
    price_condition: 'Pix',
    note: 'Pix',
    variant: 'Cor:Prateado',
  });
  assert.ok(message.split('\n')[0].length <= 92);
  assert.match(message, /💰 \*R\$.*41,08\* no Pix/);
  assert.match(message, /Cor:Prateado/);
  assert.equal((message.match(/Pix/g) || []).length, 1);
  assert.ok(message.includes('🛒 ' + offer.affiliate_url));
  assert.doesNotMatch(message, /Pagamento:|Ver oferta:|\nMercado Livre\n/);
});

test('condições específicas de parcelamento permanecem explícitas e preço anunciado não vira Pix', () => {
  assert.match(
    formatOfferMessage({ ...offer, price_condition: 'Parcelado em 10x sem juros (preço total)' }),
    /10x sem juros \(preço total\)/,
  );
  assert.doesNotMatch(
    formatOfferMessage({ ...offer, price_condition: 'Preço anunciado' }),
    /no Pix|Pagamento:/,
  );
});

test('encurtar o título não remove uma voltagem confirmada presente somente no final', () => {
  const message = formatOfferMessage({
    ...offer,
    title: 'Cafeteira ' + 'Modelo completo com detalhes '.repeat(5) + '220V',
    variant: '220V',
  });
  assert.match(message, /\n220V\n/);
});

test('legenda não apresenta o identificador interno de uma variação como descrição', () => {
  assert.doesNotMatch(formatOfferMessage({ ...offer, variant: '238475434' }), /238475434/);
});
test('sem preço anterior não cria desconto; referência menor/igual também não', () => {
  for (const old of [null, 8000, 5000]) {
    const message = formatOfferMessage({ ...offer, old_price_cents: old });
    assert.doesNotMatch(message, /De ~|% abaixo/);
  }
});
test('cupom sem regras não promete preço final e informa elegibilidade', () => {
  const result = couponPrice(8000, 'TESTE', null);
  const message = formatOfferMessage({
    ...offer,
    coupon: 'TESTE',
    final_price_cents: result.final,
    coupon_condition: result.condition,
  });
  assert.match(message, /Cupom: \*TESTE\*/);
  assert.doesNotMatch(message, /Com cupom:/);
  assert.match(message, /desconto não calculado/);
});
test('cupom mostra estimativa, mínimo, teto e validade em Brasília', () => {
  const rules = {
    type: 'percent',
    value: 20,
    minimum: 50,
    maximum: 10,
    expiresAt: '2099-01-01T15:00:00Z',
    conditions: 'Para contas elegíveis.',
  };
  const price = couponPrice(8000, 'TESTE', rules);
  assert.equal(price.final, 7000);
  const message = formatOfferMessage({
    ...offer,
    coupon: 'TESTE',
    final_price_cents: price.final,
    coupon_condition: price.condition,
  });
  assert.match(message, /Com cupom: \*R\$.*70,00\* \(estimativa\)/);
  assert.match(message, /Compra mínima: R\$.*50,00/);
  assert.match(message, /Desconto limitado a R\$.*10,00/);
  assert.match(message, /01\/01\/2099.*12:00.*Brasília/);
  assert.match(message, /Sujeito à elegibilidade/);
});
test('oferta abaixo do mínimo não apresenta desconto do cupom', () => {
  const price = couponPrice(8000, 'TESTE', { type: 'fixed', value: 10, minimum: 100 });
  assert.equal(price.final, 8000);
  assert.match(price.condition, /Cupom não aplicado.*100,00/);
});
test('prévia de oferta salva recalcula condições sem alterar registro; cupom expirado não promete desconto', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-messages-'));
  const store = new Store({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const saved = store.createOffer({
    title: 'Oferta com cupom',
    affiliateUrl: 'https://meli.la/preview',
    affiliateConfirmed: true,
    price: 80,
    coupon: 'TESTE',
    couponRules: { type: 'fixed', value: 10, minimum: 50, maximum: 10 },
  });
  const before = JSON.stringify(store.getOffer(saved.id));
  assert.match(store.messageFor(saved), /Compra mínima:/);
  assert.equal(JSON.stringify(store.getOffer(saved.id)), before);
  const expired = {
    ...saved,
    coupon_rules: JSON.stringify({ type: 'fixed', value: 10, expiresAt: '2020-01-01' }),
  };
  const message = store.messageFor(expired);
  assert.match(message, /Cupom expirado/);
  assert.doesNotMatch(message, /Com cupom:/);
});
