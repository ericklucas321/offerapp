export const STORE_ADAPTERS = {
  mercadolivre: {
    label: 'Mercado Livre',
    search: (q) =>
      `https://lista.mercadolivre.com.br/${encodeURIComponent(q.replaceAll(' ', '-'))}`,
  },
  amazon: {
    label: 'Amazon',
    search: (q) => `https://www.amazon.com.br/s?k=${encodeURIComponent(q)}`,
  },
  shopee: {
    label: 'Shopee',
    search: (q) => `https://shopee.com.br/search?keyword=${encodeURIComponent(q)}`,
  },
};

export function findProducts(marketplace) {
  const text = document.body.innerText.slice(0, 4000);
  if (/verifique que voc[eê]|verify you are|captcha|acesso negado|limite de tentativas/i.test(text))
    return {
      error: 'A loja pediu uma verificação. Confira o navegador e valide novamente.',
      code: 'store_verification_required',
    };
  const matches = {
    mercadolivre: /MLB-?\d{6,}|\/p\/MLB\d+/i,
    amazon: /\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i,
    shopee: /-i\.\d+\.\d+|\/product\/\d+\/\d+/,
  };
  const hosts = {
    mercadolivre: /(^|\.)mercadolivre\.com\.br$/,
    amazon: /(^|\.)amazon\.com\.br$/,
    shopee: /(^|\.)shopee\.com\.br$/,
  };
  const urls = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    try {
      const u = new URL(a.href);
      if (
        u.protocol === 'https:' &&
        hosts[marketplace].test(u.hostname) &&
        matches[marketplace].test(u.pathname)
      ) {
        if (marketplace === 'mercadolivre') {
          const fragment = new URLSearchParams(u.hash.slice(1));
          for (const key of ['wid', 'variation', 'variation_id', 'attributes']) {
            const value = u.searchParams.get(key) || fragment.get(key);
            if (value) u.searchParams.set(key, value);
          }
        }
        u.hash = '';
        urls.add(u.href);
      }
    } catch {}
    if (urls.size >= 20) break;
  }
  if (!urls.size) {
    if (/não encontramos resultados|nenhum resultado|no results for/i.test(text)) return [];
    return null;
  }
  return [...urls];
}

export function readProduct(marketplace) {
  const visible = (e) =>
    !!e &&
    e.getBoundingClientRect().width > 0 &&
    e.getBoundingClientRect().height > 0 &&
    getComputedStyle(e).visibility !== 'hidden' &&
    !e.closest('[hidden],[aria-hidden="true"]');
  const main = document.querySelector('main') || document.body;
  const text = main.innerText;
  if (
    /verifique que voc[eê]|verify you are|acesso negado|limite de tentativas/i.test(
      text.slice(0, 2000),
    )
  )
    throw new Error('A loja pediu verificação. Confira o navegador.');
  const selectors =
    marketplace === 'amazon'
      ? {
          title: '#productTitle',
          price:
            '#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen, #corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
          image: '#landingImage',
          stock: '#availability',
          buy: '#add-to-cart-button, #buy-now-button',
          variant: '#variation_size_name .selection, #variation_color_name .selection',
        }
      : {
          title: 'h1',
          price: '[data-testid="product-price"]',
          image: '[data-testid="product-image"] img',
          stock: '[data-testid="product-stock"]',
          buy: 'button[data-testid="add-to-cart"]',
          variant: '[data-testid="selected-variation"]',
        };
  const products = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if ([value['@type']].flat().includes('Product')) products.push(value);
    if (value['@graph']) visit(value['@graph']);
  };
  for (const script of document.querySelectorAll('script[type="application/ld+json"]'))
    try {
      visit(JSON.parse(script.textContent));
    } catch {}
  const identity = (url) => {
    try {
      const path = new URL(url, location.href).pathname;
      return marketplace === 'amazon'
        ? path.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase()
        : path
            .match(/(?:-i\.|\/product\/)(\d+)[./](\d+)/)
            ?.slice(1)
            .join('.');
    } catch {
      return null;
    }
  };
  const candidate = products.length === 1 ? products[0] : null;
  const schemaUrls = [
    candidate?.url,
    candidate?.['@id'],
    ...[candidate?.offers].flat().map((o) => o?.url),
  ].filter(Boolean);
  const schema = schemaUrls.some(
    (url) => identity(url) && identity(url) === identity(location.href),
  )
    ? candidate
    : null;
  const schemaOffers = [schema?.offers].flat().filter(Boolean);
  const offer = schemaOffers.length === 1 ? schemaOffers[0] : null;
  if (
    offer &&
    (offer['@type'] === 'AggregateOffer' ||
      offer.lowPrice !== undefined ||
      offer.highPrice !== undefined)
  )
    throw new Error('O produto tem uma faixa de preços. Selecione uma variante antes de validar.');
  const title = document.querySelector(selectors.title)?.textContent.trim() || schema?.name;
  const priceText = document.querySelector(selectors.price)?.textContent || '';
  if (/cupom|primeira compra|assinante|cart[aã]o|m[eé]li\+/i.test(priceText))
    throw new Error('Preço condicionado a benefício não confirmado. Confira a oferta.');
  const match = priceText.match(/R\$\s*([\d.]+),(\d{2})/);
  const schemaCents = offer?.priceCurrency === 'BRL' ? Math.round(Number(offer.price) * 100) : null;
  const domCents = match ? Number(match[1].replaceAll('.', '')) * 100 + Number(match[2]) : null;
  if (
    !title ||
    !(domCents || schemaCents) ||
    (domCents && schemaCents && domCents !== schemaCents) ||
    /\d+,\d{2}\s*[-–]/.test(priceText)
  )
    throw new Error('Preço ou variante não confirmados. Esta loja precisa de ajuste na leitura.');
  const stockText = document.querySelector(selectors.stock)?.textContent || '';
  const buy =
    document.querySelector(selectors.buy) ||
    [...main.querySelectorAll('button')].find(
      (b) => visible(b) && /comprar agora|adicionar ao carrinho/i.test(b.textContent),
    );
  const unavailable =
    /indispon[ií]vel|sem estoque|out of stock/i.test(stockText) ||
    /OutOfStock|Discontinued|SoldOut/.test(offer?.availability || '');
  const stockStatus = unavailable
    ? 'unavailable'
    : (/em estoque|dispon[ií]vel/i.test(stockText) || /InStock$/.test(offer?.availability || '')) &&
        visible(buy) &&
        !buy.disabled
      ? 'available'
      : 'unknown';
  const variant = [...document.querySelectorAll(selectors.variant)]
    .map((e) => e.textContent.trim())
    .join(' / ');
  if (marketplace === 'shopee' && /selecionar varia[cç][aã]o/i.test(text))
    throw new Error('Selecione uma variante antes de validar.');
  const img = document.querySelector(selectors.image);
  const schemaImage =
    typeof schema?.image === 'string'
      ? schema.image
      : Array.isArray(schema?.image)
        ? schema.image[0]
        : '';
  return {
    title,
    priceCents: domCents || schemaCents,
    imageUrl: img?.src || schemaImage || '',
    productUrl: location.href,
    variant,
    stockStatus,
    priceCondition: /pix/i.test(priceText) ? 'Pix' : 'Preço à vista anunciado',
    observedAt: new Date().toISOString(),
  };
}

export function clickAffiliate(marketplace) {
  const visible = (e) =>
    !!e &&
    e.getBoundingClientRect().width > 0 &&
    e.getBoundingClientRect().height > 0 &&
    getComputedStyle(e).visibility !== 'hidden' &&
    !e.closest('[hidden],[aria-hidden="true"]');
  const containers = {
    mercadolivre: '[class*="affiliate"], [id*="affiliate"], [data-testid*="affiliate"]',
    amazon: '#amzn-ss-wrap, #amzn-ss',
    shopee: '[class*="affiliate"], [data-testid*="affiliate"]',
  };
  const root =
    (marketplace === 'mercadolivre' &&
      [...document.querySelectorAll('.toolbar')].find(
        (e) => visible(e) && /^Afiliados$/i.test(e.querySelector('h4')?.textContent.trim() || ''),
      )) ||
    document.querySelector(containers[marketplace]);
  if (!visible(root))
    throw new Error('A ferramenta afiliada não está visível. Confira a conta da loja.');
  const candidates = [...root.querySelectorAll('button,a,[role="button"]')].filter(visible);
  const button = candidates.find(
    (e) =>
      /^(gerar link|obter link|criar link|texto|link personalizado)$/i.test(e.textContent.trim()) ||
      (root && /gerar link|obter link|compartilhar/i.test(e.textContent)),
  );
  if (!button)
    throw new Error(
      'Gerador afiliado não encontrado. Entre na sua conta afiliada e abra a ferramenta da loja.',
    );
  button.click();
  return true;
}

export function closeAffiliate(marketplace) {
  if (marketplace !== 'mercadolivre') return false;
  const visible = (e) =>
    !!e &&
    e.getBoundingClientRect().width > 0 &&
    e.getBoundingClientRect().height > 0 &&
    getComputedStyle(e).visibility !== 'hidden' &&
    !e.closest('[hidden],[aria-hidden="true"]');
  const popover = [...document.querySelectorAll('[data-tippy-root]')].find(
    (e) => visible(e) && /Gerar link\s*\/\s*ID de produto/i.test(e.innerText),
  );
  const close =
    popover &&
    [...popover.querySelectorAll('button')].find(
      (e) => visible(e) && /^close$/i.test(e.getAttribute('aria-label') || e.textContent.trim()),
    );
  if (!close)
    throw new Error('Não foi possível reabrir o gerador afiliado. Confira a aba da loja.');
  close.click();
  return true;
}

export function readAffiliate(marketplace, waiting = false) {
  const visible = (e) =>
    !!e &&
    e.getBoundingClientRect().width > 0 &&
    e.getBoundingClientRect().height > 0 &&
    getComputedStyle(e).visibility !== 'hidden' &&
    !e.closest('[hidden],[aria-hidden="true"]');
  const patterns = {
    mercadolivre: /https:\/\/meli\.la\/[A-Za-z0-9_-]+/,
    amazon:
      /https:\/\/(?:amzn\.to\/[A-Za-z0-9]+|(?:www\.)?amazon\.com\.br\/[^\s"<>]*[?&]tag=[^\s"<>]+)/,
    shopee: /https:\/\/(?:s\.shopee\.com\.br|shope\.ee)\/[A-Za-z0-9_-]+/,
  };
  const scopes = {
    mercadolivre: '[class*="affiliate"], [id*="affiliate"], [data-testid*="affiliate"]',
    amazon: '#amzn-ss-wrap, #amzn-ss',
    shopee: '[class*="affiliate"], [data-testid*="affiliate"]',
  };
  const roots = [...document.querySelectorAll(scopes[marketplace])].filter(visible);
  if (marketplace === 'mercadolivre')
    roots.push(
      ...[...document.querySelectorAll('[data-tippy-root]')].filter(
        (e) => visible(e) && /Gerar link\s*\/\s*ID de produto/i.test(e.innerText),
      ),
    );
  for (const dialog of document.querySelectorAll('[role="dialog"],dialog'))
    if (
      visible(dialog) &&
      /afiliad|sitestripe|gerar link|obter link|link personalizado/i.test(dialog.innerText || '')
    )
      roots.push(dialog);
  for (const root of roots)
    for (const e of root.querySelectorAll('input,textarea')) {
      if (!visible(e)) continue;
      const match = (e.value || e.innerText || '').match(patterns[marketplace]);
      if (match) return match[0];
    }
  if (waiting) return null;
  throw new Error(
    'O gerador não apresentou um link afiliado verificável. Confira a loja no navegador.',
  );
}
