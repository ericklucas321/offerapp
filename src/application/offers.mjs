import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { captureStock, validateBrowserCapture } from '../shared/capture-contract.mjs';
import { nextPublicationAt, assertEvidenceAtSchedule } from '../domain/publication.mjs';
import { RULES } from '../domain/rules.mjs';
import { detectMarketplace, normalizeOfferInput } from '../domain/messages.mjs';
const DELIVERY_ITEM_STATE = Object.freeze({
  queued: 'scheduled',
  sending: 'sending',
  uncertain: 'uncertain',
  sent: 'sent',
  failed: 'failed',
});
export class Offers {
  constructor({ store, policy, env = {}, now = Date.now }) {
    Object.assign(this, { store, policy, env, now });
  }
  capture(packet, confirmed) {
    if (confirmed !== true) throw new Error('browser_import_confirmation');
    const items = validateBrowserCapture(packet, this.now());
    this.store.importCaptures(items);
    return this.list();
  }
  prepare(id, data) {
    const c = this.store.capture(id);
    if (!c) throw new Error('browser_import_invalid');
    if (c.stage !== 'product') throw new Error('browser_import_product_required');
    if (captureStock(c) !== 'available')
      throw Object.assign(new Error('browser_import_unavailable'), {
        userMessage:
          captureStock(c) === 'unavailable'
            ? 'Produto indisponível na página; a oferta permanece pendente.'
            : 'Estoque desconhecido. Abra o produto e capture novamente para confirmar.',
      });
    if (this.now() - Date.parse(c.observed_at) > RULES.freshnessMs)
      throw new Error('browser_import_stale');
    const input = {
      productUrl: c.product_url,
      affiliateUrl: data.affiliateUrl,
      affiliateConfirmed: data.affiliateConfirmed,
      title: data.title || c.title,
      price: c.price_cents / 100,
      imageUrl: c.image_url,
      variant: c.variant,
      note: data.note ?? c.price_condition,
    };
    let offer;
    if (c.offer_id && !this.store.getOffer(c.offer_id)?.published_at) {
      offer = this.store.editOffer(c.offer_id, input, this.env);
    } else {
      offer = this.store.createOffer(input, { env: this.env });
      this.store.bindCapture(c.id, offer.id);
    }
    return this.store.setOfferEvidence(offer.id, {
      source: 'extension',
      captureId: c.id,
      verifiedAt: c.observed_at,
      stockStatus: 'available',
    });
  }
  manual(data, id) {
    const existing = id && this.store.getOffer(id);
    if (existing?.source === 'browser') {
      const env =
        existing.marketplace === 'amazon'
          ? {
              ...this.env,
              AMAZON_PARTNER_TAG:
                new URL(existing.affiliate_url).searchParams.get('tag') ||
                this.env.AMAZON_PARTNER_TAG,
            }
          : this.env;
      return this.store.editOffer(id, { title: data.title, note: data.note }, env);
    }
    if (existing?.source === 'extension') throw new Error('offer_identity_locked');
    if (data.marketplace && !['mercadolivre', 'amazon', 'shopee'].includes(data.marketplace))
      throw new Error('unsupported_marketplace');
    data = { ...data, marketplace: data.marketplace || detectMarketplace(data.productUrl || '') };
    let offer;
    if (existing?.source === 'manual' && existing.published_at) {
      const saved = this.store.editableInput(id);
      if (
        data.availableConfirmed !== true ||
        this.store
          .prepare(
            "SELECT 1 FROM deliveries WHERE offer_id=? AND state IN ('queued','sending','uncertain')",
          )
          .get(id) ||
        !isDeepStrictEqual(
          normalizeOfferInput(saved, this.env),
          normalizeOfferInput({ ...saved, ...data }, this.env),
        )
      )
        throw new Error('offer_not_editable');
      offer = existing;
    } else {
      offer = id
        ? this.store.editOffer(id, data, this.env)
        : this.store.createOffer(data, { env: this.env });
    }
    return this.store.setOfferEvidence(offer.id, {
      source: 'manual',
      verifiedAt: data.availableConfirmed === true ? new Date(this.now()).toISOString() : '',
      stockStatus: data.availableConfirmed === true ? 'available' : 'unknown',
    });
  }
  preview(id) {
    const offer = this.store.getOffer(id);
    if (!offer) throw new Error('offer_not_found');
    const capture = this.store.evidenceFor(offer);
    const message = this.store.messageFor(offer);
    const destination = {
      id: this.store.setting('whatsapp_group_id'),
      name: this.store.setting('whatsapp_group_name'),
      revision: this.store.group(this.store.setting('whatsapp_group_id'))?.revision,
    };
    const reviewToken = createHash('sha256')
      .update(
        JSON.stringify({
          offerId: offer.id,
          discardedAt: offer.discarded_at,
          message,
          destination,
          image: offer.image_url,
          source: offer.source,
          captureId: offer.capture_id,
          observedAt: capture?.observed_at || offer.verified_at,
          stock: capture ? captureStock(capture) : offer.stock_status,
          price: capture?.price_cents ?? offer.price_cents,
          condition: capture?.price_condition || offer.coupon_condition,
          productUrl: capture?.product_url || offer.product_url,
          variant: capture?.variant ?? offer.variant,
        }),
      )
      .digest('hex');
    return { offer, message, destination, reviewToken };
  }
  publish(id, { confirmed, scheduledAt, reviewToken } = {}) {
    if (confirmed !== true) throw new Error('publication_confirmation_required');
    if (this.store.setting('publication_paused', 'true') === 'true')
      throw new Error('publication_paused');
    const destination = this.store.setting('whatsapp_group_id');
    if (!destination.endsWith('@g.us')) throw new Error('destination_not_configured');
    const group = this.store.group(destination);
    if (!group?.enabled) throw new Error('publication_not_ready');
    const reviewed = this.preview(id);
    if (!reviewToken) throw new Error('publication_review_required');
    if (reviewToken !== reviewed.reviewToken) throw new Error('publication_review_changed');
    const offer = reviewed.offer;
    const check = this.policy.ready(offer, destination);
    if (!check.allowed)
      throw Object.assign(new Error('publication_not_ready'), { userMessage: check.reason });
    const start = scheduledAt ? Date.parse(scheduledAt) : this.now();
    if (!Number.isFinite(start) || start < this.now() - 1000) throw new Error('invalid_schedule');
    const pending = this.store
      .prepare(
        "SELECT scheduled_at AS sent_at FROM deliveries WHERE destination=? AND offer_id!=? AND state IN ('queued','sending')",
      )
      .all(destination, id);
    const at = nextPublicationAt(
      [...this.store.sentDeliveries(destination), ...pending],
      Math.max(this.now(), start),
      group,
    );
    assertEvidenceAtSchedule(offer, at);
    const delivery = this.store.enqueue(id, destination, {
      mode: 'approved',
      scheduledAt: at,
    });
    if (delivery.state === 'queued')
      this.store.approveDelivery(delivery.id, offer, {
        groupRevision: group.revision,
        defaultDestination: destination,
      });
    return this.store.deliveryDetail(delivery.id);
  }
  list({ all = false } = {}) {
    const offers = this.store.listOffers(all ? null : 200),
      offersById = new Map(offers.map((offer) => [offer.id, offer])),
      listedIds = new Set(),
      browserProducts = new Set(
        offers
          .filter(
            (offer) =>
              offer.source === 'browser' &&
              offer.marketplace === 'mercadolivre' &&
              !offer.discarded_at &&
              !offer.published_at,
          )
          .map((offer) => offer.product_key),
      ),
      seen = new Set(),
      items = [];
    const describe = (offer, c) => {
      const delivery = offer ? this.store.approvals(offer.id) : null;
      const check = offer
        ? this.policy.ready(offer)
        : {
            allowed: false,
            reason:
              c.stage === 'card'
                ? 'Valide o produto e gere o link automaticamente'
                : captureStock(c) !== 'available'
                  ? captureStock(c) === 'unavailable'
                    ? 'Produto indisponível'
                    : 'Estoque desconhecido; valide pelo navegador conectado'
                  : this.now() - Date.parse(c.observed_at) > RULES.freshnessMs
                    ? 'Atualize a captura'
                    : 'Gere o link pelo navegador conectado',
          };
      const state = DELIVERY_ITEM_STATE[delivery?.state] ?? (check.allowed ? 'ready' : 'pending');
      return {
        id: offer?.id || null,
        captureId: c?.id || null,
        canPrepare: Boolean(
          c?.stage === 'product' &&
          captureStock(c) === 'available' &&
          this.now() >= Date.parse(c.observed_at) &&
          this.now() - Date.parse(c.observed_at) <= RULES.freshnessMs,
        ),
        source: offer?.source || 'extension',
        marketplace: offer?.marketplace || 'mercadolivre',
        title: offer?.title || c?.title || 'Produto',
        productUrl: offer?.product_url || c?.product_url || '',
        imageUrl: offer?.image_url || c?.image_url || '',
        priceCents: c?.price_cents ?? offer.price_cents,
        priceCondition: c?.price_condition || '',
        variant: c?.variant ?? offer.variant,
        observedAt: c?.observed_at || offer.verified_at,
        stock: c ? captureStock(c) : offer.stock_status,
        stage: c?.stage || 'manual',
        affiliateUrl: offer?.affiliate_url || '',
        note: offer?.note || c?.price_condition || '',
        state,
        reason:
          delivery?.state === 'sent'
            ? 'Envio registrado no WhatsApp'
            : delivery?.last_error || check.reason,
        ready: check.allowed,
        deliveryId: delivery?.id || null,
        scheduledAt: delivery?.next_attempt_at || null,
        message: offer ? this.store.messageFor(offer) : null,
      };
    };
    const captures = this.store.captures(all ? null : 200);
    for (const offer of offers) {
      if (offer.discarded_at) continue;
      const key = offer.marketplace + '|' + offer.product_key + '|' + offer.variant;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(describe(offer, this.store.evidenceFor(offer)));
      listedIds.add(offer.id);
    }
    for (const c of captures) {
      if (listedIds.has(c.offer_id)) continue;
      if (c.stage === 'card' && !c.variant && browserProducts.has(c.product_key)) continue;
      const key = 'mercadolivre|' + c.product_key + '|' + c.variant;
      if (seen.has(key)) continue;
      const offer = c.offer_id && (offersById.get(c.offer_id) || this.store.getOffer(c.offer_id));
      if (offer?.discarded_at) continue;
      seen.add(key);
      items.push(describe(offer || null, c));
      if (offer) listedIds.add(offer.id);
    }
    return items;
  }
}
