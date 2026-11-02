import assert from 'node:assert/strict';
import { loadPlaywright } from './playwright-runtime.mjs';
import { startFixture } from './fixture.mjs';
const { chromium } = await loadPlaywright();
const fixture = await startFixture();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext();
await context.route('**/*', (route) =>
  route.request().url().startsWith(fixture.base) ? route.continue() : route.abort(),
);
const page = await context.newPage();
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, status: 'passed' });
  } catch (error) {
    results.push({ name, status: 'failed', error: error.message });
  }
};
const refresh = async () => {
  const response = page.waitForResponse((r) => r.url().includes('/api/view?'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await (await response).finished();
};
try {
  await check('Latest poll removes an obsolete pending offers snapshot', async () => {
    let title = 'Original';
    await page.route('**/api/view?*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.items = [
        {
          id: 1,
          title,
          marketplace: 'mercadolivre',
          priceCents: 1000,
          ready: true,
          suggestedGroups: ['fixture@g.us'],
        },
      ];
      await route.fulfill({ json: body });
    });
    await page.goto(fixture.base);
    await page.locator('[data-select="1"]').check();
    title = 'Obsolete';
    await refresh();
    await page.locator('#newSuggestions').waitFor({ state: 'visible' });
    title = 'Original';
    await refresh();
    await page.locator('#newSuggestions').waitFor({ state: 'hidden', timeout: 1500 });
    await page.unroute('**/api/view?*');
  });
  await check(
    'Completing a group load after switching tabs does not report a failure',
    async () => {
      await page.goto(fixture.base);
      await page.locator('[data-section=settings]').click();
      await page.locator('[data-settings-tab=groups]').click();
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      await page.route('**/api/whatsapp/groups', async (route) => {
        await gate;
        await route.continue();
      });
      await page.locator('#loadGroups').click();
      await page.locator('#loadGroups[aria-busy=true]').waitFor();
      const button = await page.locator('#loadGroups').elementHandle();
      await page.locator('[data-settings-tab=topics]').click();
      const response = page.waitForResponse((r) => r.url().endsWith('/api/whatsapp/groups'));
      release();
      await (await response).finished();
      // The request callback and act() cleanup must finish before checking the toast.
      await page.waitForFunction((element) => !element.hasAttribute('aria-busy'), button);
      assert.equal(await page.locator('#toast.error:not([hidden])').count(), 0);
      assert.equal(await page.locator('#topicForm').isVisible(), true);
      await page.unroute('**/api/whatsapp/groups');
    },
  );
  await check('Saving an earlier offer does not replace a newly opened draft', async () => {
    await page.unroute('**/api/view?*');
    await page.goto(fixture.base);
    await page.locator('#newManual').click();
    const form = page.locator('#detailForm');
    await form
      .locator('[name=productUrl]')
      .fill('https://produto.mercadolivre.com.br/MLB-123456789-teste');
    await form.locator('[name=title]').fill('Saved offer');
    await form.locator('[name=price]').fill('149,90');
    await form.locator('[name=affiliateUrl]').fill('https://meli.la/oferta-local');
    await form.locator('[name=affiliateConfirmed]').check();
    await form.locator('[name=availableConfirmed]').check();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    await page.route('**/api/offers', async (route) => {
      await gate;
      await route.continue();
    });
    await form.locator('button[type=submit]').click();
    const button = await form.locator('button[aria-busy=true]').elementHandle();
    await page.locator('[data-close=detailDialog]').click();
    await page.locator('#newManual').click();
    await form.locator('[name=title]').fill('New unsaved draft');
    release();
    await page.waitForFunction((element) => !element.hasAttribute('aria-busy'), button);
    assert.equal(await form.locator('[name=title]').inputValue(), 'New unsaved draft');
    await page.unroute('**/api/offers');
  });
  await check('Connection polling and validation preserve the entered product URL', async () => {
    await page.unroute('**/api/view?*');
    await page.route('**/api/view?*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.platform.bridgeConnected = true;
      body.platform.connections = [
        {
          marketplace: 'mercadolivre',
          state: 'attention',
          last_error: 'Produto de teste não validado',
        },
      ];
      await route.fulfill({ json: body });
    });
    await page.route('**/api/platform/validate', (route) =>
      route.fulfill({
        status: 202,
        json: { ok: true, jobId: 1 },
      }),
    );
    await page.goto(fixture.base);
    await page.locator('[data-section=settings]').click();
    await page.locator('[data-settings-tab=connections]').click();
    const form = page.locator('[data-validate-store=mercadolivre]');
    const url = 'https://www.mercadolivre.com.br/produto/p/MLB123456789';
    await form.locator('input').fill(url);
    await refresh();
    assert.equal(await form.locator('input').inputValue(), url);
    await form.locator('button').click();
    await form.locator('button:not([aria-busy])').waitFor();
    assert.equal(await form.locator('input').inputValue(), url);
  });
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
console.log(JSON.stringify(results, null, 2));
if (results.some((r) => r.status === 'failed')) process.exitCode = 1;
