import { cleanProductUrl, listingId } from './market-parser.mjs';
export const CAPTURE_PROTOCOL = Object.freeze({
  version: 1,
  maxItems: 20,
  maxBodyBytes: 131072,
  maxFragmentChars: 150000,
});
export function captureItem(snapshot, stage) {
  return {
    stage,
    productKey: snapshot.productKey,
    variant: snapshot.variant || '',
    title: snapshot.title,
    productUrl: snapshot.productUrl,
    imageUrl: snapshot.imageUrl || '',
    priceCents: snapshot.priceCents,
    available: stage === 'product' && Boolean(snapshot.available),
    stockStatus:
      stage === 'card'
        ? 'unknown'
        : snapshot.stockStatus || (snapshot.available ? 'available' : 'unknown'),
    observedAt: snapshot.observedAt,
    priceCondition: snapshot.priceCondition,
  };
}
export const importMessages = {
  browser_import_invalid: 'A captura não contém produtos válidos do Mercado Livre.',
  browser_import_confirmation: 'Confira os produtos e confirme a importação.',
  browser_import_stale: 'Preço capturado há mais de 15 minutos. Capture o produto novamente.',
  browser_import_product_required:
    'Abra a página do produto e capture novamente para confirmar anúncio, preço e estoque.',
  browser_import_unavailable: 'Estoque não confirmado. A oferta permanece pendente.',
};
export function captureStock(capture) {
  if (!capture || capture.stage !== 'product') return 'unknown';
  const available = capture.available === true || capture.available === 1;
  if (available && (!capture.stock_status || capture.stock_status === 'available'))
    return 'available';
  if (!available && capture.stock_status === 'unavailable') return 'unavailable';
  return 'unknown';
}
export function validateBrowserCapture(packet, now = Date.now()) {
  if (
    packet?.version !== CAPTURE_PROTOCOL.version ||
    !Array.isArray(packet.items) ||
    !packet.items.length ||
    packet.items.length > CAPTURE_PROTOCOL.maxItems
  )
    throw new Error('browser_import_invalid');
  return packet.items.map((i) => {
    if (
      !i ||
      !['product', 'card'].includes(i.stage) ||
      typeof i.title !== 'string' ||
      !i.title.trim() ||
      i.title.length > 500 ||
      typeof i.productUrl !== 'string' ||
      i.productUrl.length > 2048 ||
      !Number.isSafeInteger(i.priceCents) ||
      i.priceCents <= 0 ||
      i.priceCents > 1000000000 ||
      typeof i.available !== 'boolean' ||
      typeof i.variant !== 'string' ||
      i.variant.length > 200 ||
      !(
        typeof i.priceCondition === 'string' &&
        ([
          'Pix',
          'Boleto',
          'Cartão de crédito',
          'Preço anunciado',
          'Preço à vista anunciado',
        ].includes(i.priceCondition) ||
          /^Parcelado em [1-9]\d?x(?: sem juros)? \(preço total\)$/.test(i.priceCondition))
      )
    )
      throw new Error('browser_import_invalid');
    const stockStatus =
      i.stage === 'card' ? 'unknown' : (i.stockStatus ?? (i.available ? 'available' : 'unknown'));
    if (
      !['unknown', 'available', 'unavailable'].includes(stockStatus) ||
      (i.stage === 'product' && (stockStatus === 'available') !== i.available)
    )
      throw new Error('browser_import_invalid');
    const productUrl = cleanProductUrl(i.productUrl),
      productKey = listingId(productUrl);
    if (productKey !== i.productKey) throw new Error('browser_import_invalid');
    const age = now - Date.parse(i.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > 900000) throw new Error('browser_import_stale');
    let imageUrl = '';
    if (i.imageUrl) {
      let u;
      try {
        u = new URL(i.imageUrl);
      } catch {
        throw new Error('browser_import_invalid');
      }
      if (
        u.protocol !== 'https:' ||
        u.username ||
        u.password ||
        !/(^|\.)mlstatic\.com$/.test(u.hostname)
      )
        throw new Error('browser_import_invalid');
      imageUrl = u.href;
    }
    return {
      stage: i.stage,
      title: i.title.trim(),
      productUrl,
      productKey,
      variant: i.variant,
      imageUrl,
      priceCents: i.priceCents,
      available: stockStatus === 'available',
      stockStatus,
      priceCondition: i.priceCondition,
      observedAt: new Date(Date.parse(i.observedAt)).toISOString(),
    };
  });
}
