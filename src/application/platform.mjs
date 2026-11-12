import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { normalizeOfferInput, extractProductKey, detectMarketplace } from '../domain/messages.mjs';
import { nextPublicationAt, assertEvidenceAtSchedule } from '../domain/publication.mjs';
import { repeatAllowed } from '../domain/rules.mjs';
import { AutomaticPublication } from './automatic-publication.mjs';
import { automaticConfiguration, checkAutomaticDelivery } from '../domain/automatic.mjs';

export const STORES = { mercadolivre: 'Mercado Livre', amazon: 'Amazon', shopee: 'Shopee' };
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const parse = (v) => JSON.parse(v || '[]');
const requireValue = (condition, message = 'invalid_request') => {
  if (!condition) throw new Error(message);
};

// Failures that concern a single product and must not suspend the store connection.
const PRODUCT_ERROR_CODES = new Set([
  'source_browser_price_ambiguous',
  'source_browser_identity_unknown',
  'stock_confirmation_required',
  'invalid_price',
  'product_marketplace_mismatch',
]);
// Product and refresh jobs read one product; a validate job tied to a capture does too.
const isProductJob = (job, payload) =>
  ['product', 'refresh'].includes(job.kind) || (job.kind === 'validate' && !!payload.captureId);
export class Platform {
  constructor({ store, offers, policy, now = Date.now, publisherReady = () => false }) {
    Object.assign(this, { store, offers, policy, now });
    this.timer = null;
    this.automation = new AutomaticPublication({
      store,
      policy,
      platform: this,
      now,
      publisherReady,
    });
  }
  groups() {
    return this.store.prepare('SELECT * FROM destination_groups ORDER BY name').all();
  }
  topics() {
    return this.store
      .prepare('SELECT * FROM topics ORDER BY id')
      .all()
      .map((r) => ({
        ...r,
        stores: parse(r.stores),
        groupIds: parse(r.group_ids),
        keywords: parse(r.keywords),
      }));
  }
  saveGroup(input, knownGroups) {
    const known = knownGroups.find((g) => g.id === input.id);
    requireValue(known && /^\d+(?:-\d+)?@g\.us$/.test(input.id), 'invalid_whatsapp_group');
    const { startMinute = 480, endMinute = 1320, intervalMinutes = 60, enabled = true } = input;
    requireValue([startMinute, endMinute].every((v) => Number.isInteger(v) && v >= 0 && v < 1440));
    requireValue(
      Number.isInteger(intervalMinutes) && intervalMinutes > 0 && intervalMinutes <= 1440,
    );
    requireValue(typeof enabled === 'boolean');
    const previous = this.groups().find((g) => g.id === input.id);
    const changed =
      previous &&
      (previous.enabled !== +enabled ||
        previous.start_minute !== startMinute ||
        previous.end_minute !== endMinute ||
        previous.interval_minutes !== intervalMinutes);
    this.store
      .prepare(
        `INSERT INTO destination_groups(id,name,enabled,start_minute,end_minute,interval_minutes)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,
      start_minute=excluded.start_minute,end_minute=excluded.end_minute,interval_minutes=excluded.interval_minutes,
      revision=destination_groups.revision+?`,
      )
      .run(
        input.id,
        known.name,
        +enabled,
        startMinute,
        endMinute,
        intervalMinutes,
        changed ? 1 : 0,
      );
    if (changed)
      for (const delivery of this.store
        .prepare("SELECT id FROM deliveries WHERE destination=? AND state='queued'")
        .all(input.id))
        this.store.blockDelivery(
          delivery.id,
          'Regras do grupo alteradas; revise e aprove novamente',
        );
    return this.groups();
  }
  saveTopic(input) {
    const {
      name,
      keywords,
      stores,
      groupIds,
      minCents = 0,
      maxCents = null,
      enabled = true,
    } = input;
    requireValue(typeof name === 'string' && name.trim().length > 0 && name.length <= 100);
    requireValue(
      Array.isArray(keywords) &&
        keywords.length > 0 &&
        keywords.length <= 20 &&
        keywords.every((s) => typeof s === 'string' && s.trim() && s.length <= 100),
    );
    requireValue(
      Array.isArray(stores) && stores.length > 0 && stores.every((s) => Object.hasOwn(STORES, s)),
    );
    const groups = new Set(this.groups().map((g) => g.id));
    requireValue(
      Array.isArray(groupIds) && groupIds.length > 0 && groupIds.every((id) => groups.has(id)),
    );
    requireValue(
      Number.isSafeInteger(minCents) &&
        minCents >= 0 &&
        (maxCents === null || (Number.isSafeInteger(maxCents) && maxCents >= minCents)),
    );
    requireValue(typeof enabled === 'boolean');
    const values = [
      name.trim(),
      JSON.stringify(keywords.map((s) => s.trim())),
      minCents,
      maxCents,
      JSON.stringify(stores),
      JSON.stringify(groupIds),
      +enabled,
    ];
    if (input.id) {
      requireValue(
        Number.isSafeInteger(input.id) &&
          this.store.prepare('SELECT 1 FROM topics WHERE id=?').get(input.id),
      );
      this.store
        .prepare(
          'UPDATE topics SET name=?,keywords=?,min_cents=?,max_cents=?,stores=?,group_ids=?,enabled=? WHERE id=?',
        )
        .run(...values, input.id);
      this.store
        .prepare(
          "UPDATE browser_jobs SET state='cancelled',error='Tema atualizado' WHERE topic_id=? AND kind IN ('search','product') AND state IN ('pending','running')",
        )
        .run(input.id);
    } else
      this.store
        .prepare(
          'INSERT INTO topics(name,keywords,min_cents,max_cents,stores,group_ids,enabled) VALUES(?,?,?,?,?,?,?)',
        )
        .run(...values);
    return this.topics();
  }
  destinations(offer) {
    return this.store
      .prepare(
        `SELECT DISTINCT g.id FROM offer_topics ot
         JOIN topics t ON t.id=ot.topic_id
         JOIN json_each(t.group_ids) assigned
         JOIN destination_groups g ON g.id=assigned.value
         WHERE ot.offer_id=? AND t.enabled=1 AND g.enabled=1 ORDER BY g.name,g.rowid`,
      )
      .all(offer.id)
      .map((g) => g.id);
  }
  reviewItems() {
    const groups = this.groups().filter((g) => g.enabled);
    const items = this.offers.list({ all: true });
    // Loaded once per poll (after list(), which may refresh offers) instead of per item or item×group.
    const offersById = new Map(this.store.listOffers(null).map((o) => [o.id, o]));
    const discarded = new Set(
      this.store
        .prepare(
          "SELECT key FROM settings WHERE key LIKE 'discard\\_capture\\_%' ESCAPE '\\' AND value='true'",
        )
        .all()
        .map((r) => r.key),
    );
    const active = new Set(
      this.store
        .prepare(
          "SELECT offer_id,destination FROM deliveries WHERE state IN ('queued','sending','sent','uncertain')",
        )
        .all()
        .map((d) => `${d.offer_id}|${d.destination}`),
    );
    return items
      .filter((i) => !i.captureId || !discarded.has(`discard_capture_${i.captureId}`))
      .map((i) => {
        const offer = i.id ? offersById.get(i.id) : undefined;
        const eligibleGroups = offer
          ? groups
              .filter(
                (g) => !active.has(`${offer.id}|${g.id}`) && this.policy.ready(offer, g.id).allowed,
              )
              .map((g) => g.id)
          : [];
        const reconfirmManual =
          offer?.source === 'manual' &&
          offer.published_at &&
          this.store
            .prepare(
              "SELECT 1 FROM deliveries d JOIN destination_groups g ON g.id=d.destination WHERE d.offer_id=? AND d.state IN ('cancelled','failed') AND g.enabled=1 AND NOT EXISTS (SELECT 1 FROM deliveries sent WHERE sent.offer_id=d.offer_id AND sent.destination=d.destination AND sent.state='sent')",
            )
            .get(offer.id) &&
          !this.store
            .prepare(
              "SELECT 1 FROM deliveries WHERE offer_id=? AND state IN ('queued','sending','uncertain')",
            )
            .get(offer.id);
        return {
          ...i,
          state:
            !eligibleGroups.length && (i.state === 'ready' || reconfirmManual)
              ? 'pending'
              : i.state,
          reason:
            !eligibleGroups.length && reconfirmManual
              ? 'Confira novamente preço e estoque para revisar os destinos restantes.'
              : !eligibleGroups.length && !groups.length && !i.reason
                ? 'Habilite um grupo de destino em Configurações.'
                : i.reason,
          eligibleGroups,
          suggestedGroups: offer
            ? this.destinations(offer).filter((id) => eligibleGroups.includes(id))
            : [],
          ready: eligibleGroups.length > 0,
        };
      })
      .filter((i) => i.ready || !['sent', 'scheduled', 'sending', 'uncertain'].includes(i.state));
  }
  batchPreview(selection) {
    requireValue(Array.isArray(selection) && selection.length > 0 && selection.length <= 200);
    const availableGroups = new Map(
      this.groups()
        .filter((g) => g.enabled)
        .map((g) => [g.id, g]),
    );
    const seen = new Set();
    const products = new Set();
    const rows = selection.map((item) => {
      requireValue(item && typeof item === 'object' && !Array.isArray(item));
      const { offerId, groupIds } = item;
      requireValue(Number.isSafeInteger(offerId) && !seen.has(offerId));
      seen.add(offerId);
      requireValue(
        Array.isArray(groupIds) &&
          groupIds.length > 0 &&
          new Set(groupIds).size === groupIds.length,
      );
      const reviewed = this.offers.preview(offerId),
        offer = reviewed.offer;
      requireValue(!offer.discarded_at, 'offer_not_found');
      const groups = groupIds.map((id) => {
        const group = availableGroups.get(id);
        requireValue(group, 'invalid_whatsapp_group');
        const check = this.policy.ready(offer, id);
        requireValue(check.allowed, 'publication_not_ready');
        const key = JSON.stringify([offer.marketplace, offer.product_key, offer.variant, id]);
        requireValue(!products.has(key), 'publication_duplicate_product');
        products.add(key);
        requireValue(
          !this.store
            .prepare(
              "SELECT 1 FROM deliveries WHERE offer_id=? AND destination=? AND state IN ('queued','sending','sent','uncertain')",
            )
            .get(offer.id, id),
          'publication_not_ready',
        );
        return group;
      });
      return {
        offerId,
        title: offer.title,
        marketplace: offer.marketplace,
        message: reviewed.message,
        image: offer.image_url,
        reviewToken: reviewed.reviewToken,
        groups,
      };
    });
    const snapshot = JSON.stringify(rows),
      token = hash(rows),
      id = randomUUID();
    this.store
      .prepare('INSERT INTO platform_review_batches(id,token,snapshot,created_at) VALUES(?,?,?,?)')
      .run(id, token, snapshot, new Date(this.now()).toISOString());
    return {
      id,
      token,
      rows,
      count: rows.length,
      deliveries: rows.reduce((n, r) => n + r.groups.length, 0),
    };
  }
  approveBatch({ id, token, confirmed }) {
    requireValue(confirmed === true, 'publication_confirmation_required');
    requireValue(
      typeof id === 'string' &&
        id.length <= 100 &&
        typeof token === 'string' &&
        /^[a-f0-9]{64}$/.test(token),
      'publication_review_changed',
    );
    const batch = this.store.prepare('SELECT * FROM platform_review_batches WHERE id=?').get(id);
    requireValue(batch && token === batch.token, 'publication_review_changed');
    if (batch.completed_at) return JSON.parse(batch.result);
    requireValue(this.now() - Date.parse(batch.created_at) <= 900000, 'publication_review_changed');
    requireValue(this.store.setting('publication_paused', 'true') !== 'true', 'publication_paused');
    const rows = JSON.parse(batch.snapshot);
    return this.store.transaction(() => {
      const currentGroups = new Map(this.groups().map((g) => [g.id, g]));
      const products = new Set();
      for (const row of rows) {
        requireValue(
          this.offers.preview(row.offerId).reviewToken === row.reviewToken,
          'publication_review_changed',
        );
        const offer = this.store.getOffer(row.offerId);
        for (const group of row.groups) {
          const key = JSON.stringify([
            offer.marketplace,
            offer.product_key,
            offer.variant,
            group.id,
          ]);
          requireValue(!products.has(key), 'publication_duplicate_product');
          products.add(key);
          requireValue(
            hash(currentGroups.get(group.id)) === hash(group),
            'publication_review_changed',
          );
          requireValue(this.policy.ready(offer, group.id).allowed, 'publication_not_ready');
        }
      }
      const deliveries = [];
      for (const row of rows)
        for (const group of row.groups) {
          const pending = this.store
            .prepare(
              "SELECT scheduled_at AS sent_at FROM deliveries WHERE destination=? AND state IN ('queued','sending')",
            )
            .all(group.id);
          const at = nextPublicationAt(
            [...this.store.sentDeliveries(group.id), ...pending],
            this.now(),
            group,
          );
          assertEvidenceAtSchedule(this.store.getOffer(row.offerId), at);
          const delivery = this.store.enqueue(row.offerId, group.id, {
            mode: 'approved',
            scheduledAt: at,
          });
          if (delivery.state === 'queued' && !delivery.approved_message) {
            this.store.approveDelivery(delivery.id, this.store.getOffer(row.offerId), {
              groupRevision: group.revision,
            });
          }
          deliveries.push(delivery.id);
        }
      const result = { batchId: id, deliveries, count: deliveries.length };
      this.store
        .prepare('UPDATE platform_review_batches SET completed_at=?,result=? WHERE id=?')
        .run(new Date(this.now()).toISOString(), JSON.stringify(result), id);
      this.store.event('batch_approved', null, result);
      return result;
    });
  }
  discard({ offerId, captureId }) {
    if (offerId) {
      const offer = this.store.getOffer(offerId);
      requireValue(offer, 'offer_not_found');
      requireValue(
        !this.store
          .prepare(
            "SELECT 1 FROM deliveries WHERE offer_id=? AND state IN ('queued','sending','uncertain')",
          )
          .get(offerId),
        'offer_not_editable',
      );
      this.store
        .prepare('UPDATE offers SET discarded_at=? WHERE id=?')
        .run(new Date(this.now()).toISOString(), offerId);
    } else {
      requireValue(this.store.capture(captureId), 'offer_not_found');
      this.store.setSetting(`discard_capture_${captureId}`, 'true');
    }
  }
  pair(extensionId) {
    requireValue(/^[a-p]{32}$/.test(extensionId));
    const token = randomBytes(32).toString('hex');
    this.store.setSetting('bridge_extension_id', extensionId);
    this.store.setSetting('bridge_token', token);
    return { token };
  }
  authenticate(token) {
    const expected = this.store.setting('bridge_token');
    if (
      !/^[a-f0-9]{64}$/.test(expected) ||
      typeof token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  }
  bridgeConnected() {
    const last = Number(this.store.setting('bridge_last_seen', '0'));
    const now = this.now();
    return last > 0 && now >= last && now - last < 90000;
  }
  status() {
    const topics = this.topics();
    const connections = this.store.prepare('SELECT * FROM store_connections').all();
    const activeStores = new Set(topics.filter((t) => t.enabled).flatMap((t) => t.stores));
    const blocked = connections.filter(
      (c) => activeStores.has(c.marketplace) && c.state !== 'ready',
    );
    const ready = connections.some((c) => activeStores.has(c.marketplace) && c.state === 'ready');
    const searchBlockedReason = !topics.some((t) => t.enabled)
      ? 'Configure e ative um tema para pesquisar.'
      : !ready
        ? blocked
            .map((c) => `${STORES[c.marketplace]}: ${c.last_error || 'valide a conexão da loja'}`)
            .join(' · ')
        : '';
    return {
      ...automaticConfiguration(this.store),
      groups: this.groups(),
      topics,
      connections,
      searchBlockedReason,
      lastSearchError:
        this.store
          .prepare(
            "SELECT state,error FROM browser_jobs WHERE kind='search' AND state IN ('done','failed') ORDER BY id DESC LIMIT 1",
          )
          .get()?.error || '',
      searchEnabled: this.store.setting('search_enabled', 'false') === 'true',
      bridgeConnected: this.bridgeConnected(),
      nextSearchAt: this.store.setting('next_search_at'),
      lastSearchAt: this.store.setting('last_search_at'),
      pendingJobs: this.store
        .prepare("SELECT count(*) AS n FROM browser_jobs WHERE state IN ('pending','running')")
        .get().n,
    };
  }
  addJob(marketplace, kind, payload, { topicId = null, deliveryId = null } = {}) {
    requireValue(Object.hasOwn(STORES, marketplace));
    requireValue(
      ['search', 'product', 'refresh', 'validate'].includes(kind) &&
        payload &&
        typeof payload === 'object',
    );
    if (kind === 'search')
      requireValue(
        typeof payload.keyword === 'string' &&
          payload.keyword.trim() &&
          payload.keyword.length <= 100,
      );
    else
      requireValue(
        detectMarketplace(payload.productUrl) === marketplace &&
          extractProductKey(marketplace, payload.productUrl),
        'invalid_url',
      );
    const r = this.store
      .prepare(
        'INSERT INTO browser_jobs(marketplace,kind,payload,created_at,topic_id,delivery_id) VALUES(?,?,?,?,?,?)',
      )
      .run(
        marketplace,
        kind,
        JSON.stringify(payload),
        new Date(this.now()).toISOString(),
        topicId,
        deliveryId,
      );
    return Number(r.lastInsertRowid);
  }
  captureResolution(captureId) {
    captureId = Number(captureId);
    requireValue(
      Number.isSafeInteger(captureId) && this.store.capture(captureId),
      'browser_import_invalid',
    );
    this.expireJobs();
    const capture = this.store.capture(captureId);
    const job = this.store
      .prepare(
        "SELECT id,state,error FROM browser_jobs WHERE kind='validate' AND json_extract(payload,'$.captureId')=? ORDER BY id DESC LIMIT 1",
      )
      .get(captureId);
    const offer = capture.offer_id && this.store.getOffer(capture.offer_id);
    const ready = offer
      ? this.policy.ready(offer)
      : { allowed: false, reason: 'A oferta precisa ser validada novamente.' };
    return {
      jobId: job?.id || null,
      state: job?.state || 'idle',
      error: job?.error || '',
      offerId: capture.offer_id || null,
      needsRefresh: job?.state === 'done' && !ready.allowed,
      refreshReason: job?.state === 'done' && !ready.allowed ? ready.reason : '',
    };
  }
  resolveCapture(captureId) {
    captureId = Number(captureId);
    const status = this.captureResolution(captureId);
    requireValue(
      this.store.setting(`discard_capture_${captureId}`) !== 'true',
      'browser_import_invalid',
    );
    if (['pending', 'running'].includes(status.state)) return status.jobId;
    if (
      status.state === 'done' &&
      status.offerId &&
      this.policy.ready(this.store.getOffer(status.offerId)).allowed
    )
      return status.jobId;
    requireValue(this.bridgeConnected(), 'capture_browser_required');
    const capture = this.store.capture(captureId);
    return this.addJob('mercadolivre', 'validate', { productUrl: capture.product_url, captureId });
  }
  validateConnection(marketplace, productUrl) {
    requireValue(
      detectMarketplace(productUrl) === marketplace && extractProductKey(marketplace, productUrl),
      'invalid_url',
    );
    this.expireJobs();
    const existing = this.store
      .prepare(
        "SELECT id FROM browser_jobs WHERE marketplace=? AND kind='validate' AND state IN ('pending','running')",
      )
      .get(marketplace);
    if (existing) return existing.id;
    this.store
      .prepare("UPDATE store_connections SET state='validating',last_error='' WHERE marketplace=?")
      .run(marketplace);
    return this.addJob(marketplace, 'validate', { productUrl });
  }
  claimJob() {
    this.store.setSetting('bridge_last_seen', String(this.now()));
    this.expireJobs();
    const job = this.store
      .prepare(
        "SELECT j.* FROM browser_jobs j JOIN store_connections c ON c.marketplace=j.marketplace WHERE j.state='pending' AND (j.kind='validate' OR c.state='ready') ORDER BY CASE j.kind WHEN 'refresh' THEN 0 WHEN 'validate' THEN 1 ELSE 2 END,j.id LIMIT 1",
      )
      .get();
    if (!job) return null;
    const claimed = this.store
      .prepare(
        "UPDATE browser_jobs SET state='running',leased_until=? WHERE id=? AND state='pending'",
      )
      .run(new Date(this.now() + 180000).toISOString(), job.id);
    if (claimed.changes !== 1) return null;
    return { ...job, payload: JSON.parse(job.payload) };
  }
  suspendStore(marketplace, reason) {
    this.store
      .prepare("UPDATE store_connections SET state='attention',last_error=? WHERE marketplace=?")
      .run(reason, marketplace);
    this.store
      .prepare(
        "UPDATE browser_jobs SET state='cancelled',error='Conexão suspensa' WHERE marketplace=? AND state IN ('pending','running') AND kind IN ('search','product')",
      )
      .run(marketplace);
  }
  expireJobs() {
    for (const expired of this.store
      .prepare("SELECT marketplace FROM browser_jobs WHERE state='running' AND leased_until<?")
      .all(new Date(this.now()).toISOString()))
      this.suspendStore(expired.marketplace, 'A leitura expirou. Valide a conexão novamente.');
    this.store
      .prepare(
        "UPDATE browser_jobs SET state='failed',error='Tempo de leitura esgotado; tente validar a conexão novamente.' WHERE state='running' AND leased_until<?",
      )
      .run(new Date(this.now()).toISOString());
  }
  completeJob(id, result) {
    requireValue(Number.isSafeInteger(id) && id > 0);
    const job = this.store.prepare('SELECT * FROM browser_jobs WHERE id=?').get(id);
    requireValue(job, 'invalid_request');
    requireValue(result && typeof result === 'object');
    const receiptHash = hash(result);
    if (job.state === 'cancelled') return;
    const payload = JSON.parse(job.payload);
    if (payload.captureId && ['pending', 'running'].includes(job.state)) {
      const capture = this.store.capture(payload.captureId);
      if (
        !capture ||
        capture.product_url !== payload.productUrl ||
        this.store.setting(`discard_capture_${payload.captureId}`) === 'true'
      ) {
        this.store
          .prepare(
            "UPDATE browser_jobs SET state='cancelled',error='Captura alterada ou descartada' WHERE id=?",
          )
          .run(id);
        return;
      }
    }
    if (['done', 'failed'].includes(job.state)) {
      requireValue(JSON.parse(job.result || '{}').receiptHash === receiptHash);
      return;
    }
    requireValue(job.state === 'running' && Date.parse(job.leased_until) >= this.now());
    if (result.error) {
      const reason = String(result.error).slice(0, 300);
      this.store
        .prepare("UPDATE browser_jobs SET state='failed',error=?,result=? WHERE id=?")
        .run(reason, JSON.stringify({ receiptHash }), id);
      const productOnly = isProductJob(job, payload) && PRODUCT_ERROR_CODES.has(result.code);
      if (!(job.kind === 'search' && result.code === 'search_read_failed') && !productOnly)
        this.suspendStore(job.marketplace, reason);
      if (productOnly && job.kind === 'refresh') {
        this.store.blockDelivery(job.delivery_id, reason);
        this.store
          .prepare(
            "UPDATE platform_observations SET stock_status='unknown' WHERE (marketplace,product_key,variant) IN (SELECT o.marketplace,o.product_key,o.variant FROM offers o JOIN deliveries d ON d.offer_id=o.id WHERE d.id=?)",
          )
          .run(job.delivery_id);
      }
      return;
    }
    if (
      ['search', 'product'].includes(job.kind) &&
      this.store.setting('search_enabled', 'false') !== 'true'
    ) {
      this.store.prepare("UPDATE browser_jobs SET state='cancelled' WHERE id=?").run(id);
      return;
    }
    this.store.transaction(() => {
      if (job.kind === 'search') {
        requireValue(Array.isArray(result.urls) && result.urls.length <= 20);
        const topic = this.topics().find((t) => t.id === job.topic_id);
        if (topic?.enabled)
          for (const productUrl of new Set(result.urls)) {
            // One unrecognised link must not discard the search or suspend the store.
            if (
              detectMarketplace(productUrl) !== job.marketplace ||
              !extractProductKey(job.marketplace, productUrl)
            )
              continue;
            const exists = this.store
              .prepare(
                "SELECT 1 FROM browser_jobs WHERE marketplace=? AND payload=? AND topic_id=? AND state IN ('pending','running')",
              )
              .get(job.marketplace, JSON.stringify({ productUrl }), job.topic_id);
            if (!exists)
              this.addJob(job.marketplace, 'product', { productUrl }, { topicId: job.topic_id });
          }
      } else this.observe(job, result);
      this.store.prepare("UPDATE browser_jobs SET state='done',result=? WHERE id=?").run(
        JSON.stringify({
          ok: true,
          completedAt: new Date(this.now()).toISOString(),
          receiptHash,
        }),
        id,
      );
    });
  }
  observe(job, result) {
    const o = result.observation,
      requested = JSON.parse(job.payload).productUrl;
    requireValue(o && o.affiliateObserved === true && typeof o.observedAt === 'string');
    const age = this.now() - Date.parse(o.observedAt);
    requireValue(
      Number.isFinite(age) &&
        age >= -5000 &&
        age <= 60000 &&
        ['available', 'unavailable', 'unknown'].includes(o.stockStatus),
    );
    const affiliateEnv =
      job.marketplace === 'amazon'
        ? { AMAZON_PARTNER_TAG: new URL(o.affiliateUrl).searchParams.get('tag') || '' }
        : {};
    const normalized = normalizeOfferInput(
      {
        ...o,
        available: undefined,
        marketplace: job.marketplace,
        affiliateConfirmed: true,
        price: o.priceCents / 100,
      },
      affiliateEnv,
    );
    requireValue(
      Number.isSafeInteger(o.priceCents) &&
        o.priceCents > 0 &&
        normalized.productKey === extractProductKey(job.marketplace, requested),
      'product_marketplace_mismatch',
    );
    requireValue(typeof o.priceCondition === 'string' && o.priceCondition.length <= 1000);
    const previous = this.store
      .prepare(
        'SELECT * FROM platform_observations WHERE marketplace=? AND product_key=? AND variant=?',
      )
      .get(job.marketplace, normalized.productKey, normalized.variant);
    requireValue(
      !previous || Date.parse(previous.observed_at) <= Date.parse(o.observedAt),
      'browser_import_stale',
    );
    let offer;
    if (job.kind === 'refresh') {
      const delivery = this.store
        .prepare('SELECT offer_id FROM deliveries WHERE id=?')
        .get(job.delivery_id);
      offer = delivery && this.store.getOffer(delivery.offer_id);
      requireValue(
        offer &&
          offer.marketplace === job.marketplace &&
          offer.product_key === normalized.productKey &&
          offer.variant === normalized.variant,
        'affiliate_product_mismatch',
      );
    } else
      offer = this.store
        .prepare(
          "SELECT * FROM offers WHERE marketplace=? AND product_key=? AND variant=? AND source='browser' AND discarded_at IS NULL ORDER BY id DESC LIMIT 1",
        )
        .get(job.marketplace, normalized.productKey, normalized.variant);
    this.store
      .prepare(
        `INSERT INTO platform_observations(marketplace,product_key,variant,product_url,price_cents,stock_status,observed_at,price_condition)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(marketplace,product_key,variant) DO UPDATE SET product_url=excluded.product_url,price_cents=excluded.price_cents,stock_status=excluded.stock_status,observed_at=excluded.observed_at,price_condition=excluded.price_condition`,
      )
      .run(
        job.marketplace,
        normalized.productKey,
        normalized.variant,
        normalized.productUrl,
        o.priceCents,
        o.stockStatus,
        o.observedAt,
        o.priceCondition,
      );
    const topic = this.topics().find((t) => t.id === job.topic_id);
    const eligible =
      !topic ||
      (o.priceCents >= topic.min_cents &&
        (topic.max_cents === null || o.priceCents <= topic.max_cents));
    const createObservedOffer = (editorial = {}) => {
      const created = this.store.createOffer(
        {
          ...o,
          ...editorial,
          available: undefined,
          marketplace: job.marketplace,
          affiliateConfirmed: true,
          price: o.priceCents / 100,
          note: editorial.note ?? o.priceCondition,
        },
        { env: affiliateEnv, deduplicate: false },
      );
      return this.store.setOfferEvidence(created.id, {
        source: 'browser',
        verifiedAt: o.observedAt,
        stockStatus: o.stockStatus,
      });
    };
    if (
      job.kind === 'refresh' &&
      offer?.published_at &&
      o.stockStatus === 'available' &&
      (o.priceCents > offer.price_cents ||
        (previous && previous.price_condition !== o.priceCondition))
    ) {
      const original = offer;
      for (const delivery of this.store
        .prepare("SELECT id FROM deliveries WHERE offer_id=? AND state='queued'")
        .all(original.id)) {
        this.store.blockDelivery(delivery.id, 'Preço ou condição mudou; revise e aprove novamente');
        this.store
          .prepare(
            "UPDATE browser_jobs SET state='cancelled',error='Aprovação substituída por nova revisão' WHERE delivery_id=? AND id!=? AND kind='refresh' AND state IN ('pending','running')",
          )
          .run(delivery.id, job.id);
      }
      // Preserve the published offer and sent/uncertain history; the new offer needs approval.
      offer = createObservedOffer({
        title: original.title,
        note: original.note === previous?.price_condition ? o.priceCondition : original.note,
      });
      this.store
        .prepare(
          'INSERT OR IGNORE INTO offer_topics SELECT ?,topic_id FROM offer_topics WHERE offer_id=?',
        )
        .run(offer.id, original.id);
      this.store.event('offer_revision_created', offer.id, { previousOfferId: original.id });
    }
    if (offer?.source === 'browser' && !offer.published_at) {
      if (
        job.kind !== 'refresh' &&
        normalized.affiliateUrl !== offer.affiliate_url &&
        !this.store
          .prepare(
            "SELECT 1 FROM deliveries WHERE offer_id=? AND state IN ('sending','sent','uncertain')",
          )
          .get(offer.id)
      ) {
        this.store
          .prepare('UPDATE offers SET affiliate_url=?,affiliate_validation=? WHERE id=?')
          .run(normalized.affiliateUrl, normalized.affiliateValidation, offer.id);
        for (const delivery of this.store
          .prepare("SELECT id FROM deliveries WHERE offer_id=? AND state='queued'")
          .all(offer.id))
          this.store.blockDelivery(
            delivery.id,
            'Link afiliado atualizado; revise a oferta e aprove novamente',
          );
      }
      if (
        normalized.imageUrl &&
        normalized.imageUrl !== offer.image_url &&
        !this.store
          .prepare(
            "SELECT 1 FROM deliveries WHERE offer_id=? AND state IN ('sending','sent','uncertain')",
          )
          .get(offer.id)
      ) {
        this.store
          .prepare('UPDATE offers SET image_url=? WHERE id=?')
          .run(normalized.imageUrl, offer.id);
        for (const delivery of this.store
          .prepare("SELECT id FROM deliveries WHERE offer_id=? AND state='queued'")
          .all(offer.id))
          this.store.blockDelivery(
            delivery.id,
            'Imagem atualizada; revise a oferta e aprove novamente',
          );
      }
      const evidence = this.store.evidenceFor(offer);
      this.store.updateCapturePrice(offer.id, evidence);
      if (
        previous &&
        offer.note === previous.price_condition &&
        previous.price_condition !== o.priceCondition
      )
        this.store.prepare('UPDATE offers SET note=? WHERE id=?').run(o.priceCondition, offer.id);
      for (const delivery of this.store
        .prepare("SELECT * FROM deliveries WHERE offer_id=? AND state='queued'")
        .all(offer.id)) {
        const meta = JSON.parse(delivery.approved_metadata);
        if (
          o.priceCents > delivery.approved_price_cents ||
          o.priceCondition !== meta.priceCondition
        )
          this.store.blockDelivery(
            delivery.id,
            'Preço ou condição mudou; revise e aprove novamente',
          );
      }
    }
    if (job.kind === 'refresh') {
      requireValue(offer, 'offer_not_found');
    } else if (eligible && o.stockStatus === 'available') {
      if (
        !offer ||
        (offer.published_at &&
          this.groups().some(
            (g) =>
              g.enabled &&
              (!topic || topic.groupIds.includes(g.id)) &&
              repeatAllowed(
                this.store.lastPublication(
                  normalized.productKey,
                  normalized.variant,
                  g.id,
                  job.marketplace,
                ),
                o.priceCents,
                this.now(),
              ),
          ))
      ) {
        offer = createObservedOffer();
      }
      if (offer && topic)
        this.store
          .prepare('INSERT OR IGNORE INTO offer_topics VALUES(?,?)')
          .run(offer.id, topic.id);
    }
    if (job.kind === 'validate')
      requireValue(o.stockStatus === 'available', 'stock_confirmation_required');
    const captureId = JSON.parse(job.payload).captureId;
    if (captureId && offer && o.stockStatus === 'available')
      this.store.bindCapture(captureId, offer.id);
    if (job.kind === 'validate')
      this.store
        .prepare(
          "UPDATE store_connections SET state='ready',last_error='',validated_at=?,last_seen_at=? WHERE marketplace=?",
        )
        .run(o.observedAt, o.observedAt, job.marketplace);
    else
      this.store
        .prepare('UPDATE store_connections SET last_seen_at=? WHERE marketplace=?')
        .run(o.observedAt, job.marketplace);
  }
  async preflight(job) {
    if (job.mode === 'automatic') {
      const check = checkAutomaticDelivery(
        this.store,
        this.store.getOffer(job.offer_id),
        job.delivery_destination,
      );
      if (!check.allowed) {
        this.store.blockDelivery(job.delivery_id, check.reason);
        return check;
      }
    }
    if (job.source === 'browser') {
      const refresh =
        job.refresh_job_id &&
        this.store.prepare('SELECT * FROM browser_jobs WHERE id=?').get(job.refresh_job_id);
      const connection = this.store.connection(job.marketplace);
      if (connection?.state !== 'ready')
        return {
          allowed: false,
          reason: 'Conexão da loja suspensa; valide novamente em Configurações',
          retryAfterMs: 15000,
        };
      const recovered =
        refresh?.state === 'failed' &&
        connection?.state === 'ready' &&
        Date.parse(connection.validated_at) > Date.parse(refresh.created_at);
      if (
        !refresh ||
        recovered ||
        (refresh.state === 'done' &&
          this.now() -
            Date.parse(JSON.parse(refresh.result || '{}').completedAt || refresh.created_at) >
            60000)
      ) {
        const id = this.addJob(
          job.marketplace,
          'refresh',
          { productUrl: job.product_url },
          { deliveryId: job.delivery_id },
        );
        this.store
          .prepare('UPDATE deliveries SET refresh_job_id=? WHERE id=?')
          .run(id, job.delivery_id);
        return {
          allowed: false,
          reason: 'Atualizando preço e disponibilidade antes do envio',
          retryAfterMs: 15000,
        };
      }
      if (refresh.state !== 'done')
        return {
          allowed: false,
          reason: refresh.error || 'Aguardando atualização pelo navegador',
          retryAfterMs: 15000,
        };
    }
    return this.policy.preflight(job);
  }
  tick(force = false) {
    if (!force && this.store.setting('search_enabled', 'false') !== 'true') return;
    if (!force && Date.parse(this.store.setting('next_search_at', '1970-01-01')) > this.now())
      return;
    if (
      this.store
        .prepare(
          "SELECT 1 FROM browser_jobs WHERE state IN ('pending','running') AND kind IN ('search','product')",
        )
        .get()
    )
      return;
    let created = 0;
    for (const topic of this.topics().filter((t) => t.enabled))
      for (const marketplace of topic.stores) {
        if (this.store.connection(marketplace)?.state !== 'ready') continue;
        for (const keyword of topic.keywords) {
          this.addJob(
            marketplace,
            'search',
            { keyword, minCents: topic.min_cents, maxCents: topic.max_cents },
            { topicId: topic.id },
          );
          created++;
        }
      }
    if (!created) return;
    this.store.setSetting('last_search_at', new Date(this.now()).toISOString());
    this.store.setSetting('next_search_at', new Date(this.now() + 1800000).toISOString());
  }
  start() {
    if (!this.timer)
      this.timer = setInterval(() => {
        try {
          this.automation.tick();
          this.tick();
        } catch (e) {
          console.error('Search cycle failed', e.message);
        }
      }, 30000);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
