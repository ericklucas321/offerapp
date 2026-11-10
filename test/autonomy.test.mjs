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

test('modo por grupo: um controle define revisão ou automático e grupos podem ser removidos', (t) => {
  const { platform, store } = fixture(t);
  const known = [
    { id: '123@g.us', name: 'Casa' },
    { id: '456@g.us', name: 'Achados' },
  ];
  platform.saveGroup({ id: '123@g.us', mode: 'automatic' }, known);
  platform.saveGroup({ id: '456@g.us', mode: 'review' }, known);
  platform.saveTopic({ name: 'Casa', keywords: ['cafeteira'], stores: ['mercadolivre'] });
  assert.deepEqual(platform.topics()[0].groupIds, []);
  platform.setOperation(true);
  assert.equal(store.setting('automatic_enabled'), 'true');
  assert.deepEqual(JSON.parse(store.setting('automatic_groups')), ['123@g.us']);
  assert.equal(store.setting('publication_paused'), 'false');
  assert.equal(platform.status().searchEnabled, true);
  platform.saveGroup({ id: '123@g.us', mode: 'off' }, known);
  assert.equal(platform.groups().find((g) => g.id === '123@g.us').enabled, 0);
  assert.equal(store.setting('automatic_enabled'), 'false');
  platform.deleteGroup('456@g.us');
  assert.equal(platform.groups().length, 1);
  platform.setOperation(false);
  assert.equal(store.setting('search_enabled'), 'false');
  assert.equal(store.setting('publication_paused'), 'true');
  platform.deleteTopic(platform.topics()[0].id);
  assert.equal(platform.topics().length, 0);
});

test('migração 4 converte grupos ligados, grupos do automático e desligados', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-mig4-'));
  const store = new Store({ dataDir: dir });
  store.db.exec(`DELETE FROM schema_migrations WHERE version=4;
    CREATE TABLE groups_old AS SELECT id,name,enabled,start_minute,end_minute,interval_minutes,revision FROM destination_groups;
    DROP TABLE destination_groups;
    ALTER TABLE groups_old RENAME TO destination_groups;
    INSERT INTO destination_groups VALUES('1@g.us','A',1,480,1320,60,1),('2@g.us','B',1,480,1320,60,1),('3@g.us','C',0,480,1320,60,1);
    INSERT INTO topics(name,keywords,stores,group_ids) VALUES('T','["x"]','["mercadolivre"]','["1@g.us"]');`);
  store.setSetting('automatic_groups', '["1@g.us"]');
  store.close();
  const migrated = new Store({ dataDir: dir });
  t.after(() => migrated.close());
  assert.deepEqual(
    migrated.db
      .prepare('SELECT id,mode FROM destination_groups ORDER BY id')
      .all()
      .map((g) => [g.id, g.mode]),
    [
      ['1@g.us', 'automatic'],
      ['2@g.us', 'review'],
      ['3@g.us', 'off'],
    ],
  );
  assert.equal(migrated.db.prepare('SELECT group_ids FROM topics').get().group_ids, '[]');
});

test('Testar agora e testes de recuperação não criam ofertas na lista', (t) => {
  const { platform, store, observation } = fixture(t);
  platform.claimJob();
  platform.startDiagnostic();
  const search = platform.claimJob();
  platform.completeJob(search.id, { urls: [url(1)] });
  const product = platform.claimJob();
  platform.completeJob(product.id, { observation: observation(1) });
  assert.equal(platform.diagnostic().state, 'passed');
  assert.equal(store.listOffers().length, 0);
});

test('resultado que chega depois do tempo esgotado é ignorado sem erro', (t) => {
  const { platform, ready, advance, observation } = fixture(t);
  ready();
  platform.addJob('mercadolivre', 'product', { productUrl: url(1) });
  const job = platform.claimJob();
  advance(181000);
  platform.claimJob();
  assert.doesNotThrow(() => platform.completeJob(job.id, { observation: observation(1) }));
});
