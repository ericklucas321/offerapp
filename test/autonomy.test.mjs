import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/infrastructure/repository.mjs';
import { Offers } from '../src/application/offers.mjs';
import { PublicationPolicy } from '../src/domain/publication.mjs';
import { Platform } from '../src/application/platform.mjs';

const START = Date.parse('2026-10-05T15:00:00Z');
const url = (n) => `https://produto.mercadolivre.com.br/MLB-${123456780 + n}-teste`;
const connection = (platform) =>
  platform.status().connections.find((c) => c.marketplace === 'mercadolivre');

function fixture(t) {
  const store = new Store({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'offer-auto-')) });
  t.after(() => store.close());
  let now = START;
  const clock = () => now;
  const policy = new PublicationPolicy({ store, now: clock }),
    offers = new Offers({ store, policy, now: clock }),
    platform = new Platform({ store, offers, policy, now: clock });
  store.setSetting('search_enabled', 'true');
  const observation = (n = 1) => ({
    productUrl: url(n),
    title: `Produto ${n}`,
    priceCents: 10000,
    stockStatus: 'available',
    priceCondition: 'À vista',
    observedAt: new Date(now).toISOString(),
    affiliateUrl: `https://meli.la/item${n}`,
    affiliateObserved: true,
  });
  const ready = () =>
    store.db
      .prepare("UPDATE store_connections SET state='ready' WHERE marketplace='mercadolivre'")
      .run();
  return {
    store,
    platform,
    observation,
    ready,
    advance: (ms) => {
      now += ms;
    },
  };
}

test('parear a extensão já habilita o Mercado Livre sem validação manual', (t) => {
  const { platform } = fixture(t);
  assert.equal(connection(platform).state, 'unconfigured');
  platform.pair('a'.repeat(32));
  assert.equal(connection(platform).state, 'ready');
});

test('falha comum de um produto não suspende a loja nem cancela os outros produtos', (t) => {
  const { platform, ready } = fixture(t);
  ready();
  platform.addJob('mercadolivre', 'product', { productUrl: url(1) });
  platform.addJob('mercadolivre', 'product', { productUrl: url(2) });
  const job = platform.claimJob();
  platform.completeJob(job.id, { error: 'A página demorou', code: 'page_timeout' });
  assert.equal(connection(platform).state, 'ready');
  assert.equal(platform.claimJob().payload.productUrl, url(2));
});

test('tempo esgotado falha só o trabalho, sem suspender a loja', (t) => {
  const { platform, ready, advance, store } = fixture(t);
  ready();
  platform.addJob('mercadolivre', 'product', { productUrl: url(1) });
  platform.addJob('mercadolivre', 'product', { productUrl: url(2) });
  platform.claimJob();
  advance(181000);
  assert.equal(platform.claimJob().payload.productUrl, url(2));
  assert.equal(connection(platform).state, 'ready');
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM browser_jobs WHERE state='failed'").get().n,
    1,
  );
});

test('gerador afiliado falhando 3 vezes seguidas suspende; um sucesso zera a contagem', (t) => {
  const { platform, ready, observation } = fixture(t);
  ready();
  const fail = (n) => {
    platform.addJob('mercadolivre', 'product', { productUrl: url(n) });
    const job = platform.claimJob();
    platform.completeJob(job.id, {
      error: 'Gerador não encontrado',
      code: 'affiliate_tool_missing',
      steps: [{ name: 'open_affiliate', ok: false, ms: 12000, code: 'affiliate_tool_missing' }],
    });
  };
  fail(1);
  fail(2);
  platform.addJob('mercadolivre', 'product', { productUrl: url(3) });
  const success = platform.claimJob();
  platform.completeJob(success.id, { observation: observation(3) });
  fail(4);
  fail(5);
  assert.equal(connection(platform).state, 'ready');
  fail(6);
  assert.equal(connection(platform).state, 'attention');
  assert.match(connection(platform).last_error, /3 produtos seguidos/);
});

test('conta deslogada suspende e o ciclo seguinte testa sozinho até recuperar', (t) => {
  const { platform, ready, observation, store, advance } = fixture(t);
  ready();
  platform.saveGroup({ id: '123@g.us' }, [{ id: '123@g.us', name: 'Casa' }]);
  platform.saveTopic({
    name: 'Casa',
    keywords: ['cafeteira'],
    stores: ['mercadolivre'],
    groupIds: ['123@g.us'],
  });
  platform.addJob('mercadolivre', 'product', { productUrl: url(1) });
  let job = platform.claimJob();
  platform.completeJob(job.id, { observation: observation(1) });
  platform.addJob('mercadolivre', 'product', { productUrl: url(2) });
  job = platform.claimJob();
  platform.completeJob(job.id, { error: 'Entre na sua conta', code: 'store_login_required' });
  assert.equal(connection(platform).state, 'attention');
  platform.tick(true);
  const probe = platform.claimJob();
  assert.equal(probe.kind, 'validate');
  assert.equal(probe.payload.productUrl, url(1));
  assert.ok(Date.parse(store.setting('next_search_at')) > START);
  platform.tick();
  assert.equal(platform.claimJob(), null, 'um único teste por ciclo');
  advance(1000);
  platform.completeJob(probe.id, { observation: observation(1) });
  assert.equal(connection(platform).state, 'ready');
});

test('Testar agora faz busca e produto de ponta a ponta e relata cada etapa', (t) => {
  const { platform, store, observation } = fixture(t);
  store.setSetting('search_enabled', 'false');
  assert.throws(() => platform.startDiagnostic(), /capture_browser_required/);
  platform.claimJob(); // the extension polling marks the bridge as connected
  assert.equal(platform.startDiagnostic().state, 'running');
  const search = platform.claimJob();
  assert.equal(search.kind, 'search');
  platform.completeJob(search.id, {
    urls: [url(1)],
    steps: [
      { name: 'open_page', ok: true, ms: 900 },
      { name: 'read_search', ok: true, ms: 400 },
    ],
  });
  const product = platform.claimJob();
  assert.equal(product.kind, 'validate');
  platform.completeJob(product.id, {
    observation: observation(1),
    steps: [
      { name: 'open_page', ok: true, ms: 800 },
      { name: 'read_product', ok: true, ms: 300 },
      { name: 'open_affiliate', ok: true, ms: 200 },
      { name: 'read_affiliate', ok: true, ms: 1200 },
    ],
  });
  const report = platform.diagnostic();
  assert.equal(report.state, 'passed');
  assert.equal(report.steps.length, 6);
  assert.equal(connection(platform).state, 'ready');
});

test('Testar agora informa a etapa que falhou', (t) => {
  const { platform } = fixture(t);
  platform.claimJob();
  platform.startDiagnostic();
  const search = platform.claimJob();
  platform.completeJob(search.id, { urls: [url(1)] });
  const product = platform.claimJob();
  platform.completeJob(product.id, {
    error: 'A ferramenta afiliada não está visível.',
    code: 'affiliate_tool_missing',
    steps: [
      { name: 'read_product', ok: true, ms: 300 },
      { name: 'open_affiliate', ok: false, ms: 12000, detail: 'não visível' },
    ],
  });
  const report = platform.diagnostic();
  assert.equal(report.state, 'failed');
  assert.match(report.error, /afiliada/);
  assert.equal(report.steps.at(-1).name, 'open_affiliate');
});
