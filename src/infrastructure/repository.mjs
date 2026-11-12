import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureStock } from '../shared/capture-contract.mjs';
import { localClock } from '../domain/rules.mjs';
import { migrate } from './migrations.mjs';
import { migratePlatform } from './platform-schema.mjs';
import { couponPrice, scoreOffer } from '../domain/pricing.mjs';
import { normalizeOfferInput, formatOfferMessage } from '../domain/messages.mjs';

function isoNow() {
  return new Date().toISOString();
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
const couponRules = (offer) => JSON.parse(offer.coupon_rules || 'null');
// Identity of an offer at a price; equal fingerprints within the window are duplicates.
function offerFingerprint(marketplace, productKey, variant, priceCents, finalCents, coupon, rules) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        marketplace,
        productKey,
        variant,
        priceCents,
        finalCents,
        coupon.toUpperCase(),
        rules,
      ]),
    )
    .digest('hex');
}
const DELIVERY_DETAIL_SQL =
  'SELECT d.*,o.title,o.product_key,o.price_cents FROM deliveries d JOIN offers o ON o.id=d.offer_id';

export class Store {
  constructor({ dataDir = './data', dbName = 'offers.sqlite', scoreWeights = {} } = {}) {
    this.scoreWeights = scoreWeights;
    this.statements = new Map();
    this.dataDir = path.resolve(dataDir);
    ensureDir(this.dataDir);
    this.db = new DatabaseSync(path.join(this.dataDir, dbName), { timeout: 5000 });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    this.db.exec(
      "UPDATE deliveries SET state='uncertain', last_error='Processo interrompido durante envio; confira o destino antes de tentar novamente.' WHERE state='sending'",
    );
  }

  migrate() {
    migrate(this.db);
    migratePlatform(this.db);
    // Indexes for the panel poll: last search result and per-offer delivery lookups.
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_browser_jobs_kind ON browser_jobs(kind,state,id);
      CREATE INDEX IF NOT EXISTS idx_delivery_offer_state ON deliveries(offer_id,state);`);
  }

  prepare(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  close() {
    this.statements.clear();
    this.db.close();
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // CROSS JOIN keeps offers as the outer loop, so only this product's deliveries are read.
  lastPublication(key, variant = '', destination = null, marketplace = null) {
    return this.prepare(
      `SELECT d.sent_at,COALESCE(d.sent_price_cents,o.final_price_cents,o.price_cents) AS final_price_cents FROM offers o CROSS JOIN deliveries d ON o.id=d.offer_id WHERE d.state='sent' AND o.product_key=? AND o.variant=? AND (? IS NULL OR d.destination=?) AND (? IS NULL OR o.marketplace=?) ORDER BY d.sent_at DESC LIMIT 1`,
    ).get(key, variant, destination, destination, marketplace, marketplace);
  }
  sentDeliveries(destination = null) {
    return this.prepare(
      "SELECT sent_at FROM deliveries WHERE state='sent' AND sent_at IS NOT NULL AND (? IS NULL OR destination=?)",
    ).all(destination, destination);
  }
  dailyStats(now = Date.now()) {
    const day = localClock(now).day;
    // 48h is a superset of any local day; the exact day is still decided by localClock.
    const since = new Date(now - 48 * 3600_000).toISOString();
    const sent = this.prepare(
      "SELECT sent_at FROM deliveries WHERE state='sent' AND sent_at IS NOT NULL AND sent_at>=?",
    )
      .all(since)
      .filter((row) => localClock(Date.parse(row.sent_at)).day === day).length;
    return { day, timezone: 'America/Sao_Paulo', sent, limit: null };
  }
  cancelDelivery(id) {
    const row = this.prepare('SELECT * FROM deliveries WHERE id=?').get(Number(id));
    if (!row || !['queued', 'failed'].includes(row.state))
      throw new Error('delivery_not_cancellable');
    this.prepare("UPDATE deliveries SET state='cancelled' WHERE id=?").run(row.id);
    this.event('delivery_cancelled', row.offer_id, { deliveryId: row.id });
    return this.prepare('SELECT * FROM deliveries WHERE id=?').get(row.id);
  }
  editableInput(id) {
    const offer = this.getOffer(id);
    if (!offer) throw new Error('offer_not_found');
    return {
      productUrl: offer.product_url,
      affiliateUrl: offer.affiliate_url,
      affiliateConfirmed: true,
      title: offer.title,
      price: offer.price_cents / 100,
      oldPrice: offer.old_price_cents == null ? null : offer.old_price_cents / 100,
      coupon: offer.coupon,
      couponRules: couponRules(offer),
      note: offer.note,
      imageUrl: offer.image_url,
      variant: offer.variant,
    };
  }
  editOffer(id, changes, env = process.env) {
    const offer = this.getOffer(id);
    if (!offer) throw new Error('offer_not_found');
    if (
      offer.published_at ||
      this.prepare(
        "SELECT id FROM deliveries WHERE offer_id=? AND state IN ('queued','sending','sent','uncertain')",
      ).get(offer.id)
    )
      throw new Error('offer_not_editable');
    const normalized = normalizeOfferInput({ ...this.editableInput(id), ...changes }, env);
    if (
      normalized.productKey !== offer.product_key ||
      normalized.affiliateUrl !== offer.affiliate_url
    )
      throw new Error('offer_identity_locked');
    const coupon = couponPrice(normalized.priceCents, normalized.coupon, normalized.couponRules);
    const fingerprint = offerFingerprint(
      normalized.marketplace,
      normalized.productKey,
      normalized.variant,
      normalized.priceCents,
      coupon.final,
      normalized.coupon,
      normalized.couponRules,
    );
    if (
      this.prepare('SELECT id FROM offers WHERE fingerprint=? AND id!=? AND created_at>=?').get(
        fingerprint,
        offer.id,
        new Date(Date.now() - 72 * 3600000).toISOString(),
      )
    )
      throw new Error('duplicate_offer');
    this.prepare(
      "UPDATE offers SET title=?,price_cents=?,old_price_cents=?,coupon=?,coupon_rules=?,coupon_condition=?,final_price_cents=?,note=?,image_url=?,variant=?,fingerprint=?,status='ready',last_error=NULL WHERE id=?",
    ).run(
      normalized.title,
      normalized.priceCents,
      normalized.oldPriceCents,
      normalized.coupon,
      JSON.stringify(normalized.couponRules),
      coupon.condition,
      coupon.final,
      normalized.note,
      normalized.imageUrl,
      normalized.variant,
      fingerprint,
      offer.id,
    );
    normalized.finalPriceCents = coupon.final;
    const evaluation = scoreOffer(
      normalized,
      this.history(normalized.marketplace, normalized.productKey, normalized.variant),
      this.scoreWeights,
    );
    this.prepare('UPDATE offers SET score=?,score_detail=? WHERE id=?').run(
      evaluation.score,
      JSON.stringify(evaluation),
      offer.id,
    );
    this.event('offer_edited', offer.id);
    return this.getOffer(offer.id);
  }
  markUncertain(id, offerId) {
    this.prepare(
      "UPDATE deliveries SET state='uncertain',last_error='Resultado do envio incerto; confira o grupo antes de reenviar.' WHERE id=?",
    ).run(id);
    this.prepare(
      "UPDATE offers SET status='uncertain',last_error='Resultado incerto: confira o grupo.' WHERE id=?",
    ).run(offerId);
    this.event('delivery_uncertain', offerId, { deliveryId: id });
  }
  deferDelivery(id, reason, delay = 900000) {
    this.prepare(
      "UPDATE deliveries SET next_attempt_at=?,last_error=? WHERE id=? AND state='queued'",
    ).run(new Date(Date.now() + delay).toISOString(), reason, id);
  }
  history(marketplace, productKey, variant = '') {
    return this.prepare(
      'SELECT COUNT(*) AS count, MIN(price_cents) AS minimum_cents, AVG(price_cents) AS average_cents FROM price_history WHERE marketplace=? AND product_key=? AND variant=?',
    ).get(marketplace, productKey, variant);
  }

  retryUncertain(id, confirmedNotSent) {
    if (confirmedNotSent !== true) throw new Error('delivery_confirmation_required');
    this.prepare(
      "UPDATE deliveries SET state='queued', next_attempt_at=?, last_error=NULL,refresh_job_id=NULL WHERE id=? AND state='uncertain'",
    ).run(isoNow(), Number(id));
    this.prepare(
      "UPDATE offers SET status='ready',last_error=NULL WHERE id=(SELECT offer_id FROM deliveries WHERE id=? AND state='queued')",
    ).run(Number(id));
    this.event('delivery_manual_retry', null, { deliveryId: Number(id) });
  }

  group(id) {
    return this.prepare('SELECT * FROM destination_groups WHERE id=?').get(id);
  }
  connection(marketplace) {
    return this.prepare('SELECT * FROM store_connections WHERE marketplace=?').get(marketplace);
  }

  setting(key, fallback = '') {
    return this.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback;
  }

  setSetting(key, value) {
    this.prepare(
      `INSERT INTO settings(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(key, String(value));
  }

  saveDestination(id, name) {
    this.transaction(() => {
      this.setSetting('whatsapp_group_id', id);
      this.setSetting('whatsapp_group_name', name);
      this.prepare(
        'INSERT INTO destination_groups(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name',
      ).run(id, name);
      this.event('destination_saved', null, { destination: id });
    });
    return { id: this.setting('whatsapp_group_id'), name: this.setting('whatsapp_group_name') };
  }

  event(kind, offerId, detail = {}) {
    this.prepare('INSERT INTO events(created_at,kind,offer_id,detail) VALUES(?,?,?,?)').run(
      isoNow(),
      kind,
      offerId ?? null,
      JSON.stringify(detail),
    );
  }

  createOffer(input, { env = process.env, dedupHours = 72, deduplicate = true } = {}) {
    const offer = normalizeOfferInput(input, env);
    const coupon = couponPrice(offer.priceCents, offer.coupon, offer.couponRules);
    offer.finalPriceCents = coupon.final;
    const history = this.history(offer.marketplace, offer.productKey, offer.variant);
    const evaluation = scoreOffer(offer, history, this.scoreWeights);
    const fingerprint = offerFingerprint(
      offer.marketplace,
      offer.productKey,
      offer.variant,
      offer.priceCents,
      coupon.final,
      offer.coupon,
      offer.couponRules,
    );
    const now = isoNow();
    const ownTransaction = !this.db.isTransaction;
    if (ownTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      this.prepare(
        'INSERT INTO price_history(observed_at,marketplace,product_key,variant,price_cents) VALUES(?,?,?,?,?)',
      ).run(now, offer.marketplace, offer.productKey, offer.variant, offer.priceCents);
      const since = new Date(Date.now() - dedupHours * 3600_000).toISOString();
      const duplicate =
        deduplicate &&
        this.prepare(
          'SELECT id, created_at FROM offers WHERE fingerprint=? AND created_at>=? ORDER BY id DESC LIMIT 1',
        ).get(fingerprint, since);
      if (duplicate) {
        this.event('duplicate_observed', duplicate.id);
        if (ownTransaction) this.db.exec('COMMIT');
        const err = new Error('duplicate_offer');
        err.meta = duplicate;
        throw err;
      }
      const r = this.prepare(
        `INSERT INTO offers(created_at,marketplace,product_key,product_url,affiliate_url,affiliate_validation,title,price_cents,old_price_cents,coupon,note,image_url,fingerprint,variant,final_price_cents,coupon_rules,coupon_condition,score,score_detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        now,
        offer.marketplace,
        offer.productKey,
        offer.productUrl,
        offer.affiliateUrl,
        offer.affiliateValidation,
        offer.title,
        offer.priceCents,
        offer.oldPriceCents,
        offer.coupon,
        offer.note,
        offer.imageUrl,
        fingerprint,
        offer.variant,
        coupon.final,
        JSON.stringify(offer.couponRules),
        coupon.condition,
        evaluation.score,
        JSON.stringify(evaluation),
      );
      const id = Number(r.lastInsertRowid);
      this.event('offer_created', id, { evaluation, validation: offer.affiliateValidation });
      if (ownTransaction) this.db.exec('COMMIT');
      return this.getOffer(id);
    } catch (e) {
      if (ownTransaction && this.db.isTransaction) this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getOffer(id) {
    return this.prepare('SELECT * FROM offers WHERE id=?').get(Number(id));
  }

  listOffers(limit = 50) {
    return this.prepare('SELECT * FROM offers ORDER BY id DESC LIMIT ?').all(
      limit === null ? -1 : Math.min(Number(limit) || 50, 200),
    );
  }

  enqueue(offerId, destination, { mode = 'manual', scheduledAt = isoNow() } = {}) {
    if (
      !['manual', 'automatic', 'approved', 'pilot'].includes(mode) ||
      !Number.isFinite(Date.parse(scheduledAt))
    )
      throw new Error('invalid_schedule');
    scheduledAt = new Date(scheduledAt).toISOString();
    if (!destination || typeof destination !== 'string')
      throw new Error('destination_not_configured');
    const offer = this.getOffer(offerId);
    if (!offer) throw new Error('offer_not_found');
    if (
      offer.affiliate_validation === 'domain_only' ||
      offer.affiliate_validation === 'product_id_match'
    )
      throw new Error('affiliate_revalidation_required');
    const rules = couponRules(offer);
    couponPrice(offer.price_cents, offer.coupon, rules);
    const existing = this.prepare(
      "SELECT * FROM deliveries WHERE offer_id=? AND destination=? AND state IN ('queued','sending','sent','uncertain') ORDER BY id DESC LIMIT 1",
    ).get(Number(offerId), destination);
    if (existing) return existing;

    const r = this.prepare(
      "INSERT INTO deliveries(offer_id,destination,state,attempts,next_attempt_at,scheduled_at,mode) VALUES(?,?,'queued',0,?,?,?)",
    ).run(Number(offerId), destination, scheduledAt, scheduledAt, mode);
    const id = Number(r.lastInsertRowid);
    this.event('delivery_queued', offerId, { destination, deliveryId: id });
    return this.prepare('SELECT * FROM deliveries WHERE id=?').get(id);
  }

  nextDelivery() {
    const at = isoNow();
    return this.prepare(
      `SELECT d.*,o.*,d.id AS delivery_id,d.state AS delivery_state,d.attempts AS delivery_attempts,d.destination AS delivery_destination FROM deliveries d JOIN offers o ON o.id=d.offer_id WHERE d.state='queued' AND d.next_attempt_at<=? AND (d.scheduled_at='' OR d.scheduled_at<=?) ORDER BY d.next_attempt_at,d.id LIMIT 1`,
    ).get(at, at);
  }
  otherPendingProduct(offer, destination = null) {
    return this.prepare(
      "SELECT d.id,d.state FROM deliveries d JOIN offers o ON o.id=d.offer_id WHERE o.product_key=? AND o.variant=? AND o.marketplace=? AND (? IS NULL OR d.destination=?) AND d.state IN ('queued','sending','uncertain') AND (o.id!=? OR d.state='uncertain') LIMIT 1",
    ).get(offer.product_key, offer.variant, offer.marketplace, destination, destination, offer.id);
  }
  blockDelivery(id, reason) {
    const row = this.prepare('SELECT * FROM deliveries WHERE id=?').get(id);
    if (!row) return;
    this.prepare(
      "UPDATE deliveries SET state='cancelled',last_error=? WHERE id=? AND state='queued'",
    ).run(reason, id);
    this.event('delivery_approval_invalidated', row.offer_id, { deliveryId: id, reason });
  }
  saveAttemptMessage(id, message, priceCents = null) {
    this.prepare('UPDATE deliveries SET sent_message=?,sent_price_cents=? WHERE id=?').run(
      message,
      priceCents,
      id,
    );
  }
  setOfferEvidence(
    id,
    { source = 'manual', captureId = null, verifiedAt = '', stockStatus = 'unknown' },
  ) {
    this.prepare(
      'UPDATE offers SET source=?,capture_id=?,verified_at=?,stock_status=? WHERE id=?',
    ).run(source, captureId, verifiedAt, stockStatus, id);
    return this.getOffer(id);
  }
  evidenceFor(offer) {
    if (offer?.source === 'browser')
      return this.prepare(
        "SELECT *,CASE WHEN stock_status='available' THEN 1 ELSE 0 END AS available FROM platform_observations WHERE marketplace=? AND product_key=? AND variant=?",
      ).get(offer.marketplace, offer.product_key, offer.variant);
    return this.capture(offer?.capture_id);
  }
  capture(id) {
    return this.prepare('SELECT * FROM browser_import_drafts WHERE id=?').get(Number(id));
  }
  captures(limit = 200) {
    return this.prepare(
      'SELECT * FROM browser_import_drafts ORDER BY observed_at DESC,id DESC LIMIT ?',
    ).all(limit === null ? -1 : limit);
  }
  // Same numbers as reading captures() for the 200 newest rows, without loading them.
  captureSummary() {
    const row = this.prepare(
      "SELECT count(*) AS captures,max(observed_at) AS lastCaptureAt,COALESCE(sum(stage='product'),0) AS productCaptures FROM (SELECT observed_at,stage FROM browser_import_drafts ORDER BY observed_at DESC,id DESC LIMIT 200)",
    ).get();
    return { ...row, lastCaptureAt: row.lastCaptureAt || null };
  }
  importCaptures(items) {
    this.transaction(() => {
      for (const item of items) this.saveCapture(item);
      this.event('capture_imported', null, { count: items.length });
    });
  }
  saveCapture(i) {
    const old = this.prepare(
      'SELECT * FROM browser_import_drafts WHERE product_key=? AND variant=?',
    ).get(i.productKey, i.variant);
    if (
      old &&
      (Date.parse(old.observed_at) > Date.parse(i.observedAt) ||
        (old.stage === 'product' && i.stage === 'card'))
    )
      return old;
    this.prepare(
      `INSERT INTO browser_import_drafts(product_key,variant,title,product_url,image_url,price_cents,available,price_condition,stage,observed_at,stock_status) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(product_key,variant) DO UPDATE SET title=excluded.title,product_url=excluded.product_url,image_url=excluded.image_url,price_cents=excluded.price_cents,available=excluded.available,price_condition=excluded.price_condition,stage=excluded.stage,observed_at=excluded.observed_at,stock_status=excluded.stock_status`,
    ).run(
      i.productKey,
      i.variant,
      i.title,
      i.productUrl,
      i.imageUrl,
      i.priceCents,
      Number(i.available),
      i.priceCondition,
      i.stage,
      i.observedAt,
      i.stockStatus,
    );
    const saved = this.prepare(
      'SELECT * FROM browser_import_drafts WHERE product_key=? AND variant=?',
    ).get(i.productKey, i.variant);
    if (saved.offer_id)
      this.prepare(
        "UPDATE deliveries SET next_attempt_at=CASE WHEN scheduled_at>? THEN scheduled_at ELSE ? END WHERE offer_id=? AND state='queued'",
      ).run(isoNow(), isoNow(), saved.offer_id);
    return saved;
  }
  bindCapture(id, offerId) {
    this.prepare('UPDATE browser_import_drafts SET offer_id=? WHERE id=?').run(offerId, id);
  }
  approvals(id) {
    return this.prepare('SELECT * FROM deliveries WHERE offer_id=? ORDER BY id DESC LIMIT 1').get(
      id,
    );
  }
  approveDelivery(id, offer, { groupRevision = null, defaultDestination } = {}) {
    this.prepare(
      'UPDATE deliveries SET approved_price_cents=?,approved_message=?,approved_metadata=?,group_revision=COALESCE(?,group_revision) WHERE id=?',
    ).run(
      offer.price_cents,
      this.messageFor(offer),
      JSON.stringify({
        productKey: offer.product_key,
        variant: offer.variant,
        url: offer.product_url,
        affiliateUrl: offer.affiliate_url,
        title: offer.title,
        note: offer.note,
        image: offer.image_url,
        priceCondition: this.evidenceFor(offer)?.price_condition || '',
        captureId: offer.capture_id,
        ...(defaultDestination === undefined ? {} : { defaultDestination }),
      }),
      groupRevision,
      id,
    );
  }
  updateCapturePrice(id, capture) {
    const offer = this.getOffer(id);
    const rules = couponRules(offer);
    const coupon = couponPrice(capture.price_cents, offer.coupon, rules);
    const fingerprint = offerFingerprint(
      offer.marketplace,
      offer.product_key,
      offer.variant,
      capture.price_cents,
      coupon.final,
      offer.coupon,
      rules,
    );
    this.prepare(
      'UPDATE offers SET price_cents=?,final_price_cents=?,fingerprint=?,verified_at=?,stock_status=?,coupon_condition=? WHERE id=?',
    ).run(
      capture.price_cents,
      coupon.final,
      fingerprint,
      capture.observed_at,
      captureStock(capture),
      coupon.condition,
      id,
    );
    return this.getOffer(id);
  }
  deliveryDetails() {
    return this.prepare(`${DELIVERY_DETAIL_SQL} ORDER BY d.id DESC LIMIT 200`).all();
  }
  deliveryDetail(id) {
    return this.prepare(`${DELIVERY_DETAIL_SQL} WHERE d.id=?`).get(Number(id));
  }
  deliveryPage({ filter = 'all', destination = null, before = null, limit = 50 } = {}) {
    const states = {
      all: ['queued', 'sending', 'sent', 'failed', 'uncertain', 'cancelled'],
      active: ['queued', 'sending'],
      attention: ['failed', 'uncertain'],
      history: ['sent', 'cancelled'],
    };
    if (
      !Object.hasOwn(states, filter) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (before !== null && (!Number.isSafeInteger(before) || before < 1)) ||
      (destination !== null && typeof destination !== 'string')
    )
      throw new Error('invalid_request');
    const stateSql = states[filter].map(() => '?').join(',');
    const values = [...states[filter], destination, destination];
    const total = this.prepare(
      `SELECT count(*) AS n FROM deliveries d WHERE d.state IN (${stateSql}) AND (? IS NULL OR d.destination=?)`,
    ).get(...values).n;
    const rows = this.prepare(
      `${DELIVERY_DETAIL_SQL} WHERE d.state IN (${stateSql}) AND (? IS NULL OR d.destination=?) AND (? IS NULL OR d.id<?) ORDER BY d.id DESC LIMIT ?`,
    ).all(...values, before, before, limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { deliveries: rows, pagination: { total, nextCursor: hasMore ? rows.at(-1).id : null } };
  }

  markSending(deliveryId) {
    return (
      this.prepare(
        "UPDATE deliveries SET state='sending', attempts=attempts+1 WHERE id=? AND state='queued'",
      ).run(deliveryId).changes === 1
    );
  }

  markSent(deliveryId, offerId) {
    const now = isoNow();
    this.prepare(
      "UPDATE deliveries SET state='sent', sent_at=?, last_error=NULL,sent_price_cents=COALESCE(sent_price_cents,(SELECT COALESCE(final_price_cents,price_cents) FROM offers WHERE id=deliveries.offer_id)) WHERE id=?",
    ).run(now, deliveryId);
    this.prepare(
      "UPDATE offers SET status='published', published_at=?, last_error=NULL WHERE id=?",
    ).run(now, offerId);
    this.event('delivery_sent', offerId, { deliveryId });
  }

  markRetry(deliveryId, offerId, error, maxAttempts = 3) {
    const row = this.prepare('SELECT attempts FROM deliveries WHERE id=?').get(deliveryId);
    const attempts = row?.attempts ?? maxAttempts;
    if (attempts >= maxAttempts) {
      this.prepare("UPDATE deliveries SET state='failed', last_error=? WHERE id=?").run(
        String(error),
        deliveryId,
      );
      this.prepare("UPDATE offers SET status='failed', last_error=? WHERE id=?").run(
        String(error),
        offerId,
      );
      this.event('delivery_failed', offerId, { deliveryId, error: String(error) });
      return;
    }
    const delays = [15_000, 60_000, 300_000];
    const next = new Date(Date.now() + delays[Math.max(0, attempts - 1)]).toISOString();
    this.prepare(
      "UPDATE deliveries SET state='queued', next_attempt_at=?, last_error=? WHERE id=?",
    ).run(next, String(error), deliveryId);
    this.event('delivery_retry', offerId, { deliveryId, attempts, next });
  }

  listDeliveries() {
    return this.prepare('SELECT * FROM deliveries ORDER BY id DESC LIMIT 200').all();
  }

  queueStats() {
    return this.prepare(
      `
      SELECT
        COALESCE(SUM(CASE WHEN state='queued' THEN 1 ELSE 0 END),0) AS queued,
        COALESCE(SUM(CASE WHEN state='sent' THEN 1 ELSE 0 END),0) AS sent,
        COALESCE(SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END),0) AS failed,
        COALESCE(SUM(CASE WHEN state='uncertain' THEN 1 ELSE 0 END),0) AS uncertain
      FROM deliveries
    `,
    ).get();
  }

  messageFor(offer, { includePrice = false } = {}) {
    let computed;
    try {
      computed = couponPrice(offer.price_cents, offer.coupon, couponRules(offer));
    } catch (error) {
      if (error.message !== 'coupon_expired') throw error;
      computed = {
        final: offer.price_cents,
        condition: 'Cupom expirado. O preço com cupom não está disponível.',
      };
    }
    const message = formatOfferMessage({
      ...offer,
      price_condition: this.evidenceFor(offer)?.price_condition || '',
      final_price_cents: computed.final,
      coupon_condition: computed.condition,
    });
    return includePrice ? { message, priceCents: computed.final } : message;
  }
}
