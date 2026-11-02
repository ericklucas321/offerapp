import { toCents } from './messages.mjs';
export function couponPrice(priceCents, code, rules, now = Date.now()) {
  if (!code || !rules)
    return {
      final: priceCents,
      condition: code ? 'Confira as regras do cupom; desconto não calculado.' : '',
    };
  const { type, value, minimum = 0, maximum, expiresAt } = rules;
  if (
    !['percent', 'fixed'].includes(type) ||
    !Number.isFinite(Number(value)) ||
    Number(value) <= 0 ||
    (type === 'percent' && Number(value) > 100)
  )
    throw new Error('invalid_coupon');
  if (
    !Number.isFinite(toCents(minimum)) ||
    toCents(minimum) < 0 ||
    (maximum != null && (!Number.isFinite(toCents(maximum)) || toCents(maximum) <= 0))
  )
    throw new Error('invalid_coupon');
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new Error('invalid_coupon');
  if (expiresAt && Date.parse(expiresAt) <= now) throw new Error('coupon_expired');
  if (priceCents < toCents(minimum))
    return {
      final: priceCents,
      condition: `Cupom não aplicado: esta oferta está abaixo da compra mínima de ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(toCents(minimum) / 100)}.`,
    };
  let discount =
    type === 'percent' ? Math.round((priceCents * Number(value)) / 100) : toCents(value);
  if (maximum != null) discount = Math.min(discount, toCents(maximum));
  const brl = (cents) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
  const details = [];
  if (toCents(minimum) > 0) details.push(`Compra mínima: ${brl(toCents(minimum))}.`);
  if (maximum != null) details.push(`Desconto limitado a ${brl(toCents(maximum))}.`);
  if (expiresAt)
    details.push(
      `Válido até ${new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(expiresAt))} (Brasília).`,
    );
  if (rules.conditions) details.push(String(rules.conditions).trim());
  details.push('Sujeito à elegibilidade e disponibilidade no checkout.');
  return { final: Math.max(0, priceCents - discount), condition: details.join(' ') };
}
export function scoreOffer(offer, history, weights = {}) {
  const w = { historical: 60, advertised: 20, coupon: 20, ...weights };
  if (Object.values(w).some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0))
    throw new Error('invalid_score_weights');
  const components = {};
  const average = history?.average_cents;
  components.historical = average
    ? Math.max(0, Math.min(1, (average - offer.priceCents) / average / 0.3)) * w.historical
    : 0;
  components.advertised = offer.oldPriceCents
    ? Math.max(
        0,
        Math.min(1, (offer.oldPriceCents - offer.priceCents) / offer.oldPriceCents / 0.5),
      ) * w.advertised
    : 0;
  components.coupon = offer.finalPriceCents < offer.priceCents ? w.coupon : 0;
  return {
    score: Math.round(
      Math.max(
        0,
        Math.min(
          100,
          Object.values(components).reduce((a, b) => a + b, 0),
        ),
      ),
    ),
    components,
    historyCount: history?.count || 0,
    confidence: (history?.count || 0) >= 5 ? 'observed_history' : 'limited_history',
  };
}
