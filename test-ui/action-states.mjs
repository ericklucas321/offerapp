import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPlaywright } from './playwright-runtime.mjs';
import { startFixture } from './fixture.mjs';
const { chromium } = await loadPlaywright();
const fixture = await startFixture();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const results = [],
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await context.route('**/*', (route) =>
  route.request().url().startsWith(fixture.base) ? route.continue() : route.abort(),
);
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, status: 'passed' });
  } catch (e) {
    results.push({ name, status: 'failed', error: e.message });
  }
};
const connections = async () => {
  await page.goto(fixture.base);
  await page.locator('[data-section=settings]').click();
};
const heartbeat = () => fixture.store.setSetting('bridge_last_seen', String(Date.now()));
try {
  await check('Conexão concluída não oferece pareamento nem reconexão WhatsApp', async () => {
    heartbeat();
    await connections();
    assert.equal(await page.locator('#pairExtension').isDisabled(), true);
    assert.match(await page.locator('#pairExtension').innerText(), /conectada/i);
    assert.equal(await page.locator('#connectWa').isDisabled(), true);
    await page.reload();
    await page.locator('[data-section=settings]').click();
    assert.equal(await page.locator('#pairExtension').isDisabled(), true);
    fixture.store.setSetting('bridge_last_seen', '0');
    await page.reload();
    await page.locator('[data-section=settings]').click();
    assert.equal(await page.locator('#pairExtension').isEnabled(), true);
    assert.equal(
      await page.locator('[data-validate-store=mercadolivre] button').isDisabled(),
      true,
    );
  });
  await check('Validação pendente permanece bloqueada e termina em revalidação', async () => {
    heartbeat();
    await connections();
    const form = page.locator('[data-validate-store=mercadolivre]');
    await form.locator('input').fill('https://www.mercadolivre.com.br/produto/p/MLB123456789');
    await form.locator('button').click();
    await page.locator('#state-mercadolivre').filter({ hasText: 'Validando' }).waitFor();
    assert.equal(await form.locator('button').isDisabled(), true);
    fixture.store
      .prepare("UPDATE store_connections SET state='ready' WHERE marketplace='mercadolivre'")
      .run();
    await page.reload();
    await page.locator('[data-section=settings]').click();
    assert.match(await form.locator('button').innerText(), /Revalidar/i);
    assert.equal(await form.locator('button').isEnabled(), true);
  });
  await check('Ação lenta mostra progresso e não é reativada pelo polling', async () => {
    await connections();
    await page.locator('[data-settings-tab=groups]').click();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    await page.route('**/api/whatsapp/groups', async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page.locator('#loadGroups').click();
      await page.locator('#loadGroups[aria-busy=true]').waitFor();
      assert.match(await page.locator('#loadGroups').innerText(), /Carregando/);
      assert.equal(await page.locator('#loadGroups').isDisabled(), true);
      const other = await context.newPage();
      await other.bringToFront();
      const update = page.waitForResponse((response) => response.url().includes('/api/view?'));
      await page.bringToFront();
      await update;
      assert.equal(await page.locator('#loadGroups').isDisabled(), true);
      assert.match(await page.locator('#loadGroups').innerText(), /Carregando/);
      await other.close();
    } finally {
      release();
    }
    await page.locator('#newGroup').waitFor();
    await page.locator('#loadGroups:not([aria-busy])').waitFor();
    assert.match(await page.locator('#loadGroups').innerText(), /Atualizar/);
    await page.unroute('**/api/whatsapp/groups');
  });
  await check('Salvar grupo confirma persistência e edição libera novo salvamento', async () => {
    await page.locator('#newGroup').selectOption('123456789@g.us');
    const form = page.locator('[data-group-form]');
    await form.locator('button').click();
    await page.locator('#toastText').filter({ hasText: 'Grupo salvo' }).waitFor();
    assert.equal(fixture.platform.groups().length, 1);
    assert.match(await form.locator('button').innerText(), /Salvo/);
    assert.equal(await form.locator('button').isDisabled(), true);
    await form.locator('[name=interval]').fill('45');
    assert.equal(await form.locator('button').isEnabled(), true);
  });
  await check('Falha restaura ação e permite repetir sem indicar sucesso', async () => {
    await page.route('**/api/whatsapp/groups', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Falha controlada de conexão' }),
      }),
    );
    await page.locator('#loadGroups').click();
    await page.locator('#toastText').filter({ hasText: 'Falha controlada' }).waitFor();
    assert.equal(await page.locator('#loadGroups').isEnabled(), true);
    assert.equal(await page.locator('#loadGroups').getAttribute('aria-busy'), null);
    assert.doesNotMatch(await page.locator('#loadGroups').innerText(), /Carregando/);
    await page.unroute('**/api/whatsapp/groups');
  });
  await check(
    'Edição durante salvamento continua pendente e não recebe confirmação falsa',
    async () => {
      const form = page.locator('[data-group-form]');
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      await page.route('**/api/platform/groups', async (route) => {
        await gate;
        await route.continue();
      });
      try {
        await form.locator('button').click();
        await form.locator('button[aria-busy=true]').waitFor();
        await form.locator('[name=interval]').fill('30');
      } finally {
        release();
      }
      await form.locator('button:not([aria-busy])').waitFor();
      assert.equal(fixture.platform.groups()[0].interval_minutes, 45);
      assert.equal(await form.locator('[name=interval]').inputValue(), '30');
      assert.equal(await form.locator('button').isEnabled(), true);
      assert.doesNotMatch(await form.locator('button').innerText(), /Salvo/);
      await page.unroute('**/api/platform/groups');
    },
  );
  await check(
    'Estado de QR e conexão WhatsApp acompanha atualização sem recarregar configurações',
    async () => {
      await connections();
      await page.route('**/api/view?*', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.whatsapp = { state: 'qr', qrDataUrl: null };
        await route.fulfill({ json: body });
      });
      // Tab visibility triggers the same refresh used by polling, without rebuilding the forms.
      const other = await context.newPage();
      await other.bringToFront();
      await page.bringToFront();
      await page.locator('#waStatus').filter({ hasText: 'Escaneie' }).waitFor();
      assert.equal(await page.locator('#connectWa').isDisabled(), true);
      assert.match(await page.locator('#connectWa').innerText(), /QR/);
      await other.close();
      await page.unroute('**/api/view?*');
    },
  );
  assert.deepEqual(errors, []);
} finally {
  fs.mkdirSync('test-ui/evidence', { recursive: true });
  fs.writeFileSync(
    'test-ui/evidence/action-states.json',
    JSON.stringify({ results, errors }, null, 2),
  );
  await context.close();
  await browser.close();
  await fixture.close();
}
console.log(JSON.stringify(results, null, 2));
if (results.some((r) => r.status === 'failed')) process.exitCode = 1;
