import {
  extractMarketDocument,
  snapshotFromDocument,
  listingId,
  cleanProductUrl,
  brlCents,
  marketUrl,
  webMessages,
  CAPTURE_PROTOCOL,
  captureItem,
  validateBrowserCapture,
} from './capture.js';
let packet = null;
const status = document.querySelector('#status'),
  capture = document.querySelector('#capture'),
  transfer = document.querySelector('#transfer');
capture.addEventListener('click', async () => {
  capture.disabled = true;
  transfer.hidden = true;
  packet = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    marketUrl(tab.url);
    const [{ result: doc }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractMarketDocument,
    });
    if (doc.loginAttemptLimit) throw new Error('source_browser_login_attempt_limit');
    if (doc.login) throw new Error('source_browser_login_required');
    if (doc.challenge) {
      status.textContent =
        doc.challengeReason === 'page_denied'
          ? 'A página mostra acesso negado. Confira o aviso no Mercado Livre. Nenhum dado foi importado.'
          : 'Há uma verificação visível na página. Conclua-a no Mercado Livre antes de capturar.';
      return;
    }
    let items = [];
    if (doc.title) {
      items = [captureItem(snapshotFromDocument(doc, tab.url), 'product')];
    } else {
      const seen = new Set();
      for (const c of doc.cards) {
        const id = listingId(c.url);
        if (
          !id ||
          seen.has(id) ||
          !c.title ||
          !c.price ||
          c.price.currency !== 'R$' ||
          /pix|cupom|m[eé]li\+|cart[aã]o mercado pago|primeira compra/i.test(c.condition)
        )
          continue;
        try {
          items.push(
            captureItem(
              {
                productKey: id,
                title: c.title,
                productUrl: cleanProductUrl(c.url),
                imageUrl: c.image,
                priceCents: brlCents(c.price.fraction, c.price.cents),
                available: false,
                observedAt: new Date().toISOString(),
                priceCondition: 'Preço à vista anunciado',
              },
              'card',
            ),
          );
          seen.add(id);
        } catch {}
        if (items.length === CAPTURE_PROTOCOL.maxItems) break;
      }
    }
    if (!items.length) throw new Error('source_browser_layout_changed');
    packet = { version: CAPTURE_PROTOCOL.version, items };
    validateBrowserCapture(packet);
    status.textContent =
      items.length === 1 && items[0].stage === 'product'
        ? `Produto capturado: ${items[0].title}. Estoque ${items[0].stockStatus === 'unavailable' ? 'indisponível na página' : items[0].available ? 'confirmado na página' : 'não confirmado'}.`
        : `${items.length} produtos capturados. Abra cada produto escolhido para confirmar preço e estoque.`;
    transfer.hidden = false;
  } catch (e) {
    status.textContent =
      webMessages[e.message] ||
      'Não foi possível capturar esta página. Abra um produto ou vitrine no Mercado Livre e tente novamente.';
  } finally {
    capture.disabled = false;
  }
});
transfer.addEventListener('click', async () => {
  if (!packet) return;
  const configuration = await chrome.storage.local.get('base');
  const base = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(configuration.base || '')
    ? configuration.base
    : 'http://127.0.0.1:3210';
  await chrome.tabs.create({
    url: base + '/#browser-capture=' + encodeURIComponent(JSON.stringify(packet)),
  });
});
