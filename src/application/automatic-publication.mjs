import { automaticConfiguration, automaticTopic } from '../domain/automatic.mjs';
import { publicationWindow } from '../domain/rules.mjs';
export class AutomaticPublication {
  constructor({ store, policy, platform, now = Date.now, publisherReady = () => false }) {
    Object.assign(this, { store, policy, platform, now, publisherReady });
  }
  configure({ enabled, groupIds }) {
    const groups = this.platform.groups();
    if (
      typeof enabled !== 'boolean' ||
      (enabled &&
        (!Array.isArray(groupIds) ||
          !groupIds.length ||
          groupIds.some((id) => !groups.some((g) => g.id === id && g.enabled))))
    )
      throw new Error('invalid_request');
    const ids = enabled
      ? [...new Set(groupIds)]
      : automaticConfiguration(this.store).automaticGroupIds;
    this.store.transaction(() => {
      this.store.setSetting('automatic_groups', JSON.stringify(ids));
      this.store.setSetting('automatic_enabled', String(enabled));
      for (const delivery of this.store
        .prepare("SELECT id,destination FROM deliveries WHERE mode='automatic' AND state='queued'")
        .all())
        if (!enabled || !ids.includes(delivery.destination))
          this.store.blockDelivery(delivery.id, 'Envio automático desligado para este grupo');
      this.store.event('automatic_mode_changed', null, { enabled, groupIds: ids });
    });
    return automaticConfiguration(this.store);
  }
  tick() {
    const config = automaticConfiguration(this.store);
    if (
      !config.automaticEnabled ||
      this.store.setting('publication_paused', 'true') === 'true' ||
      !this.publisherReady() ||
      !this.platform.bridgeConnected()
    )
      return;
    let candidates;
    for (const group of this.platform
      .groups()
      .filter((g) => g.enabled && config.automaticGroupIds.includes(g.id))) {
      if (!publicationWindow(this.store.sentDeliveries(group.id), this.now(), group).allowed)
        continue;
      if (
        this.store
          .prepare("SELECT 1 FROM deliveries WHERE destination=? AND state IN ('queued','sending')")
          .get(group.id)
      )
        continue;
      candidates ??= this.store
        .prepare(
          "SELECT * FROM offers WHERE source='browser' AND discarded_at IS NULL ORDER BY verified_at DESC,id DESC",
        )
        .all();
      for (const offer of candidates) {
        const topic = automaticTopic(this.store, offer, group.id);
        if (!topic || !this.policy.ready(offer, group.id).allowed) continue;
        if (
          this.store
            .prepare(
              "SELECT 1 FROM deliveries d JOIN offers o ON o.id=d.offer_id WHERE d.destination=? AND o.marketplace=? AND o.product_key=? AND o.variant=? AND (d.state IN ('queued','sending','uncertain') OR d.state='failed' OR (d.offer_id=? AND d.state='sent'))",
            )
            .get(group.id, offer.marketplace, offer.product_key, offer.variant, offer.id)
        )
          continue;
        this.store.transaction(() => {
          const delivery = this.store.enqueue(offer.id, group.id, {
            mode: 'automatic',
            scheduledAt: new Date(this.now()).toISOString(),
          });
          this.store.approveDelivery(delivery.id, offer);
          this.store
            .prepare('UPDATE deliveries SET group_revision=? WHERE id=?')
            .run(group.revision, delivery.id);
          this.store.event('automatic_offer_scheduled', offer.id, {
            deliveryId: delivery.id,
            destination: group.id,
            topicId: topic.id,
          });
        });
        break;
      }
    }
  }
}
