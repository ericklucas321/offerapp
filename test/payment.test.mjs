import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotFromDocument, listingId, cleanProductUrl } from '../src/shared/market-parser.mjs';
import { validateBrowserCapture, captureItem } from '../src/shared/capture-contract.mjs';
import { Store } from '../src/infrastructure/repository.mjs';
import { Offers } from '../src/application/offers.mjs';
import { PublicationPolicy } from '../src/domain/publication.mjs';
const url = 'https://produto.mercadolivre.com.br/MLB-123456789-fixture';
test('seletor de vendedor em pdp_filters mantém identidade e variante no link', () => {
  const url =
    'https://www.mercadolivre.com.br/cafeteira/p/MLB15295245?pdp_filters=item_id%3AMLB1774504462&attributes=VOLTAGE%3A127V';
  assert.equal(listingId(url), 'MLB1774504462');
  assert.equal(new URL(cleanProductUrl(url)).searchParams.get('wid'), 'MLB1774504462');
  assert.equal(new URL(cleanProductUrl(url)).searchParams.get('attributes'), 'VOLTAGE:127V');
});
const total = (fraction, condition, context = '') => ({
  fraction,
  cents: '',
  currency: 'R$',
  kind: 'total',
  condition,
  context,
});
const doc = (prices) => ({
  url,
  title: 'Produto de teste',
  identityIds: [],
  schemas: [],
  prices,
  priceContext: '20% OFF com Saldo no Mercado Pago',
  variants: [],
  hasVariants: false,
  stock: true,
  buyEnabled: true,
  image: '',
});
test('menor total confirmado usa Pix e ignora parcelas, preço antigo e promoção sem valor final', () => {
  const snapshot = snapshotFromDocument(
    doc([
      total('999', 'Pix'),
      total('1.051', 'Parcelado em 10x sem juros (preço total)'),
      { ...total('105', ''), kind: 'installment' },
      { ...total('1.499', ''), kind: 'old' },
    ]),
    url,
  );
  assert.equal(snapshot.priceCents, 99900);
  assert.equal(snapshot.priceCondition, 'Pix');
  assert.equal(
    validateBrowserCapture({ version: 1, items: [captureItem(snapshot, 'product')] }).length,
    1,
  );
});
test('boleto mais barato vence Pix e mantém meio de pagamento', () => {
  const snapshot = snapshotFromDocument(doc([total('99', 'Pix'), total('95', 'Boleto')]), url);
  assert.equal(snapshot.priceCents, 9500);
  assert.equal(snapshot.priceCondition, 'Boleto');
  assert.equal(
    validateBrowserCapture({ version: 1, items: [captureItem(snapshot, 'product')] }).length,
    1,
  );
});
test('preço condicionado a elegibilidade não vira preço geral', () => {
  const snapshot = snapshotFromDocument(
    doc([total('80', 'Pix', '80 com cupom para primeira compra'), total('99', 'Pix')]),
    url,
  );
  assert.equal(snapshot.priceCents, 9900);
  assert.throws(
    () => snapshotFromDocument(doc([total('80', 'Pix', 'somente Meli+ com cupom')]), url),
    /price_ambiguous/,
  );
});
test('valores sem associação a pagamento não são escolhidos apenas por serem menores', () => {
  assert.throws(
    () =>
      snapshotFromDocument(
        doc([
          { fraction: '80', currency: 'R$' },
          { fraction: '100', currency: 'R$' },
        ]),
        url,
      ),
    /price_ambiguous/,
  );
});
test('troca de vendedor sem atualizar URL não associa preço ao anúncio original', () => {
  assert.throws(
    () =>
      snapshotFromDocument(
        { ...doc([total('999', 'Pix')]), selectedSellerId: 'MLB999999999' },
        url,
      ),
    /identity_unknown/,
  );
});
test('catálogo confirma identidade pelo número público do anúncio', () => {
  const catalog = 'https://www.mercadolivre.com.br/produto/p/MLB222222222?wid=MLB123456789';
  assert.equal(
    snapshotFromDocument(
      { ...doc([total('999', 'Pix')]), url: catalog, publicListingId: 'MLB123456789' },
      catalog,
    ).productKey,
    'MLB123456789',
  );
});
test('mensagem mantém condição de pagamento ao editar observação e aprovação registra a mesma mensagem', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-payment-'));
  const store = new Store({ dataDir: dir });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const policy = new PublicationPolicy({ store }),
    offers = new Offers({ store, policy });
  const snapshot = snapshotFromDocument(doc([total('999', 'Pix')]), url);
  offers.capture({ version: 1, items: [captureItem(snapshot, 'product')] }, true);
  const offer = offers.prepare(store.captures()[0].id, {
    affiliateUrl: 'https://meli.la/fixture',
    affiliateConfirmed: true,
    note: 'Confira as cores.',
  });
  const preview = offers.preview(offer.id);
  assert.match(preview.message, /no Pix/);
  assert.match(preview.message, /Confira as cores/);
  assert.match(preview.message, /999,00/);
  const delivery = store.enqueue(offer.id, '123@g.us');
  store.approveDelivery(delivery.id, store.getOffer(offer.id));
  assert.equal(store.listDeliveries()[0].approved_message, preview.message);
  assert.equal(JSON.parse(store.listDeliveries()[0].approved_metadata).priceCondition, 'Pix');
});
