import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/infrastructure/repository.mjs';
import { Offers } from '../src/application/offers.mjs';
import { Platform } from '../src/application/platform.mjs';
import { PublicationPolicy } from '../src/domain/publication.mjs';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-legacy-review-'));
  const store = new Store({ dataDir });
  t.after(() => {
    store.close();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('offer-legacy-review-'));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const now = Date.parse('2026-11-01T15:00:00Z');
  const policy = new PublicationPolicy({ store, now: () => now });
  const offers = new Offers({ store, policy, now: () => now });
  const platform = new Platform({ store, offers, policy, now: () => now });
  store.saveDestination('123@g.us', 'Fixture');
  store.setSetting('publication_paused', 'false');
  platform.saveGroup({ id: '123@g.us', startMinute: 0, endMinute: 0, intervalMinutes: 5 }, [
    { id: '123@g.us', name: 'Fixture' },
  ]);
  const create = (n = 1) =>
    offers.manual({
      title: `Produto ${n}`,
      price: 100,
      productUrl: `https://produto.mercadolivre.com.br/MLB-${123456780 + n}-fixture`,
      affiliateUrl: `https://meli.la/test${n}`,
      affiliateConfirmed: true,
      availableConfirmed: true,
    });
  const publish = (offer) =>
    offers.publish(offer.id, {
      confirmed: true,
      reviewToken: offers.preview(offer.id).reviewToken,
    });
  return { store, offers, platform, policy, create, publish, now };
}

test('single-offer publication rejects a disabled saved destination', (t) => {
  const { store, create, publish } = fixture(t);
  store.prepare('UPDATE destination_groups SET enabled=0').run();
  assert.throws(() => publish(create()), /publication_not_ready/);
  assert.equal(store.listDeliveries().length, 0);
});

test('single-offer approval records the current group revision', (t) => {
  const { store, create, publish } = fixture(t);
  const delivery = publish(create());
  assert.equal(
    delivery.group_revision,
    store.prepare('SELECT revision FROM destination_groups').get().revision,
  );
});

test('single-offer approval is invalidated when the saved default destination changes', (t) => {
  const { store, policy, create, publish } = fixture(t);
  const offer = create();
  const delivery = publish(offer);
  store.saveDestination('456@g.us', 'Outro');
  const check = policy.preflight({
    ...offer,
    ...delivery,
    offer_id: offer.id,
    delivery_id: delivery.id,
    delivery_destination: delivery.destination,
  });
  assert.equal(check.allowed, false);
  assert.equal(store.listDeliveries()[0].state, 'cancelled');
});

test('preflight blocks old unversioned approval when its saved group is disabled', (t) => {
  const { store, policy, create, publish } = fixture(t);
  const offer = create();
  const delivery = publish(offer);
  store.prepare('UPDATE deliveries SET group_revision=NULL WHERE id=?').run(delivery.id);
  store.prepare('UPDATE destination_groups SET enabled=0').run();
  const check = policy.preflight({
    ...offer,
    ...delivery,
    offer_id: offer.id,
    delivery_id: delivery.id,
    delivery_destination: delivery.destination,
  });
  assert.equal(check.allowed, false);
  assert.equal(store.listDeliveries()[0].state, 'cancelled');
});

test('single-offer scheduling reserves an interval after existing queued delivery', (t) => {
  const { create, publish, now } = fixture(t);
  const first = publish(create(1));
  const second = publish(create(2));
  assert.equal(Date.parse(first.scheduled_at), now);
  assert.equal(Date.parse(second.scheduled_at), now + 5 * 60000);
});

test('single-offer review must be renewed after group scheduling rules change', (t) => {
  const { offers, platform, create } = fixture(t);
  const offer = create();
  const reviewToken = offers.preview(offer.id).reviewToken;
  platform.saveGroup({ id: '123@g.us', startMinute: 0, endMinute: 0, intervalMinutes: 10 }, [
    { id: '123@g.us', name: 'Fixture' },
  ]);
  assert.throws(
    () => offers.publish(offer.id, { confirmed: true, reviewToken }),
    /publication_review_changed/,
  );
});

test('single-offer publication to another group uses that destination repeat history', (t) => {
  const { store, create, publish } = fixture(t);
  const offer = create();
  const first = publish(offer);
  store.markSent(first.id, offer.id);
  store.saveDestination('456@g.us', 'Outro');
  const second = publish(offer);
  assert.equal(second.destination, '456@g.us');
  assert.equal(second.state, 'queued');
});
