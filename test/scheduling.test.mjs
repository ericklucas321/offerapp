import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPublicationAt } from '../src/domain/publication.mjs';
import { publicationWindow } from '../src/domain/rules.mjs';

test('agendamento respeita abertura e fechamento em Brasília e conserva horário já permitido', () => {
  for (const [start, expected] of [
    ['2026-10-18T10:59:59Z', '2026-10-18T11:00:00.000Z'],
    ['2026-10-18T11:00:00Z', '2026-10-18T11:00:00.000Z'],
    ['2026-10-19T00:59:59Z', '2026-10-19T00:59:59.000Z'],
    ['2026-10-19T01:00:00Z', '2026-10-19T11:00:00.000Z'],
  ])
    assert.equal(nextPublicationAt([], Date.parse(start)), expected);
});

test('intervalo exige 60 minutos completos e busca arredonda para o próximo minuto', () => {
  const sent = [{ sent_at: '2026-10-18T14:00:30Z' }];
  assert.equal(publicationWindow(sent, Date.parse('2026-10-18T15:00:29Z')).allowed, false);
  assert.equal(publicationWindow(sent, Date.parse('2026-10-18T15:00:30Z')).allowed, true);
  assert.equal(
    nextPublicationAt(sent, Date.parse('2026-10-18T14:30:00Z')),
    '2026-10-18T15:01:00.000Z',
  );
});

test('histórico extenso não cria teto diário e a janela continua em Brasília', () => {
  const sent = Array.from({ length: 1500 }, (_, i) => ({
    sent_at: new Date(Date.parse('2026-01-01T12:00:00Z') + i * 3600000).toISOString(),
  }));
  sent.push(...Array.from({ length: 11 }, () => ({ sent_at: '2026-10-18T12:00:00Z' })));
  // 00:30 UTC ainda pertence ao dia anterior em Brasília.
  sent.unshift({ sent_at: '2026-10-19T00:30:00Z' });
  assert.equal(
    nextPublicationAt(sent, Date.parse('2026-10-19T00:45:00Z')),
    '2026-10-19T11:00:00.000Z',
  );
  assert.equal(
    nextPublicationAt(sent, Date.parse('2026-10-19T12:00:00Z')),
    '2026-10-19T12:00:00.000Z',
  );
});

test('buscas sucessivas incorporam novos envios sem reutilizar resumo antigo', () => {
  const start = Date.parse('2026-10-18T15:00:00Z');
  const sent = [];
  assert.equal(nextPublicationAt(sent, start), '2026-10-18T15:00:00.000Z');
  sent.push({ sent_at: '2026-10-18T15:00:00Z' });
  assert.equal(nextPublicationAt(sent, start), '2026-10-18T16:00:00.000Z');
});
