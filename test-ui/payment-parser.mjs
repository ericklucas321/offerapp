import assert from 'node:assert/strict';
import { loadPlaywright } from './playwright-runtime.mjs';
import { extractMarketDocument, snapshotFromDocument } from '../src/shared/market-parser.mjs';
import { clickAffiliate, closeAffiliate, readAffiliate } from '../extension/store-adapters.js';
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext();
await context.route('**/*', (route) => route.abort());
const page = await context.newPage();
const money = (fraction, cents = '') =>
  `<span class="andes-money-amount"><span class="andes-money-amount__currency-symbol">R$</span><span class="andes-money-amount__fraction">${fraction}</span>${cents ? `<span class="andes-money-amount__cents">${cents}</span>` : ''}</span>`;
const price = (fraction) =>
  `<div class="ui-pdp-price"><div class="ui-pdp-price__main-container"><div class="ui-pdp-price__price-breakdown-inline"><div class="ui-pdp-price__second-line">${money(fraction)}</div><span>no Pix</span></div><div class="ui-pdp-price__subtitles"><p>ou ${money('1.051', '58')} em 10x ${money('105', '16')} sem juros</p></div></div><div>20% OFF com Saldo no Mercado Pago</div></div>`;
try {
  await page.setContent(
    `<main><h1 class="ui-pdp-title">Galaxy de teste</h1>${price('999')}<div class="ui-pdp-outside_variations"><p class="ui-pdp-outside_variations__title">Cor: Preto</p></div><ul><li class="ui-pdp-buy-box-offers__offer-list-item"><input type="radio" id="MLB999999999">${price('899')}</li><li class="ui-pdp-buy-box-offers__offer-list-item"><input type="radio" id="MLB123456789" checked>${price('999')}<p>Estoque disponível</p><button>Comprar agora</button></li></ul></main>`,
  );
  const doc = await page.evaluate(extractMarketDocument);
  doc.url = 'https://www.mercadolivre.com.br/galaxy/p/MLB111111111?wid=MLB123456789';
  const snapshot = snapshotFromDocument(doc, doc.url);
  assert.equal(snapshot.priceCents, 99900);
  assert.equal(snapshot.priceCondition, 'Pix');
  assert.equal(snapshot.productKey, 'MLB123456789');
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.variant, 'Cor: Preto');
  assert.equal(doc.prices.length, 2);
  // The cheaper other seller cannot leak into this link's price.
  assert.equal(
    doc.prices.some((p) => p.fraction === '899'),
    false,
  );
  await page.setContent(
    `<main><h1 class="ui-pdp-title">Produto</h1><div class="ui-pdp-price"><div class="ui-pdp-price__second-line">${money('229', '99')}</div></div><div class="ui-pdp-price" hidden><div class="ui-pdp-price__second-line">${money('1')}</div></div><p>Estoque disponível</p><button hidden>Comprar agora</button></main>`,
  );
  const hiddenDoc = await page.evaluate(extractMarketDocument);
  hiddenDoc.url = 'https://produto.mercadolivre.com.br/MLB-123456789-fixture';
  const hiddenSnapshot = snapshotFromDocument(hiddenDoc, hiddenDoc.url);
  assert.equal(hiddenSnapshot.priceCents, 22999, 'preço oculto não pode ser escolhido');
  assert.equal(hiddenSnapshot.available, false, 'botão oculto não confirma compra disponível');
  await page.setContent(
    `<main><figure class="ui-pdp-gallery__figure"><img src="https://http2.mlstatic.com/thumb.webp" width="35" height="35"><img class="ui-pdp-image" src="https://http2.mlstatic.com/display.webp" data-zoom="https://http2.mlstatic.com/original.webp"></figure></main>`,
  );
  assert.equal(
    (await page.evaluate(extractMarketDocument)).image,
    'https://http2.mlstatic.com/original.webp',
    'seleciona a foto de zoom, não a miniatura que aparece antes no DOM',
  );
  await page.setContent(
    `<span class="affiliates" hidden>GANHE $</span><aside class="toolbar"><h4>Afiliados</h4><button onclick="document.querySelector('[data-tippy-root]').hidden=false">Compartilhar</button></aside><div data-tippy-root hidden><h3>Gerar link / ID de produto</h3><label>Link do produto<textarea>https://meli.la/generatedfixture</textarea></label></div>`,
  );
  await page.evaluate(clickAffiliate, 'mercadolivre');
  assert.equal(
    await page.evaluate(readAffiliate, 'mercadolivre'),
    'https://meli.la/generatedfixture',
  );
  await page.setContent(
    `<aside class="toolbar"><h4>Afiliados</h4><button onclick="document.querySelector('[data-tippy-root]').hidden=false">Compartilhar</button></aside><div data-tippy-root><h3>Gerar link / ID de produto</h3><button aria-label="close" onclick="this.parentElement.hidden=true;this.parentElement.querySelector('textarea').value='https://meli.la/recovered'">×</button><textarea disabled></textarea></div>`,
  );
  assert.equal(await page.evaluate(closeAffiliate, 'mercadolivre'), true);
  assert.equal(await page.locator('[data-tippy-root]').isVisible(), false);
  await page.evaluate(clickAffiliate, 'mercadolivre');
  assert.equal(await page.evaluate(readAffiliate, 'mercadolivre'), 'https://meli.la/recovered');
  await page.setContent(
    '<div role="dialog"><button aria-label="close">Outro diálogo</button></div>',
  );
  await assert.rejects(page.evaluate(closeAffiliate, 'mercadolivre'), /reabrir o gerador/);
  assert.equal(
    await page.evaluate(`(${readAffiliate.toString()})('mercadolivre', true)`),
    null,
    'consulta em espera não deve lançar erro dentro da página da loja',
  );
  console.log(
    'Payment DOM: selected seller, Pix, explicit installment total, variants and stock passed.',
  );
} finally {
  await context.close();
  await browser.close();
}
