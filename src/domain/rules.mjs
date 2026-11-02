export const RULES = Object.freeze({
  timezone: 'America/Sao_Paulo',
  startHour: 8,
  endHour: 22,
  minIntervalMs: 3600000,
  freshnessMs: 900000,
  historyMinimum: 5,
  historySpanMs: 86400000,
  discount: 0.15,
  repeatMs: 259200000,
  repeatReduction: 0.1,
});
const clockFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: RULES.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
});
export function localClock(now) {
  const parts = Object.fromEntries(
    clockFormatter.formatToParts(new Date(now)).map((p) => [p.type, p.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}
export function historyMedian(rows) {
  const values = rows.map((row) => row.price_cents).sort((a, b) => a - b);
  const n = values.length;
  return n ? (n % 2 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2) : null;
}
export function evaluateCandidate(candidate, history, now = Date.now()) {
  const reasons = [];
  const observations = history.filter(
    (row) => Date.parse(row.observed_at) < Date.parse(candidate.observed_at),
  );
  const distinct = [...new Map(observations.map((row) => [row.observed_at, row])).values()];
  const times = distinct.map((row) => Date.parse(row.observed_at));
  const median = historyMedian(distinct);
  if (candidate.available !== 1 && candidate.available !== true)
    reasons.push('Estoque não confirmado');
  const age = now - Date.parse(candidate.observed_at);
  if (!Number.isFinite(age) || age < 0 || age > RULES.freshnessMs)
    reasons.push('Preço desatualizado');
  if (!candidate.affiliate_url || candidate.affiliate_confirmed !== 1)
    reasons.push('Aguardando link afiliado confirmado');
  if (
    distinct.length < RULES.historyMinimum ||
    Math.max(...times) - Math.min(...times) < RULES.historySpanMs
  )
    reasons.push('Histórico insuficiente: mínimo de 5 observações em 24 horas');
  const discount = median ? 1 - candidate.price_cents / median : 0;
  if (discount + 1e-10 < RULES.discount)
    reasons.push('Preço ainda não caiu 15% em relação à mediana');
  return {
    eligible: reasons.length === 0,
    reasons,
    medianCents: median,
    discount,
    observations: distinct.length,
  };
}
export function repeatAllowed(last, price, now = Date.now()) {
  return (
    !last ||
    now - Date.parse(last.sent_at) >= RULES.repeatMs ||
    price <= Math.floor(last.final_price_cents * (1 - RULES.repeatReduction))
  );
}
export function createPublicationWindow(sent, group = {}) {
  let last = 0;
  let invalid = false;
  for (const row of sent) {
    const at = Date.parse(row.sent_at);
    if (!Number.isFinite(at)) invalid = true;
    else last = Math.max(last, at);
  }
  const start = group.start_minute ?? RULES.startHour * 60;
  const end = group.end_minute ?? RULES.endHour * 60;
  const interval = (group.interval_minutes ?? 60) * 60000;
  return (now = Date.now()) => {
    if (invalid || !Number.isFinite(now))
      return { allowed: false, reason: 'Histórico de horários inválido; confira os envios' };
    const clock = localClock(now),
      minute = clock.hour * 60 + clock.minute;
    const inWindow =
      start === end ||
      (start < end ? minute >= start && minute < end : minute >= start || minute < end);
    if (!inWindow) return { allowed: false, reason: 'Fora do horário configurado para o grupo' };
    if (last && now - last < interval)
      return {
        allowed: false,
        reason: `Intervalo mínimo de ${interval / 60000} minutos neste grupo`,
      };
    return { allowed: true, reason: '' };
  };
}
export function publicationWindow(sent, now = Date.now(), group = {}) {
  return createPublicationWindow(sent, group)(now);
}
