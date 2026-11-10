import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/infrastructure/repository.mjs';
import { Offers } from '../src/application/offers.mjs';
import { PublicationPolicy } from '../src/domain/publication.mjs';
import { createServer } from '../src/http/server.mjs';
import { Platform } from '../src/application/platform.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.parse('2026-10-05T15:00:00Z');
const item = {
  stage: 'product',
  productKey: 'MLB987654321',
  variant: '',
  title: 'Oferta fixture HTTP',
  productUrl: 'https://produto.mercadolivre.com.br/MLB-987654321-fixture',
  imageUrl: 'https://http2.mlstatic.com/fixture.webp',
  priceCents: 12345,
  available: true,
  observedAt: new Date(NOW).toISOString(),
  priceCondition: 'Preço à vista anunciado',
};
async function fixture(t) {
  const store = new Store({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'clean-http-')) });
  store.setSetting('publication_paused', 'true');
  store.saveDestination('123@g.us', 'Fixture');
  const publisher = {
    status: () => ({ state: 'connected', lastError: null }),
    qrDataUrl: async () => null,
    groups: async () => [{ id: '123@g.us', name: 'Fixture' }],
    connect: async () => ({ state: 'connected' }),
  };
  const policy = new PublicationPolicy({ store, now: () => NOW }),
    offers = new Offers({ store, policy, now: () => NOW });
  const platform = new Platform({ store, offers, policy, now: () => NOW });
  const server = createServer({ store, publisher, offers, root, platform });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, data, headers = {}) =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(data),
    });
  return { store, server, base, post };
}
test('API operacional oferece três áreas, rejeita origens externas e remove rotas experimentais', async (t) => {
  const { base, post } = await fixture(t);
  const html = await (await fetch(base)).text();
  assert.match(html, /Ofertas/);
  assert.match(html, /Envios/);
  assert.match(html, /Canais/);
  assert.match(html, /Configurar/);
  for (const text of ['Conectar Mercado Livre', 'V4 ·', 'Piloto', 'Gerar meu link'])
    assert.equal(html.includes(text), false);
  for (const route of [
    '/api/discovery',
    '/api/mercadolivre/auth/status',
    '/api/browser/status',
    '/api/validation',
    '/api/links/status',
  ])
    assert.equal((await fetch(base + route)).status, 404);
  assert.equal(
    (await post('/api/publication/pause', { paused: false }, { origin: 'https://evil.example' }))
      .status,
    403,
  );
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(base + '/api/view', { headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(base + '/../../.env')).status, 404);
  const download = await fetch(base + '/downloads/browser-extension.zip');
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /zip/);
});
test('captura, vínculo, mensagem e aprovação usam uma só operação, sem enviar durante importação', async (t) => {
  const { base, post, store } = await fixture(t);
  let r = await post('/api/browser-import/capture', {
    packet: { version: 1, items: [item] },
    confirmed: true,
  });
  assert.equal(r.status, 201);
  assert.equal(store.listDeliveries().length, 0);
  let view = await (await fetch(base + '/api/view?section=offers')).json();
  assert.equal(view.items.length, 1);
  const captureId = view.items[0].captureId;
  r = await post(`/api/captures/${captureId}/prepare`, {
    affiliateUrl: 'https://meli.la/http-fixture',
    affiliateConfirmed: true,
  });
  assert.equal(r.status, 201);
  const saved = await r.json();
  assert.match(saved.message, /123,45/);
  assert.equal(saved.queued, false);
  r = await post(`/api/offers/${saved.offer.id}/publish`, {
    confirmed: true,
    reviewToken: saved.reviewToken,
  });
  assert.equal((await r.json()).error, 'publication_paused');
  await post('/api/publication/pause', { paused: false });
  r = await post(`/api/offers/${saved.offer.id}/publish`, {
    confirmed: true,
    reviewToken: saved.reviewToken,
  });
  assert.equal(r.status, 200);
  const job = (await r.json()).delivery;
  assert.equal(job.state, 'queued');
  assert.ok(job.approved_message);
  r = await post(`/api/offers/${saved.offer.id}/publish`, {
    confirmed: true,
    reviewToken: saved.reviewToken,
  });
  assert.equal((await r.json()).delivery.id, job.id);
  r = await post(`/api/queue/${job.id}/cancel`, {});
  assert.equal((await r.json()).delivery.state, 'cancelled');
  assert.equal(store.queueStats().sent, 0);
});
test('entrada inválida, parcial ou não confirmada não cria registros nem libera publicação', async (t) => {
  const { post, store, base } = await fixture(t);
  assert.equal(
    (
      await post('/api/browser-import/capture', {
        packet: { version: 1, items: [item] },
        confirmed: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post('/api/browser-import/capture', {
        packet: { version: 1, items: [item, { ...item, priceCents: 0 }] },
        confirmed: true,
      })
    ).status,
    400,
  );
  assert.equal(store.captures().length, 0);
  const bad = await fetch(base + '/api/publication/pause', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(bad.status, 400);
  assert.equal(store.setting('publication_paused'), 'true');
});

test('JSON conserva acentos mesmo com caractere UTF-8 dividido entre chunks', async (t) => {
  const { base, store } = await fixture(t);
  const title = 'Oferta de café';
  const data = Buffer.from(
    JSON.stringify({
      title,
      price: 12.34,
      productUrl: item.productUrl,
      affiliateUrl: 'https://meli.la/utf8-fixture',
      affiliateConfirmed: true,
      availableConfirmed: true,
    }),
  );
  const split = data.indexOf(Buffer.from('é')) + 1;
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      base + '/api/offers',
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.write(data.subarray(0, split));
    setTimeout(() => req.end(data.subarray(split)), 20);
  });
  assert.equal(status, 201);
  assert.equal(store.listOffers()[0].title, title);
});

test('API não aprova prévia antiga nem deixa pular a revisão', async (t) => {
  const { post, store, base } = await fixture(t);
  const created = await (
    await post('/api/offers', {
      title: 'Mensagem original',
      price: 99,
      productUrl: item.productUrl,
      affiliateUrl: 'https://meli.la/review-fixture',
      affiliateConfirmed: true,
      availableConfirmed: true,
    })
  ).json();
  await post('/api/publication/pause', { paused: false });
  const route = `/api/offers/${created.offer.id}/publish`;
  assert.equal(
    (await (await post(route, { confirmed: true })).json()).error,
    'publication_review_required',
  );
  const before = await (await fetch(base + `/api/offers/${created.offer.id}/preview`)).json();
  assert.equal(before.destination.name, 'Fixture');
  await post(`/api/offers/${created.offer.id}/edit`, {
    title: 'Mensagem atualizada',
    price: 109,
    availableConfirmed: true,
    affiliateConfirmed: true,
  });
  const rejected = await post(route, { confirmed: true, reviewToken: before.reviewToken });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error, 'publication_review_changed');
  assert.equal(store.listDeliveries().length, 0);
  const after = await (await fetch(base + `/api/offers/${created.offer.id}/preview`)).json();
  assert.notEqual(after.reviewToken, before.reviewToken);
  assert.match(after.message, /109,00/);
  assert.equal(
    (await post(route, { confirmed: true, reviewToken: after.reviewToken })).status,
    200,
  );
  assert.equal(store.listDeliveries()[0].approved_message, after.message);
});

test('API de lotes valida destinos e é idempotente; ponte só aceita extensão pareada com token', async (t) => {
  const { base, post, store } = await fixture(t);
  const paired = await (await post('/api/bridge/pair', { extensionId: 'a'.repeat(32) })).json();
  assert.equal(typeof paired.token, 'string');
  assert.equal((await fetch(base + '/api/bridge/jobs')).status, 403);
  assert.equal(
    (
      await fetch(base + '/api/bridge/jobs', {
        headers: {
          origin: 'chrome-extension://' + 'b'.repeat(32),
          authorization: `Bearer ${paired.token}`,
        },
      })
    ).status,
    403,
  );
  const authenticated = await fetch(base + '/api/bridge/jobs', {
    headers: {
      origin: 'chrome-extension://' + 'a'.repeat(32),
      authorization: `Bearer ${paired.token}`,
    },
  });
  assert.equal(authenticated.status, 200);
  assert.equal(
    authenticated.headers.get('access-control-allow-origin'),
    'chrome-extension://' + 'a'.repeat(32),
  );
  const config = await (await fetch(base + '/api/platform')).json();
  assert.equal(JSON.stringify(config).includes(paired.token), false);
  assert.equal((await post('/api/platform/groups', { id: '999@g.us' })).status, 400);
  const created = await (
    await post('/api/offers', {
      title: 'Lote HTTP',
      price: 50,
      productUrl: item.productUrl,
      affiliateUrl: 'https://meli.la/batch-http',
      affiliateConfirmed: true,
      availableConfirmed: true,
    })
  ).json();
  assert.equal(
    (
      await post('/api/review/preview', {
        selection: [{ offerId: created.offer.id, groupIds: ['999@g.us'] }],
      })
    ).status,
    400,
  );
  const batch = await (
    await post('/api/review/preview', {
      selection: [{ offerId: created.offer.id, groupIds: ['123@g.us'] }],
    })
  ).json();
  await post('/api/publication/pause', { paused: false });
  const approved = await post('/api/review/approve', {
    id: batch.id,
    token: batch.token,
    confirmed: true,
  });
  assert.equal(approved.status, 200);
  assert.equal(
    (await post('/api/review/approve', { id: batch.id, token: batch.token, confirmed: true }))
      .status,
    200,
  );
  assert.equal(store.listDeliveries().length, 1);
});

test('API prepara uma captura automaticamente sem link manual nem agendar envio', async (t) => {
  const { store, base, post } = await fixture(t);
  store.setSetting('bridge_last_seen', String(NOW));
  await post('/api/browser-import/capture', {
    packet: {
      version: 1,
      items: [{ ...item, stage: 'card', available: false, stockStatus: 'unknown' }],
    },
    confirmed: true,
  });
  const capture = store.captures()[0];
  const response = await post(`/api/captures/${capture.id}/resolve`, {});
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(
    (await (await post(`/api/captures/${capture.id}/resolve`, {})).json()).jobId,
    result.jobId,
  );
  const status = await (await fetch(`${base}/api/captures/${capture.id}/resolution`)).json();
  assert.equal(status.state, 'pending');
  assert.equal(status.offerId, null);
  assert.equal(
    (
      await fetch(`${base}/api/captures/${capture.id}/resolution`, {
        headers: { 'sec-fetch-site': 'cross-site' },
      })
    ).status,
    403,
  );
  assert.equal((await post('/api/captures/999999/resolve', {})).status, 400);
  assert.equal(store.listDeliveries().length, 0);
});

test('HTTP permite abrir o painel por link sem liberar API para outra origem', async (t) => {
  const { base } = await fixture(t);
  const request = (route, method = 'GET', mode = 'navigate', dest = 'document') =>
    new Promise((resolve, reject) => {
      const req = http.request(
        base + route,
        {
          method,
          headers: {
            'sec-fetch-site': 'cross-site',
            'sec-fetch-mode': mode,
            'sec-fetch-dest': dest,
            Origin: 'https://example.org',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
  assert.equal(await request('/'), 200);
  assert.equal(await request('/api/view'), 403);
  assert.equal(await request('/api/publication/pause', 'POST'), 403);
  assert.equal(await request('/', 'GET', 'cors', 'empty'), 403);
  assert.equal(await request('/', 'GET', 'navigate', 'iframe'), 403);
});

test('auditoria HTTP: corpo inválido e seleção nula são rejeitados sem erro interno', async (t) => {
  const { base, post } = await fixture(t);
  for (const selection of [[null], [1], [{}], [{ offerId: 1, groupIds: null }]])
    assert.equal((await post('/api/review/preview', { selection })).status, 400);
  assert.equal(
    (await post('/api/publication/pause', { paused: false, padding: 'x'.repeat(150000) })).status,
    400,
  );
  const page = await fetch(base);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(
    (await fetch(base + '/api/view', { headers: { 'sec-fetch-site': 'cross-site' } })).status,
    403,
  );
  const paired = await (await post('/api/bridge/pair', { extensionId: 'a'.repeat(32) })).json();
  assert.equal(
    (
      await fetch(base + '/api/bridge/jobs', {
        headers: { authorization: 'Bearer ' + 'ç'.repeat(64) },
      })
    ).status,
    403,
  );
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      base + '/api/bridge/jobs',
      {
        method: 'OPTIONS',
        headers: { Host: 'evil.example', Origin: 'chrome-extension://' + 'a'.repeat(32) },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  assert.equal(typeof paired.token, 'string');
});
