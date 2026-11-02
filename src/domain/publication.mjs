import { RULES, repeatAllowed, publicationWindow, createPublicationWindow } from './rules.mjs';
import { captureStock } from '../shared/capture-contract.mjs';
import { couponPrice } from './pricing.mjs';
import { normalizeImageUrl, detectMarketplace, extractProductKey } from './messages.mjs';
import { checkAutomaticDelivery } from './automatic.mjs';

export function assertEvidenceAtSchedule(offer, at) {
  if (offer.source !== 'manual') return;
  const age = Date.parse(at) - Date.parse(offer.verified_at);
  if (!Number.isFinite(age) || age < 0 || age > RULES.freshnessMs)
    throw new Error('publication_evidence_expires_before_schedule');
}
export function checkOffer(offer, capture, now = Date.now()) {
  if (!offer) return { allowed: false, reason: 'Oferta não encontrada' };
  if (offer.discarded_at)
    return { allowed: false, reason: 'Oferta descartada; cadastre uma nova oferta para revisar' };
  try {
    normalizeImageUrl(offer.marketplace, offer.image_url);
  } catch {
    return { allowed: false, reason: 'Revise a imagem da oferta; use uma imagem da própria loja' };
  }
  if (
    ['domain_only', 'product_id_match'].includes(offer.affiliate_validation) ||
    !offer.affiliate_url
  )
    return { allowed: false, reason: 'Confirme o link gerado na sua conta' };
  try {
    couponPrice(offer.price_cents, offer.coupon, JSON.parse(offer.coupon_rules || 'null'));
  } catch {
    return { allowed: false, reason: 'Cupom expirado ou inválido; revise a oferta' };
  }
  let at = offer.verified_at,
    stock = offer.stock_status;
  if (['extension', 'browser'].includes(offer.source)) {
    if (!capture || capture.stage !== 'product')
      return { allowed: false, reason: 'Abra o produto e atualize a captura' };
    if (
      capture.product_key !== offer.product_key ||
      capture.variant !== offer.variant ||
      (capture.product_url !== offer.product_url &&
        !(
          offer.source === 'browser' &&
          detectMarketplace(capture.product_url) === offer.marketplace &&
          extractProductKey(offer.marketplace, capture.product_url) === offer.product_key
        ))
    )
      return { allowed: false, reason: 'Produto ou variante mudou; revise a oferta' };
    at = capture.observed_at;
    stock = captureStock(capture);
    if (capture.price_cents !== offer.price_cents)
      return { allowed: false, reason: 'O preço mudou; revise a mensagem antes de aprovar' };
  }
  if (stock !== 'available')
    return {
      allowed: false,
      reason: stock === 'unavailable' ? 'Produto indisponível' : 'Confirme preço e estoque',
    };
  const age = now - Date.parse(at);
  if (!Number.isFinite(age) || age < 0 || age > RULES.freshnessMs)
    return { allowed: false, reason: 'Preço antigo; atualize a captura ou os dados' };
  return { allowed: true, reason: '' };
}
export function nextPublicationAt(sent, now = Date.now(), group = {}) {
  if (!Number.isFinite(now) || sent.some((row) => !Number.isFinite(Date.parse(row.sent_at))))
    throw new Error('invalid_schedule');
  const window = createPublicationWindow(sent, group);
  if (window(now).allowed) return new Date(now).toISOString();
  const last = sent.reduce((value, row) => Math.max(value, Date.parse(row.sent_at)), 0);
  const start = Math.max(now, last + (group.interval_minutes ?? 60) * 60000);
  for (let at = Math.ceil(start / 60000) * 60000; at <= start + 3 * 86400000; at += 60000)
    if (window(at).allowed) return new Date(at).toISOString();
  throw new Error('invalid_schedule');
}
export class PublicationPolicy {
  constructor({ store, now = Date.now }) {
    Object.assign(this, { store, now });
  }
  ready(offer, destination = null) {
    if (
      offer?.source === 'browser' &&
      this.store
        .prepare('SELECT state FROM store_connections WHERE marketplace=?')
        .get(offer.marketplace)?.state !== 'ready'
    )
      return {
        allowed: false,
        reason: 'Conexão da loja suspensa; valide novamente em Configurações',
      };
    if (offer && this.store.otherPendingProduct(offer, destination))
      return {
        allowed: false,
        reason: 'Já existe envio pendente ou incerto para este produto; confira antes de reenviar',
      };
    const check = checkOffer(offer, this.store.evidenceFor(offer), this.now());
    if (
      check.allowed &&
      !repeatAllowed(
        this.store.lastPublication(
          offer.product_key,
          offer.variant,
          destination,
          offer.marketplace,
        ),
        offer.final_price_cents ?? offer.price_cents,
        this.now(),
      )
    )
      return {
        allowed: false,
        reason: 'Publicado nas últimas 72 horas; exige queda adicional de 10%',
      };
    return check;
  }
  preflight(job) {
    if (this.store.setting('publication_paused', 'true') === 'true')
      return { allowed: false, reason: 'Envios pausados' };
    const cancel = (reason) => {
      this.store.blockDelivery(job.delivery_id, reason);
      return { allowed: false, reason };
    };
    const group = this.store
      .prepare('SELECT * FROM destination_groups WHERE id=?')
      .get(job.delivery_destination);
    if (
      !group?.enabled ||
      (job.group_revision != null &&
        (!group || !group.enabled || group.revision !== job.group_revision)) ||
      (job.group_revision == null &&
        job.delivery_destination !== this.store.setting('whatsapp_group_id'))
    )
      return cancel('Grupo de destino mudou; revise e aprove novamente');
    if (!job.approved_message)
      return { allowed: false, reason: 'Envio antigo sem aprovação; cancele e revise a oferta' };
    const offer = this.store.getOffer(job.offer_id),
      meta = JSON.parse(job.approved_metadata || '{}');
    if (job.mode === 'automatic') {
      const check = checkAutomaticDelivery(this.store, offer, job.delivery_destination);
      if (!check.allowed) return cancel(check.reason);
    }
    if (
      meta.defaultDestination !== undefined &&
      meta.defaultDestination !== this.store.setting('whatsapp_group_id')
    )
      return cancel('Grupo de destino mudou; revise e aprove novamente');
    if (
      !offer ||
      offer.product_key !== meta.productKey ||
      offer.variant !== meta.variant ||
      offer.product_url !== meta.url ||
      offer.affiliate_url !== meta.affiliateUrl ||
      offer.title !== meta.title ||
      offer.note !== meta.note ||
      (meta.image !== undefined && offer.image_url !== meta.image)
    )
      return cancel('Oferta mudou após aprovação; revise novamente');
    try {
      couponPrice(offer.price_cents, offer.coupon, JSON.parse(offer.coupon_rules || 'null'));
    } catch {
      return cancel('Cupom expirado ou inválido; revise a oferta');
    }
    const capture = this.store.evidenceFor(offer);
    if (
      ['extension', 'browser'].includes(offer.source) &&
      capture &&
      capture.price_cents <= job.approved_price_cents &&
      capture.price_condition === meta.priceCondition
    ) {
      Object.assign(job, this.store.updateCapturePrice(offer.id, capture));
    }
    const current = this.store.getOffer(job.offer_id);
    if (
      current.price_cents > job.approved_price_cents ||
      (capture && capture.price_cents > job.approved_price_cents)
    )
      return cancel('Preço aumentou após aprovação; revise novamente');
    if (capture && capture.price_condition !== meta.priceCondition)
      return cancel('Condição de pagamento mudou; revise novamente');
    const ready = this.ready(current, job.delivery_destination);
    if (!ready.allowed) {
      if (current.source === 'manual') {
        const at = current.verified_at;
        if (!Number.isFinite(Date.parse(at)) || this.now() - Date.parse(at) > RULES.freshnessMs)
          return cancel(
            'Confirmação de preço e estoque expirou; confira a oferta e aprove novamente',
          );
      }
      return ready;
    }
    return publicationWindow(
      this.store.sentDeliveries(job.delivery_destination),
      this.now(),
      group || {},
    );
  }
}
