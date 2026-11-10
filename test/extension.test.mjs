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

test('busca roda em janela minimizada dedicada sem roubar o foco e registra as etapas', async () => {
  const { worker, chromeApi, stats } = workerFixture();
  const windows = [];
  let tabOptions;
  chromeApi.windows = {
    create: async (options) => {
      windows.push(options);
      return { id: 40 };
    },
    get: async (id) => ({ id }),
  };
  chromeApi.tabs.create = async (options) => {
    tabOptions = options;
    return { id: 7 };
  };
  await worker.run();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].state, 'minimized');
  assert.equal(windows[0].focused, false);
  assert.equal(tabOptions.windowId, 40);
  const result = JSON.parse(stats().bodies[0]).result;
  assert.deepEqual(
    result.steps.map((s) => [s.name, s.ok]),
    [
      ['open_page', true],
      ['read_search', true],
    ],
  );
});
test('reinício do service worker reutiliza a mesma janela minimizada', async () => {
  const saved = {};
  let created = 0;
  for (let run = 0; run < 2; run++) {
    const { worker, chromeApi } = workerFixture();
    chromeApi.storage.session = {
      get: async () => ({ ...saved }),
      set: async (value) => Object.assign(saved, value),
    };
    chromeApi.windows = {
      create: async () => ({ id: 40 + ++created }),
      get: async (id) => ({ id }),
    };
    await worker.run();
  }
  assert.equal(created, 1);
  assert.equal(saved.workerWindowId, 41);
});
test('gerador lento restaura a janela sem foco e minimiza de novo ao terminar', async () => {
  const { worker, chromeApi } = workerFixture({
    job: {
      id: 1,
      kind: 'refresh',
      marketplace: 'amazon',
      payload: { productUrl: 'https://www.amazon.com.br/dp/B012345678' },
    },
  });
  const states = [];
  chromeApi.windows = {
    create: async () => ({ id: 40 }),
    get: async (id) => ({ id }),
    update: async (id, options) => states.push(options),
  };
  let reads = 0;
  chromeApi.scripting.executeScript = async ({ func }) => {
    if (func.name === 'readProduct')
      return [{ result: { title: 'P', priceCents: 100, stockStatus: 'available' } }];
    if (func.name === 'clickAffiliate') return [{ result: true }];
    return [{ result: ++reads > 31 ? 'https://amzn.to/abc' : null }];
  };
  await worker.run();
  assert.deepEqual(states, [{ state: 'normal', focused: false }, { state: 'minimized' }]);
});
test('sem API de janelas a busca abre aba inativa', async () => {
  const { worker, chromeApi } = workerFixture();
  let active;
  chromeApi.tabs.create = async (options) => {
    active = options.active;
    return { id: 7 };
  };
  await worker.run();
  assert.equal(active, false);
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
      assert.equal(result.code, 'affiliate_link_timeout');
      assert.deepEqual(result.steps.at(-1).name, 'read_affiliate');
      assert.equal(result.steps.at(-1).ok, false);
      assert.equal(stats().removed, 1);
    }
  }
});
test('extensão: chamadas simultâneas não abrem trabalhos duplicados', async () => {
  const { worker, stats } = workerFixture();
  await Promise.all([worker.run(), worker.run()]);
  assert.equal(stats().created, 1);
});
test('extensão: erro de leitura fecha a aba, informa a falha e a etapa', async () => {
  const { worker, chromeApi, stats } = workerFixture();
  chromeApi.scripting.executeScript = async () => {
    throw new Error('Verificação necessária');
  };
  await worker.run();
  assert.equal(stats().removed, 1);
  const result = JSON.parse(stats().bodies[0]).result;
  assert.match(result.error, /Verificação necessária/);
  assert.equal(result.steps.at(-1).name, 'read_search');
  assert.match(result.steps.at(-1).detail, /Verificação necessária/);
});
test('extensão: barra afiliada ausente e sessão deslogada recebem códigos distintos', (t) => {
  const { element } = documentFixture(t);
  document.querySelector = () => null;
  document.querySelectorAll = () => [];
  assert.equal(clickAffiliate('mercadolivre').code, 'affiliate_tool_missing');
  const login = { ...element('Entre'), href: 'https://www.mercadolivre.com/jms/mlb/lgz/login?x=1' };
  document.querySelectorAll = (s) => (s === 'a[href]' ? [login] : []);
  assert.equal(clickAffiliate('mercadolivre').code, 'store_login_required');
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
  assert.match(readProduct('amazon').error, /benefício não confirmado/);
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
  assert.match(readProduct('amazon').error, /Preço ou variante/);
});
test('links: botão Texto fora da ferramenta afiliada não é acionado e link solto é ignorado', (t) => {
  const { element } = documentFixture(t);
  let clicks = 0;
  const unrelated = element('Texto');
  unrelated.click = () => clicks++;
  document.querySelector = () => null;
  document.querySelectorAll = () => [unrelated];
  assert.match(clickAffiliate('amazon').error, /ferramenta afiliada/);
  assert.equal(clicks, 0);
  document.querySelectorAll = (s) =>
    s.includes('input,textarea') ? [{ ...element(), value: 'https://amzn.to/unrelated' }] : [];
  assert.match(readAffiliate('amazon').error, /link afiliado verificável/);
});
