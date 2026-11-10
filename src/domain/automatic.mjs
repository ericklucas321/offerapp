export function automaticConfiguration(store) {
  return {
    automaticEnabled: store.setting('automatic_enabled', 'false') === 'true',
    automaticGroupIds: JSON.parse(store.setting('automatic_groups', '[]')),
  };
}
const words = (value) =>
  String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
export function titleMatchesTopic(title, keywords) {
  const titleWords = new Set(words(title));
  return keywords.some((keyword) => {
    const tokens = words(keyword);
    return (
      tokens.length &&
      tokens.every(
        (token) =>
          titleWords.has(token) || (token.length > 3 && titleWords.has(token.replace(/s$/, ''))),
      )
    );
  });
}
export function automaticTopic(store, offer, destination) {
  if (!offer || offer.source !== 'browser' || offer.discarded_at) return null;
  const topics = store
    .prepare(
      'SELECT t.* FROM topics t JOIN offer_topics ot ON ot.topic_id=t.id WHERE ot.offer_id=? AND t.enabled=1 ORDER BY t.id',
    )
    .all(offer.id);
  return (
    topics.find(
      (t) =>
        JSON.parse(t.stores).includes(offer.marketplace) &&
        (JSON.parse(t.group_ids).length === 0 || JSON.parse(t.group_ids).includes(destination)) &&
        offer.price_cents >= t.min_cents &&
        (t.max_cents === null || offer.price_cents <= t.max_cents) &&
        titleMatchesTopic(offer.title, JSON.parse(t.keywords)),
    ) || null
  );
}
export function checkAutomaticDelivery(store, offer, destination) {
  const config = automaticConfiguration(store);
  if (!config.automaticEnabled || !config.automaticGroupIds.includes(destination))
    return { allowed: false, reason: 'Envio automático desligado para este grupo' };
  if (!automaticTopic(store, offer, destination))
    return {
      allowed: false,
      reason: 'Oferta fora dos temas, lojas ou preços atuais do automático',
    };
  return { allowed: true, reason: '' };
}
