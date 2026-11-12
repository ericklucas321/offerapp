import { toCents } from './messages.mjs';
// Intl formatters are costly to build and couponPrice runs for every rendered message.
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brl = (cents) => BRL.format(cents / 100);
const BRASILIA = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  dateStyle: 'short',
  timeStyle: 'short',
});
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
  const minCents = toCents(minimum);
  const maxCents = maximum == null ? null : toCents(maximum);
  if (
    !Number.isFinite(minCents) ||
    minCents < 0 ||
    (maxCents != null && (!Number.isFinite(maxCents) || maxCents <= 0))
  )
    throw new Error('invalid_coupon');
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new Error('invalid_coupon');
  if (expiresAt && Date.parse(expiresAt) <= now) throw new Error('coupon_expired');
  if (priceCents < minCents)
    return {
      final: priceCents,
      condition: `Cupom não aplicado: esta oferta está abaixo da compra mínima de ${brl(minCents)}.`,
    };
  let discount =
    type === 'percent' ? Math.round((priceCents * Number(value)) / 100) : toCents(value);
  if (maxCents != null) discount = Math.min(discount, maxCents);
  const details = [];
  if (minCents > 0) details.push(`Compra mínima: ${brl(minCents)}.`);
  if (maxCents != null) details.push(`Desconto limitado a ${brl(maxCents)}.`);
  if (expiresAt) details.push(`Válido até ${BRASILIA.format(new Date(expiresAt))} (Brasília).`);
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
