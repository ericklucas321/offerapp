import crypto from 'node:crypto';
const MARKETPLACES = Object.freeze({
  mercadolivre: {
    label: 'Mercado Livre',
    productHosts: ['mercadolivre.com.br', 'mercadolivre.com'],
    affiliateHosts: ['mercadolivre.com.br', 'mercadolivre.com', 'meli.la'],
  },
  amazon: {
    label: 'Amazon',
    productHosts: ['amazon.com.br', 'www.amazon.com.br'],
    affiliateHosts: ['amazon.com.br', 'www.amazon.com.br', 'amzn.to'],
  },
  shopee: {
    label: 'Shopee',
    productHosts: ['shopee.com.br', 'www.shopee.com.br'],
    affiliateHosts: ['shopee.com.br', 'www.shopee.com.br', 's.shopee.com.br', 'shope.ee'],
  },
});

function safeUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port ? u : null;
  } catch {
    return null;
  }
}

function hostMatches(host, allowed) {
  const h = host.toLowerCase();
  return allowed.some((x) => h === x || h.endsWith(`.${x}`));
}

export function detectMarketplace(url) {
  const u = safeUrl(url);
  if (!u) return null;
  for (const [key, cfg] of Object.entries(MARKETPLACES)) {
    if (hostMatches(u.hostname, [...cfg.productHosts, ...cfg.affiliateHosts])) return key;
  }
  return null;
}

export function extractProductKey(marketplace, url) {
  const u = safeUrl(url);
  if (!u) return null;
  const text = `${u.pathname}${u.search}`;

  if (marketplace === 'mercadolivre') {
    const selected = u.searchParams.get('wid') || new URLSearchParams(u.hash.slice(1)).get('wid');
    if (/^MLB[0-9]{6,}$/i.test(selected || '')) return selected.toUpperCase();
    const mlb = text.match(/\bMLB[-_]?([0-9]{6,})\b/i);
    if (mlb) return `MLB${mlb[1]}`.toUpperCase();
    const p = text.match(/\/p\/([A-Z0-9-]{6,})/i);
    return p ? p[1].toUpperCase() : null;
  }

  if (marketplace === 'amazon') {
    const asin = text.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    return asin ? asin[1].toUpperCase() : null;
  }

  if (marketplace === 'shopee') {
    const item =
      text.match(/(?:-i\.)(\d+)\.(\d+)/i) ||
      text.match(/\/product\/(\d+)\/(\d+)/i) ||
      text.match(/[?&]itemid=(\d+)/i);
    if (!item) return null;
    return item.length >= 3 ? `${item[1]}.${item[2]}` : item[1];
  }

  return null;
}

function normalizeBaseUrl(url) {
  const u = safeUrl(url);
  if (!u) throw new Error('invalid_url');
  if (hostMatches(u.hostname, MARKETPLACES.mercadolivre.productHosts)) {
    const fragment = new URLSearchParams(u.hash.slice(1));
    for (const key of ['wid', 'variation', 'variation_id', 'attributes']) {
      const value = u.searchParams.get(key) || fragment.get(key);
      if (value) u.searchParams.set(key, value);
    }
  }
  u.hash = '';
  return u.toString();
}

export function productIdentity(marketplace, url) {
  const key = extractProductKey(marketplace, url);
  if (key) return key;
  const u = safeUrl(url);
  if (!u || detectMarketplace(url) !== marketplace) throw new Error('product_marketplace_mismatch');
  u.hash = '';
  u.hostname = u.hostname.replace(/^www\./, '');
  for (const name of [...u.searchParams.keys()]) {
    if (
      /^utm_/i.test(name) ||
      [
        'ref',
        'source',
        'tracking_id',
        'matt_tool',
        'matt_word',
        'matt_source',
        'matt_campaign_id',
        'matt_ad_group_id',
        'matt_match_type',
        'matt_network',
        'matt_device',
        'matt_creative',
        'matt_keyword',
        'matt_ad_position',
        'matt_ad_type',
        'matt_merchant_id',
        'matt_product_id',
        'matt_product_partition_id',
        'matt_target_id',
      ].includes(name.toLowerCase())
    )
      u.searchParams.delete(name);
  }
  u.searchParams.sort();
  return 'url:' + crypto.createHash('sha256').update(u.toString()).digest('hex');
}

export function validateAffiliateUrl(marketplace, productUrl, affiliateUrl) {
  const cfg = MARKETPLACES[marketplace];
  if (!cfg) return { ok: false, reason: 'unsupported_marketplace' };
  const a = safeUrl(affiliateUrl);
  if (!a || !hostMatches(a.hostname, cfg.affiliateHosts)) {
    return { ok: false, reason: 'invalid_affiliate_domain' };
  }

  if (marketplace === 'amazon' && a.hostname !== 'amzn.to' && !a.searchParams.get('tag'))
    return { ok: false, reason: 'affiliate_tag_required' };
  if (marketplace === 'mercadolivre' && a.hostname !== 'meli.la')
    return { ok: false, reason: 'official_short_link_required' };
  if (marketplace === 'shopee' && !['s.shopee.com.br', 'shope.ee'].includes(a.hostname))
    return { ok: false, reason: 'official_short_link_required' };
  const productKey = extractProductKey(marketplace, productUrl);
  const affiliateKey = extractProductKey(marketplace, affiliateUrl);
  if (productKey && affiliateKey && productKey !== affiliateKey) {
    return { ok: false, reason: 'affiliate_product_mismatch' };
  }

  return {
    ok: true,
    validation: productKey && affiliateKey ? 'product_id_match' : 'domain_only',
  };
}

export function buildAmazonAffiliateUrl(productUrl, partnerTag) {
  const asin = extractProductKey('amazon', productUrl);
  if (!asin || !partnerTag) return null;
  return `https://www.amazon.com.br/dp/${asin}?tag=${encodeURIComponent(partnerTag)}`;
}

export function normalizeImageUrl(marketplace, value) {
  if (!value) return '';
  const image = safeUrl(value);
  const hosts = {
    mercadolivre: ['mlstatic.com'],
    amazon: ['media-amazon.com', 'images-amazon.com'],
    shopee: ['susercontent.com', 'shopee.com.br', 'shopee.sg', 'shopeemobile.com'],
  };
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !image ||
    !hostMatches(image.hostname, hosts[marketplace] || [])
  )
    throw new Error('invalid_image_url');
  return image.href;
}

export function normalizeOfferInput(input, env = process.env) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('invalid_request');
  const productUrl = normalizeBaseUrl(String(input.productUrl || input.affiliateUrl || '').trim());
  const marketplace = input.marketplace || detectMarketplace(productUrl);
  if (!MARKETPLACES[marketplace]) throw new Error('unsupported_marketplace');

  if (detectMarketplace(productUrl) !== marketplace)
    throw new Error('product_marketplace_mismatch');
  const productKey = productIdentity(marketplace, productUrl);
  let affiliateUrl = String(input.affiliateUrl || '').trim();
  if (
    !affiliateUrl &&
    marketplace !== 'amazon' &&
    ['meli.la', 's.shopee.com.br', 'shope.ee'].includes(new URL(productUrl).hostname)
  )
    affiliateUrl = productUrl;

  if (!affiliateUrl && marketplace === 'amazon') {
    affiliateUrl = buildAmazonAffiliateUrl(productUrl, env.AMAZON_PARTNER_TAG || '');
  }

  if (!affiliateUrl) throw new Error('affiliate_link_required');
  affiliateUrl = normalizeBaseUrl(affiliateUrl);

  const validation = validateAffiliateUrl(marketplace, productUrl, affiliateUrl);
  if (!validation.ok) throw new Error(validation.reason);
  if (new URL(affiliateUrl).hostname === 'amzn.to' || marketplace !== 'amazon') {
    if (input.affiliateConfirmed !== true) throw new Error('affiliate_confirmation_required');
    validation.validation = 'operator_confirmed_unverified';
  } else {
    const tag = new URL(affiliateUrl).searchParams.get('tag');
    if (env.AMAZON_PARTNER_TAG && tag !== env.AMAZON_PARTNER_TAG)
      throw new Error('affiliate_tag_mismatch');
    if (!env.AMAZON_PARTNER_TAG && input.affiliateConfirmed !== true)
      throw new Error('affiliate_confirmation_required');
    validation.validation = env.AMAZON_PARTNER_TAG
      ? 'configured_partner_tag'
      : 'operator_confirmed_unverified';
  }

  if (input.available === false) throw new Error('product_unavailable');
  const priceCents = toCents(input.price);
  const oldPriceCents =
    input.oldPrice === '' || input.oldPrice == null ? null : toCents(input.oldPrice);
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('title_required');
  if (
    input.title.length > 500 ||
    String(input.note || '').length > 1000 ||
    String(input.variant || '').length > 200 ||
    productUrl.length > 2048 ||
    affiliateUrl.length > 2048
  )
    throw new Error('invalid_request');
  if (
    !Number.isSafeInteger(priceCents) ||
    priceCents <= 0 ||
    priceCents > 1000000000 ||
    (oldPriceCents != null && (!Number.isSafeInteger(oldPriceCents) || oldPriceCents > 1000000000))
  )
    throw new Error('invalid_price');
  if (oldPriceCents != null && oldPriceCents < priceCents) throw new Error('old_price_below_price');

  return {
    marketplace,
    productKey,
    productUrl,
    affiliateUrl,
    affiliateValidation: validation.validation,
    title: String(input.title).trim(),
    priceCents,
    oldPriceCents,
    coupon: String(input.coupon || '').trim(),
    note: String(input.note || '').trim(),
    imageUrl: normalizeImageUrl(marketplace, String(input.imageUrl || '').trim()),
    variant: String(input.variant || '').trim(),
    couponRules: input.couponRules || null,
  };
}

export function toCents(value) {
  if (typeof value === 'number') return Math.round(value * 100);
  const cleaned = String(value ?? '')
    .trim()
    .replace(/R\$/gi, '')
    .replace(/\s/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export function money(cents) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

export function marketplaceLabel(key) {
  return MARKETPLACES[key]?.label || key;
}

export function formatOfferMessage(offer) {
  const fullTitle = String(offer.title || '')
    .replace(/\s+/g, ' ')
    .trim();
  const title =
    fullTitle.length > 90 ? fullTitle.slice(0, 89).replace(/\s+\S*$/, '') + '…' : fullTitle;
  const lines = [`*${title}*`];
  if (
    offer.variant &&
    !/^\d+$/.test(String(offer.variant).trim()) &&
    !title.toLocaleLowerCase('pt-BR').includes(String(offer.variant).toLocaleLowerCase('pt-BR'))
  )
    lines.push(String(offer.variant).replace(/\s+/g, ' ').trim());
  lines.push('');
  const old = Number(offer.old_price_cents),
    price = Number(offer.price_cents);
  if (old > price) lines.push(`De ~${money(old)}~`);
  const payment = {
    Pix: 'no Pix',
    Boleto: 'no boleto',
    'Cartão de crédito': 'no cartão de crédito',
    'Preço à vista anunciado': 'à vista',
    'Preço anunciado': '',
  };
  const condition = offer.price_condition || '';
  const paymentText = Object.hasOwn(payment, condition) ? payment[condition] : condition;
  lines.push(`💰 *${money(price)}*${paymentText ? ` ${paymentText}` : ''}`);
  if (offer.coupon) {
    lines.push(
      '',
      `🎟 Cupom: *${String(offer.coupon)
        .replace(/[\r\n]+/g, ' ')
        .trim()}*`,
    );
    if (offer.final_price_cents != null && offer.final_price_cents < price)
      lines.push(`Com cupom: *${money(offer.final_price_cents)}* (estimativa)`);
    lines.push(
      offer.coupon_condition || 'Confira a elegibilidade e as regras do cupom no checkout.',
    );
  }
  if (offer.note && offer.note !== offer.price_condition) lines.push('', String(offer.note).trim());
  lines.push(
    '',
    `🛒 ${offer.affiliate_url}`,
    '',
    'Link afiliado • preço e estoque sujeitos a alteração.',
  );
  return lines.join('\n');
}
