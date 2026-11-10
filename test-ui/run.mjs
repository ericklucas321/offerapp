// End-to-end UI test of the three screens against the real server and a temporary database.
// The WhatsApp publisher is fake and every request outside the local server is blocked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './playwright-runtime.mjs';
import { startFixture } from './fixture.mjs';
import { CAPTURE_PROTOCOL, captureItem } from '../src/shared/capture-contract.mjs';

const evidence = path.resolve('test-ui/evidence');
fs.mkdirSync(evidence, { recursive: true });
const fixture = await startFixture();
const browser = await launchBrowser();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  timezoneId: 'America/Sao_Paulo',
});
const externalRequests = [],
  pageErrors = [],
  results = [];
await context.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith(fixture.base)) return route.continue();
  externalRequests.push(url);
  return route.abort();
});
const page = await context.newPage();
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('dialog', (dialog) => dialog.accept());
async function scenario(name, fn) {
  try {
    await fn();
    results.push({ name, status: 'passed' });
  } catch (error) {
    results.push({ name, status: 'failed', error: error.message });
    await page.screenshot({ path: path.join(evidence, `failed-${results.length}.png`) });
  }
}
const extensionSeen = () => fixture.store.setSetting('bridge_last_seen', String(Date.now()));

try {
  await page.goto(fixture.base);

  await scenario('Três telas e guia de configuração com o interruptor bloqueado', async () => {
    await page.getByRole('switch').waitFor();
    assert.equal(await page.locator('nav button').count(), 3);
    await page.locator('#setupSteps').waitFor();
    assert.match(await page.locator('#setupSteps').innerText(), /extensão/);
    assert.equal(await page.getByRole('switch').isDisabled(), true);
    for (const name of ['Canais', 'Configurar', 'Ofertas']) {
      await page.getByRole('button', { name, exact: true }).click();
      await page.getByRole('button', { name, exact: true, pressed: undefined }).waitFor();
    }
  });

  await scenario(
    'Canais: WhatsApp com reconectar e desconectar, grupo adicionado e automático',
    async () => {
      await page.getByRole('button', { name: 'Canais', exact: true }).click();
      await page.locator('#waBadge', { hasText: 'Conectado' }).waitFor();
      assert.equal(await page.locator('#waConnect').isVisible(), false);
      assert.equal(await page.locator('#waQr').isVisible(), false);
      assert.equal(await page.locator('#waReconnect').isVisible(), true);
      assert.equal(await page.locator('#waLogout').isVisible(), true);
      await page.getByRole('button', { name: 'Buscar grupos do WhatsApp' }).click();
      await page.getByRole('button', { name: 'Adicionar' }).click();
      await page.locator('[data-group] select[name="mode"]').waitFor();
      await page.locator('[data-group] select[name="mode"]').selectOption('automatic');
      await page.locator('[data-group] button[type="submit"]').click();
      await page.locator('#toast', { hasText: 'Grupo salvo' }).waitFor();
      assert.equal(fixture.platform.groups()[0].mode, 'automatic');
    },
  );

  await scenario('Configurar: tema criado, editado e validado no formulário', async () => {
    await page.getByRole('button', { name: 'Configurar', exact: true }).click();
    await page.getByRole('button', { name: 'Salvar tema' }).click();
    await page.locator('#topicError', { hasText: 'nome' }).waitFor();
    await page.getByLabel('Nome').fill('Casa');
    await page.getByLabel(/Palavras-chave/).fill('cafeteira, air fryer');
    await page.getByLabel(/Preço máximo/).fill('300');
    await page.getByRole('button', { name: 'Salvar tema' }).click();
    await page.locator('#topicRows', { hasText: 'cafeteira, air fryer' }).waitFor();
    await page.getByRole('button', { name: 'Editar' }).click();
    assert.equal(await page.getByLabel('Nome').inputValue(), 'Casa');
    await page.getByLabel('Nome').fill('Cozinha');
    await page.getByRole('button', { name: 'Salvar tema' }).click();
    await page.locator('#topicRows', { hasText: 'Cozinha' }).waitFor();
    assert.equal(fixture.platform.topics().length, 1);
  });

  await scenario(
    'Configurar: Testar agora exige a extensão e depois mostra as etapas',
    async () => {
      await page.getByRole('button', { name: 'Testar agora' }).click();
      await page.locator('#toast.error', { hasText: /extensão/i }).waitFor();
      extensionSeen();
      await page.getByRole('button', { name: 'Testar agora' }).click();
      await page.locator('#testSteps', { hasText: 'Em andamento' }).waitFor();
      const search = fixture.platform.claimJob();
      fixture.platform.completeJob(search.id, {
        urls: [],
        steps: [
          { name: 'open_page', ok: true, ms: 800 },
          { name: 'read_search', ok: true, ms: 300 },
        ],
      });
      await page.locator('#testSteps', { hasText: 'Ler resultados da busca' }).waitFor();
      await page.locator('#testSteps', { hasText: 'não encontrou produtos' }).waitFor();
    },
  );

  await scenario(
    'Ofertas: interruptor liga após a configuração e enviar coloca na fila',
    async () => {
      extensionSeen();
      fixture.store.db
        .prepare("UPDATE store_connections SET state='ready' WHERE marketplace='mercadolivre'")
        .run();
      const offer = fixture.offers.manual({
        title: 'Cafeteira de teste',
        price: 199.9,
        productUrl: 'https://produto.mercadolivre.com.br/MLB-123456789-cafeteira',
        affiliateUrl: 'https://meli.la/teste',
        affiliateConfirmed: true,
        availableConfirmed: true,
      });
      await page.getByRole('button', { name: 'Ofertas', exact: true }).click();
      await page.locator('#offerRows', { hasText: 'Cafeteira de teste' }).waitFor();
      await page.waitForFunction(() => !document.querySelector('#operationSwitch').disabled);
      await page.getByRole('switch').click();
      await page.locator('#operationLabel', { hasText: 'Ligado' }).waitFor();
      assert.equal(fixture.store.setting('search_enabled'), 'true');
      assert.equal(fixture.store.setting('automatic_enabled'), 'true');
      await page.locator(`[data-send="${offer.id}"]`).click();
      await page.locator('#sendDialog[open]').waitFor();
      assert.match(await page.locator('#sendBody').innerText(), /Grupo de teste local/);
      await page.getByRole('button', { name: 'Confirmar envio' }).click();
      await page.locator('#toast', { hasText: 'na fila' }).waitFor();
      await page.getByRole('tab', { name: 'Envios' }).click();
      await page.locator('#deliveryRows', { hasText: 'Na fila' }).waitFor();
      assert.equal(await page.locator('#moreDeliveries').isVisible(), false);
      await page.getByRole('switch').click();
      await page.locator('#operationLabel', { hasText: 'Desligado' }).waitFor();
      assert.equal(fixture.store.setting('publication_paused'), 'true');
    },
  );

  await scenario(
    'Captura enviada pela extensão abre a conferência e entra nas ofertas',
    async () => {
      const packet = {
        version: CAPTURE_PROTOCOL.version,
        items: [
          captureItem(
            {
              productKey: 'MLB987654321',
              title: 'Air fryer capturada',
              productUrl: 'https://produto.mercadolivre.com.br/MLB-987654321-air-fryer',
              imageUrl: '',
              priceCents: 29900,
              available: false,
              observedAt: new Date().toISOString(),
              priceCondition: 'Preço à vista anunciado',
            },
            'card',
          ),
        ],
      };
      await page.goto(
        `${fixture.base}/#browser-capture=${encodeURIComponent(JSON.stringify(packet))}`,
      );
      await page.locator('#captureDialog[open]').waitFor();
      assert.match(await page.locator('#capturePreview').innerText(), /Air fryer capturada/);
      await page.getByRole('button', { name: 'Adicionar às ofertas' }).click();
      await page.locator('#offerRows', { hasText: 'Air fryer capturada' }).waitFor();
    },
  );

  await scenario('Telas cabem em 375, 768 e 1440 px sem rolagem horizontal', async () => {
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ['Ofertas', 'Canais', 'Configurar']) {
        await page.getByRole('button', { name, exact: true }).click();
        await page.waitForTimeout(150);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        assert.ok(overflow <= 0, `${name} em ${width}px rola ${overflow}px na horizontal`);
        const small = await page.evaluate(
          () =>
            [...document.querySelectorAll('nav button')].filter(
              (b) => b.getBoundingClientRect().height < 44,
            ).length,
        );
        assert.equal(small, 0, `botões de navegação menores que 44px em ${width}px`);
        await page.screenshot({
          path: path.join(evidence, `${name.toLowerCase()}-${width}.png`),
          fullPage: true,
        });
      }
    }
  });

  await scenario('Sem erros de JavaScript nem requisições externas', async () => {
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);
  });
} finally {
  await browser.close();
  await fixture.close();
}
fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
if (results.some((r) => r.status !== 'passed')) process.exit(1);
