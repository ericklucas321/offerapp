import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserWorker } from '../extension/browser-worker.js';
import {
  readProduct,
  readAffiliate,
  clickAffiliate,
  findProducts,
} from '../extension/store-adapters.js';

function workerFixture({
  ackLost = false,
  job = { id: 1, kind: 'search', marketplace: 'amazon', payload: { keyword: 'teste' } },
} = {}) {
  let claimed = false,
    reports = 0,
    created = 0,
    removed = 0;
  const bodies = [],
    warnings = [];
  const chromeApi = {
    storage: {
      local: { get: async () => ({ base: 'http://127.0.0.1:3210', token: 'a'.repeat(64) }) },
    },
    tabs: {
      query: async () => [{ id: 2 }],
      update: async () => {},
      create: async () => {
        created++;
        return { id: 7 };
      },
      get: async () => ({ status: 'complete' }),
      remove: async () => {
        removed++;
      },
    },
    scripting: {
      executeScript: async () => [{ result: ['https://www.amazon.com.br/dp/B012345678'] }],
    },
  };
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/jobs')) {
      if (claimed) return { ok: true, json: async () => ({ job: null }) };
      claimed = true;
      return {
        ok: true,
        json: async () => ({
          job,
        }),
      };
    }
    bodies.push(options.body);
    reports++;
    if (ackLost && reports === 1) throw new TypeError('Network response lost');
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const worker = createBrowserWorker({
    chromeApi,
    fetchImpl,
    delay: async () => {},
    logger: { warn: (...v) => warnings.push(v) },
  });
  return { worker, chromeApi, stats: () => ({ reports, created, removed, bodies, warnings }) };
}

test('busca aguarda resultados renderizados e preserva o motivo da verificação', async () => {
  const { worker, chromeApi, stats } = workerFixture();
  let attempts = 0;
  chromeApi.scripting.executeScript = async () => [
    { result: ++attempts < 4 ? null : ['https://www.amazon.com.br/dp/B012345678'] },
  ];
  await worker.run();
  assert.equal(attempts, 4);
  assert.deepEqual(JSON.parse(stats().bodies[0]).result.urls, [
    'https://www.amazon.com.br/dp/B012345678',
  ]);
  const blocked = workerFixture();
  blocked.chromeApi.scripting.executeScript = async () => [
    { result: { error: 'A loja pediu uma verificação.', code: 'store_verification_required' } },
  ];
  await blocked.worker.run();
  assert.match(JSON.parse(blocked.stats().bodies[0]).result.error, /verificação/);
  assert.equal(JSON.parse(blocked.stats().bodies[0]).result.code, 'store_verification_required');
});

test('busca abre aba ativa para renderização da loja e restaura a aba anterior', async () => {
  const { worker, chromeApi } = workerFixture();
  let active, restored;
  chromeApi.tabs.create = async (options) => {
    active = options.active;
    return { id: 7 };
  };
  chromeApi.tabs.update = async (id, options) => {
    if (options.active) restored = id;
  };
  await worker.run();
  assert.equal(active, true);
  assert.equal(restored, 2);
});

test('leitura da busca distingue carregamento, verificação, vazio e resultados com anúncio selecionado', (t) => {
  const original = globalThis.document;
  t.after(() => {
    globalThis.document = original;
  });
  const body = { innerText: '' };
  let links = [];
  globalThis.document = { body, querySelectorAll: () => links };
  assert.equal(findProducts('mercadolivre'), null);
  body.innerText = 'Verifique que você é humano';
  assert.equal(findProducts('mercadolivre').code, 'store_verification_required');
  body.innerText = 'Não encontramos resultados';
  assert.deepEqual(findProducts('mercadolivre'), []);
  body.innerText = 'Resultados';
  links = [
    { href: 'https://www.mercadolivre.com.br/cafeteira/p/MLB1234567#pos=1&wid=MLB987654321' },
  ];
  const result = findProducts('mercadolivre');
  assert.equal(new URL(result[0]).searchParams.get('wid'), 'MLB987654321');
  assert.equal(new URL(result[0]).hash, '');
});
test('extensão aguarda dados e barra afiliada carregados sem registrar preço vazio como falha', async () => {
  const url = 'https://produto.mercadolivre.com.br/MLB-123456789-fixture';
  const { worker, chromeApi, stats } = workerFixture({
    job: { id: 1, kind: 'validate', marketplace: 'mercadolivre', payload: { productUrl: url } },
  });
  let reads = 0,
    clicks = 0,
    linkReads = 0;
  chromeApi.scripting.executeScript = async ({ func }) => {
    if (func.name === 'extractMarketDocument')
      return [
        {
          result: {
            url,
            schemas: [],
            identityIds: [],
            title: 'Produto',
            prices:
              ++reads === 1
                ? []
                : [
                    {
                      fraction: '118',
                      cents: '99',
                      currency: 'R$',
                      kind: 'total',
                      condition: 'Preço anunciado',
                      context: '',
                    },
                  ],
            variants: [],
            stock: true,
            buyEnabled: true,
          },
        },
      ];
    if (func.name === 'clickAffiliate') {
      if (++clicks === 1) return [{ result: null }];
      return [{ result: true }];
    }
    return [{ result: ++linkReads <= 12 ? null : 'https://meli.la/fixture' }];
  };
  await worker.run();
  const result = JSON.parse(stats().bodies[0]).result;
  assert.equal(result.observation.priceCents, 11899);
  assert.equal(result.observation.affiliateUrl, 'https://meli.la/fixture');
  assert.equal(stats().removed, 1);
});
test('extensão: resposta perdida repete o mesmo resultado, sem convertê-lo em falha', async () => {
  const { worker, stats } = workerFixture({ ackLost: true });
  await worker.run();
  const result = stats();
  assert.equal(result.reports, 2);
  assert.equal(result.bodies[0], result.bodies[1]);
  assert.equal(result.removed, 1);
  assert.equal(result.warnings.length, 0);
});

test('extensão reabre uma única vez o gerador travado e mantém o limite quando a loja não responde', async () => {
  for (const recovers of [true, false]) {
    const { worker, chromeApi, stats } = workerFixture({
      job: {
        id: 1,
        kind: 'refresh',
        marketplace: 'mercadolivre',
        payload: { productUrl: 'https://produto.mercadolivre.com.br/MLB-123456789-fixture' },
      },
    });
    let opens = 0,
      closes = 0;
    chromeApi.scripting.executeScript = async ({ func }) => {
      if (func.name === 'extractMarketDocument')
        return [
          {
            result: {
              url: 'https://produto.mercadolivre.com.br/MLB-123456789-fixture',
              schemas: [],
              identityIds: [],
              title: 'Produto',
              prices: [
                {
                  fraction: '118',
                  cents: '99',
                  currency: 'R$',
                  kind: 'total',
                  condition: 'Preço anunciado',
                  context: '',
                },
              ],
              variants: [],
              stock: true,
              buyEnabled: true,
            },
          },
        ];
      if (func.name === 'clickAffiliate') {
        opens++;
        return [{ result: true }];
      }
      if (func.name === 'closeAffiliate') {
        closes++;
        return [{ result: true }];
      }
      return [{ result: recovers && opens === 2 ? 'https://meli.la/fixture' : null }];
    };
    await worker.run();
    const result = JSON.parse(stats().bodies[0]).result;
    assert.equal(opens, 2);
    assert.equal(closes, 1);
    if (recovers) {
      assert.equal(result.observation.affiliateUrl, 'https://meli.la/fixture');
      assert.equal(stats().removed, 1);
    } else {
      assert.match(result.error, /30 segundos/);
      assert.equal(stats().removed, 0);
    }
  }
});
test('extensão: chamadas simultâneas não abrem trabalhos duplicados', async () => {
  const { worker, stats } = workerFixture();
  await Promise.all([worker.run(), worker.run()]);
  assert.equal(stats().created, 1);
});
test('extensão: erro de leitura mantém somente sua aba para conferência e informa a falha', async () => {
  const { worker, chromeApi, stats } = workerFixture();
  chromeApi.scripting.executeScript = async () => {
    throw new Error('Verificação necessária');
  };
  await worker.run();
  assert.equal(stats().removed, 0);
  assert.match(stats().bodies[0], /Verificação necessária/);
});

function documentFixture(
  t,
  { schema, price = 'R$ 100,00', stock = 'Em estoque', hiddenBuy = false } = {},
) {
  const old = {
    document: globalThis.document,
    location: globalThis.location,
    getComputedStyle: globalThis.getComputedStyle,
  };
  const element = (textContent = '', hidden = false) => ({
    textContent,
    innerText: textContent,
    disabled: false,
    getBoundingClientRect: () => ({ width: 100, height: 30 }),
    closest: () => (hidden ? {} : null),
    querySelectorAll: () => [],
  });
  const buy = element('Adicionar ao carrinho', hiddenBuy);
  globalThis.location = { href: 'https://www.amazon.com.br/dp/B012345678' };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  globalThis.document = {
    body: { innerText: 'Produto disponível' },
    querySelector: (s) =>
      s === 'main'
        ? { innerText: 'Produto disponível', querySelectorAll: () => [buy] }
        : s === '#productTitle'
          ? element('Produto')
          : s.includes('corePrice')
            ? element(price)
            : s === '#availability'
              ? element(stock)
              : s.includes('add-to-cart-button')
                ? buy
                : null,
    querySelectorAll: (s) =>
      s === 'script[type="application/ld+json"]' && schema
        ? [{ textContent: JSON.stringify(schema) }]
        : [],
  };
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return { element };
}
test('leitura: estoque exige botão de compra visível e preço condicionado não é presumido', (t) => {
  documentFixture(t, { hiddenBuy: true });
  assert.equal(readProduct('amazon').stockStatus, 'unknown');
});
test('leitura: cupom no bloco de preço exige conferência', (t) => {
  documentFixture(t, { price: 'R$ 100,00 com cupom' });
  assert.throws(() => readProduct('amazon'), /benefício não confirmado/);
});
test('leitura: schema de outro produto não substitui preço e estoque da página', (t) => {
  documentFixture(t, {
    price: '',
    stock: '',
    schema: {
      '@type': 'Product',
      name: 'Outro produto',
      url: 'https://www.amazon.com.br/dp/B999999999',
      offers: {
        '@type': 'Offer',
        price: '1.00',
        priceCurrency: 'BRL',
        availability: 'https://schema.org/InStock',
      },
    },
  });
  assert.throws(() => readProduct('amazon'), /Preço ou variante/);
});
test('links: botão Texto fora da ferramenta afiliada não é acionado e link solto é ignorado', (t) => {
  const { element } = documentFixture(t);
  let clicks = 0;
  const unrelated = element('Texto');
  unrelated.click = () => clicks++;
  document.querySelector = () => null;
  document.querySelectorAll = () => [unrelated];
  assert.throws(() => clickAffiliate('amazon'), /ferramenta afiliada/);
  assert.equal(clicks, 0);
  document.querySelectorAll = (s) =>
    s.includes('input,textarea') ? [{ ...element(), value: 'https://amzn.to/unrelated' }] : [];
  assert.throws(() => readAffiliate('amazon'), /link afiliado verificável/);
});
