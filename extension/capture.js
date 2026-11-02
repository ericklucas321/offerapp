// Generated from src/shared. Run npm run build:extension.
class CaptureError extends Error {
  constructor(code) {
    super(code);
  }
}
export const webMessages = {
  source_browser_login_attempt_limit:
    'Mercado Livre: limite de tentativas de login atingido. Piloto suspenso. A página não informa prazo; retome somente após o acesso ser liberado.',
  source_browser_closed: 'Abra o navegador dedicado e conecte sua conta de afiliado.',
  source_browser_login_required: 'Faça login no Mercado Livre no navegador dedicado.',
  source_browser_challenge:
    'O Mercado Livre pediu verificação no navegador. A coleta foi interrompida.',
  source_browser_layout_changed:
    'A página não apresentou dados que possamos validar. Confira o navegador.',
  source_browser_identity_unknown:
    'Não foi possível confirmar o anúncio e a variante. Produto permanece pendente.',
  source_browser_price_ambiguous:
    'Preço ou condição de pagamento ambíguos. Produto permanece pendente.',
  source_browser_busy: 'O navegador está em uso. Aguarde o término do piloto.',
  source_browser_access_denied:
    'O Mercado Livre bloqueou a leitura da página (403). Nenhum preço foi presumido.',
};

export function marketUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new CaptureError('source_invalid_product');
  }
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    !/(^|\.)mercadolivre\.com\.br$/.test(u.hostname)
  )
    throw new CaptureError('source_invalid_product');
  return u;
}
export function listingId(raw) {
  try {
    const u = marketUrl(raw),
      fragment = new URLSearchParams(u.hash.slice(1));
    const selected =
      u.searchParams.get('wid') ||
      fragment.get('wid') ||
      u.searchParams.get('pdp_filters')?.match(/(?:^|\|)item_id:(MLB\d+)(?:\||$)/)?.[1];
    if (/^MLB\d+$/.test(selected || '')) return selected;
    if (u.pathname.includes('/p/')) return null;
    return (
      u.pathname
        .match(/(?:^|\/)MLB-?(\d+)(?:-|\/|$)/i)?.[0]
        .match(/MLB-?(\d+)/i)?.[1]
        ?.replace(/^/, 'MLB') || null
    );
  } catch {
    return null;
  }
}
export function cleanProductUrl(raw) {
  const u = marketUrl(raw);
  const id = listingId(raw);
  if (!id) throw new CaptureError('source_browser_identity_unknown');
  const wid =
    u.searchParams.get('wid') ||
    new URLSearchParams(u.hash.slice(1)).get('wid') ||
    (u.pathname.includes('/p/') ? id : null);
  const selectors = ['variation', 'variation_id', 'attributes']
    .map((k) => [k, u.searchParams.get(k) || new URLSearchParams(u.hash.slice(1)).get(k)])
    .filter(([, v]) => v);
  u.search = '';
  u.hash = '';
  if (wid) u.searchParams.set('wid', wid);
  for (const [key, value] of selectors) u.searchParams.set(key, value);
  return u.href;
}
export function brlCents(fraction, cents = '') {
  if (!/^\d+(?:\.\d{3})*$/.test(String(fraction).trim()) || !/^\d{0,2}$/.test(String(cents).trim()))
    throw new CaptureError('source_browser_price_ambiguous');
  const value =
    Number(String(fraction).replaceAll('.', '')) * 100 + Number(String(cents).padEnd(2, '0'));
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new CaptureError('source_browser_price_ambiguous');
  return value;
}

// Runs inside a page; deliberately reads only product fields, never cookies or credentials.
export function extractMarketDocument() {
  const text = document.body?.innerText || '';
  const loginAttemptLimit =
    /limite de tentativas|demasiados intentos|too many (?:login )?attempts/i.test(text);
  // Background anti-bot widgets are common on product pages. Only visible
  // challenges or explicit blocking pages should stop a capture.
  const rendered = (el) => {
    if (!el || el.closest('[hidden],[aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    for (let e = el; e; e = e.parentElement) {
      const st = getComputedStyle(e);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0)
        return false;
    }
    return true;
  };
  const visible = (el) => {
    if (!rendered(el)) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const productVisible =
    visible(document.querySelector('h1.ui-pdp-title')) ||
    Array.from(document.querySelectorAll('.poly-card')).some(visible);
  const instruction =
    /confirme que voc[eê] [eé] humano|verifique que voc[eê] [eé] humano|verify (?:that )?you are human/i;
  const denial = /hubo un error accediendo|acesso negado|access denied/i;
  const headings = Array.from(document.querySelectorAll('h1:not(.ui-pdp-title),h2,[role="dialog"]'))
    .filter(visible)
    .map((e) => e.innerText.trim());
  const blockingHeading = headings.some(
    (t) => t.length < 250 && (instruction.test(t) || denial.test(t)),
  );
  const blockingPage =
    !productVisible && text.length < 2000 && (instruction.test(text) || denial.test(text));
  const challengeFrame = Array.from(
    document.querySelectorAll('iframe[src*="captcha"],iframe[src*="challenge"]'),
  ).some((e) => {
    if (!visible(e)) return false;
    const r = e.getBoundingClientRect();
    const src = e.getAttribute('src') || '',
      title = e.getAttribute('title') || '';
    return (
      /bframe|\/challenge/i.test(src) ||
      /challenge|desafio|verifica/i.test(title) ||
      (r.width > 200 && r.height > 120 && !/anchor|invisible/i.test(src))
    );
  });
  const challengeContainer = Array.from(
    document.querySelectorAll(
      '[data-testid="captcha"],[data-testid="captcha-challenge"],#captcha,#challenge-container',
    ),
  ).some(
    (e) =>
      visible(e) &&
      (instruction.test(e.innerText) || Boolean(e.querySelector('iframe,input,button'))),
  );
  const challenge = challengeFrame || challengeContainer || blockingHeading || blockingPage;
  const challengeReason =
    challengeFrame || challengeContainer
      ? 'visible_challenge'
      : blockingHeading || blockingPage
        ? denial.test(text)
          ? 'page_denied'
          : 'verification_page'
        : null;
  const login =
    /\/login|\/registration|\/auth\/|\/jms\//i.test(location.pathname) ||
    Boolean(document.querySelector('input[type="password"]'));
  const money = (parent) => {
    if (!rendered(parent)) return null;
    const fractions = parent.querySelectorAll('.andes-money-amount__fraction');
    if (fractions.length !== 1) return null;
    return {
      fraction: fractions[0].textContent.trim(),
      cents: parent.querySelector('.andes-money-amount__cents')?.textContent.trim() || '',
      currency:
        parent.querySelector('.andes-money-amount__currency-symbol')?.textContent.trim() || '',
      context: parent.innerText || '',
    };
  };
  const cards = Array.from(document.querySelectorAll('.poly-card'))
    .slice(0, 100)
    .map((card) => {
      const a = card.querySelector('a.poly-component__title');
      const img = card.querySelector('img');
      return {
        title: a?.textContent.trim() || '',
        url: a?.href || '',
        itemId:
          card.getAttribute('data-item-id') ||
          card.querySelector('[data-item-id]')?.getAttribute('data-item-id') ||
          '',
        image: img?.getAttribute('data-src') || img?.src || '',
        price: money(card.querySelector('.poly-price__current')),
        condition: card.querySelector('.poly-price__current')?.parentElement?.innerText || '',
      };
    });
  const main = document.querySelector('main') || document;
  const selectedSeller = Array.from(main.querySelectorAll('input[type="radio"]')).find(
    (e) => e.checked && /^MLB\d+$/.test(e.id),
  );
  const selectedOffer = selectedSeller?.closest('li');
  const priceBlocks = Array.from((selectedOffer || main).querySelectorAll('.ui-pdp-price')).filter(
    (e) =>
      rendered(e) &&
      (selectedOffer || !e.closest('.ui-pdp-buy-box-offers__offer-list-item,.poly-card')),
  );
  const prices = priceBlocks.flatMap((block) => {
    const primary = block.querySelector('.ui-pdp-price__second-line');
    const context =
      (primary?.closest('.ui-pdp-price__price-breakdown-inline') || primary)?.innerText || '';
    const value = money(primary);
    const condition = /\bpix\b/i.test(context)
      ? 'Pix'
      : /boleto/i.test(context)
        ? 'Boleto'
        : /cart[aã]o de cr[eé]dito/i.test(context)
          ? 'Cartão de crédito'
          : /[aà] vista/i.test(context)
            ? 'Preço à vista anunciado'
            : 'Preço anunciado';
    const options = value ? [{ ...value, context, kind: 'total', condition }] : [];
    for (const subtitle of block.querySelectorAll('.ui-pdp-price__subtitles p')) {
      const text = subtitle.innerText || '';
      const amounts = Array.from(subtitle.querySelectorAll('.andes-money-amount'));
      const installments = text.match(/\bem\s+(\d{1,2})\s*x\b/i);
      // Only an explicit alternative TOTAL followed by installments is eligible.
      if (/^\s*ou\b/i.test(text) && installments && amounts.length === 2) {
        const total = money(amounts[0]);
        if (total)
          options.push({
            ...total,
            context: text,
            kind: 'total',
            condition: `Parcelado em ${installments[1]}x${/sem juros/i.test(text) ? ' sem juros' : ''} (preço total)`,
          });
      }
    }
    return options;
  });
  const identityIds = Array.from(
    main.querySelectorAll(
      'input[name="item_id"],input[name="itemId"],.ui-pdp-buybox [data-item-id],form[data-item-id]',
    ),
  ).map((e) => e.value || e.getAttribute('data-item-id') || '');
  if (selectedSeller) identityIds.push(selectedSeller.id);
  const schemas = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const value = JSON.parse(s.textContent);
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (o['@type'] === 'Product') schemas.push(o);
        if (Array.isArray(o)) o.forEach(walk);
        else if (o['@graph']) walk(o['@graph']);
      };
      walk(value);
    } catch {}
  }
  const purchase =
    selectedOffer ||
    main.querySelector('.ui-pdp-buybox') ||
    main.querySelector('.ui-pdp-container__col.col-2') ||
    main;
  const purchaseText = purchase.innerText || '';
  const buyButtons = Array.from(purchase.querySelectorAll('button,a[role="button"]')).filter(
    (e) => rendered(e) && /^comprar agora$/i.test(e.innerText.trim()),
  );
  const variants = Array.from(
    main.querySelectorAll(
      '[data-testid*="variation"] [aria-selected="true"],.ui-pdp-variations__picker [aria-checked="true"],.ui-pdp-variations__selected-label,.ui-pdp-outside_variations__title',
    ),
  )
    .map((e) => e.textContent.trim())
    .filter(Boolean);
  const variationId =
    main.querySelector('input[name="variation_id"],input[name="variationId"]')?.value || '';
  const hasVariants = Boolean(main.querySelector('.ui-pdp-variations,.ui-pdp-outside_variations'));
  const productImage =
    main.querySelector(
      'figure.ui-pdp-gallery__figure img[data-zoom],img.ui-pdp-image[data-zoom]',
    ) ||
    main.querySelector('figure.ui-pdp-gallery__figure img.ui-pdp-image,img.ui-pdp-image') ||
    main.querySelector('figure.ui-pdp-gallery__figure img');
  return {
    url: location.href,
    loginAttemptLimit,
    challenge,
    challengeReason,
    login,
    cards,
    title: main.querySelector('h1.ui-pdp-title')?.textContent.trim() || '',
    image:
      productImage?.getAttribute('data-zoom') ||
      productImage?.currentSrc ||
      productImage?.src ||
      '',
    prices,
    identityIds,
    publicListingId:
      main
        .querySelector('.ui-vpp-denounce__info')
        ?.textContent.match(/An[uú]ncio\s*#\s*(\d{6,})/i)?.[1]
        ?.replace(/^/, 'MLB') || '',
    selectedSellerId: selectedSeller?.id || '',
    schemas,
    hasVariants,
    variants,
    variationId,
    stock:
      /estoque dispon[ií]vel/i.test(purchaseText) &&
      !/(?:sem estoque|indispon[ií]vel|an[uú]ncio pausado)/i.test(purchaseText),
    stockUnavailable:
      /(?:sem estoque|indispon[ií]vel|an[uú]ncio pausado|n[aã]o podemos enviar este produto)/i.test(
        purchaseText,
      ),
    buyEnabled:
      buyButtons.length === 1 &&
      !buyButtons[0].disabled &&
      buyButtons[0].getAttribute('aria-disabled') !== 'true',
    priceContext: main.querySelector('.ui-pdp-price')?.innerText || prices[0]?.context || '',
    heading: main.querySelector('h1')?.textContent.trim() || '',
  };
}

export function snapshotFromDocument(doc, requestedUrl, now = Date.now()) {
  if (doc.loginAttemptLimit) throw new CaptureError('source_browser_login_attempt_limit');
  if (doc.challenge) throw new CaptureError('source_browser_challenge');
  if (doc.login) throw new CaptureError('source_browser_login_required');
  const id = listingId(requestedUrl);
  if (!id) throw new CaptureError('source_browser_identity_unknown');
  if (doc.selectedSellerId && doc.selectedSellerId !== id)
    throw new CaptureError('source_browser_identity_unknown');
  if (doc.publicListingId && doc.publicListingId !== id)
    throw new CaptureError('source_browser_identity_unknown');
  const final = marketUrl(doc.url);
  const finalId = listingId(doc.url);
  const schemaOffers = doc.schemas.flatMap((s) =>
    Array.isArray(s.offers) ? s.offers : s.offers ? [s.offers] : [],
  );
  const identities = new Set([
    ...(/^MLB\d+$/.test(doc.publicListingId || '') ? [doc.publicListingId] : []),
    ...doc.identityIds.filter((x) => /^MLB\d+$/.test(x)),
    ...schemaOffers.map((o) => listingId(o.url)).filter(Boolean),
  ]);
  const direct =
    !final.pathname.includes('/p/') &&
    /\/MLB-?\d+(?:-|\/|$)/i.test(final.pathname) &&
    finalId === id;
  if (!direct && !identities.has(id)) throw new CaptureError('source_browser_identity_unknown');
  if (finalId && finalId !== id) throw new CaptureError('source_browser_identity_unknown');
  if (!doc.title || !doc.prices.length) throw new CaptureError('source_browser_price_ambiguous');
  const restricted = /(?:m[eé]li\+|primeira compra|assinante|cupom|cart[aã]o mercado pago|saldo)/i;
  const options = doc.prices
    .filter((p) => p.kind === 'total' || (doc.prices.length === 1 && !p.kind))
    .filter((p) => p.currency === 'R$' && !restricted.test(p.context ?? doc.priceContext))
    .map((p) => ({
      price: brlCents(p.fraction, p.cents),
      condition:
        p.condition ||
        (/pix/i.test(p.context ?? doc.priceContext) ? 'Pix' : 'Preço à vista anunciado'),
    }))
    .sort((a, b) => a.price - b.price);
  if (!options.length) throw new CaptureError('source_browser_price_ambiguous');
  const { price, condition } = options[0];
  if (doc.hasVariants && !doc.variationId && !doc.variants.length)
    throw new CaptureError('source_browser_identity_unknown');
  const variant = doc.variationId || doc.variants.join(' / ');
  return {
    marketplace: 'mercadolivre',
    productKey: id,
    variant,
    title: doc.title,
    productUrl: cleanProductUrl(requestedUrl),
    imageUrl: /^https:\/\//.test(doc.image) ? doc.image : '',
    priceCents: price,
    oldPriceCents: null,
    available: Boolean(doc.stock && doc.buyEnabled && !doc.stockUnavailable),
    stockStatus: doc.stockUnavailable
      ? 'unavailable'
      : doc.stock && doc.buyEnabled
        ? 'available'
        : 'unknown',
    observedAt: new Date(now).toISOString(),
    source: 'mercadolivre_web',
    priceCondition: condition,
    evidence: {
      url: cleanProductUrl(requestedUrl),
      identityVerified: true,
      stockTextObserved: doc.stock,
      buyEnabled: doc.buyEnabled,
      variant,
      priceCondition: condition,
    },
  };
}

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
