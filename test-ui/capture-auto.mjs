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
page.setDefaultTimeout(5000);
const capture = {
  stage: 'card',
  captureId: 51,
  title: 'Produto da vitrine',
  marketplace: 'mercadolivre',
  priceCents: 14990,
  productUrl: 'https://www.mercadolivre.com.br/p/MLB123456789',
  ready: false,
  reason: 'Aguardando validação',
  canPrepare: false,
};
const offer = {
  ...capture,
  captureId: null,
  id: 91,
  source: 'browser',
  ready: true,
  affiliateUrl: 'https://meli.la/validado',
  suggestedGroups: ['fixture@g.us'],
  eligibleGroups: ['fixture@g.us'],
};
let state = 'idle',
  resolved = false,
  connected = true,
  needsRefresh = false,
  posts = 0;
await page.route('**/api/view?*', async (route) => {
  const response = await route.fetch();
  const body = await response.json();
  body.items = [resolved ? offer : capture];
  body.platform.bridgeConnected = connected;
  body.platform.groups = [{ id: 'fixture@g.us', name: 'Grupo local', enabled: true }];
  await route.fulfill({ json: body });
});
await page.route('**/api/captures/51/resolve', (route) => {
  posts++;
  state = 'running';
  return route.fulfill({ status: 202, json: { ok: true, jobId: posts } });
});
await page.route('**/api/captures/51/resolution', (route) =>
  route.fulfill({
    json: {
      ok: true,
      jobId: posts || null,
      state,
      error: state === 'failed' ? 'Loja indisponível. Tente novamente.' : null,
      offerId: state === 'done' ? 91 : null,
      needsRefresh,
      refreshReason: needsRefresh ? 'Validação vencida. Confira o produto novamente.' : '',
    },
  }),
);
await page.route('**/api/offers/91/preview', (route) =>
  route.fulfill({ json: { offer, message: 'Produto validado https://meli.la/validado' } }),
);
const openCapture = async () => {
  await page.locator('[data-detail="capture:51"]').click();
  await page.locator('#resolveCapture').waitFor();
};
const startResolution = async () => {
  const posted = page.waitForResponse((response) => response.url().endsWith('/51/resolve'));
  await page.locator('#resolveCapture:enabled').click();
  await (await posted).finished();
};
try {
  // Catches the missing automatic path and shelf fields presented as confirmed data.
  await page.goto(fixture.base);
  await openCapture();
  assert.equal(await page.locator('#detailContent [name=affiliateUrl]').count(), 0);
  assert.equal(await page.locator('#detailContent [name=affiliateConfirmed]').count(), 0);
  assert.match(await page.locator('#detailContent').innerText(), /vitrine.*não confirmados/is);
  await startResolution();
  await page.locator('#resolveCapture[aria-busy=true]').waitFor();
  state = 'done';
  resolved = true;
  await page.locator('#detailForm [name=affiliateUrl]').waitFor();
  assert.equal(await page.locator('[name=affiliateUrl]').inputValue(), offer.affiliateUrl);
  assert.equal(await page.locator('[name=affiliateUrl]').getAttribute('readonly'), '');
  await page.locator('#selectDetail:enabled').waitFor();
  assert.match(await page.locator('#detailDestinations').innerText(), /Grupo local/);
  assert.equal(posts, 1);

  // Catches a stuck failure button, duplicate submission on reopen, and stale completion.
  state = 'idle';
  resolved = false;
  await page.goto(fixture.base);
  await openCapture();
  await startResolution();
  state = 'failed';
  await page.locator('#resolveCapture:enabled').waitFor();
  assert.match(await page.locator('#captureResolutionStatus').innerText(), /Loja indisponível/);
  await startResolution();
  await page.locator('[data-close=detailDialog]').click();
  await openCapture();
  await page.locator('#resolveCapture[aria-busy=true]').waitFor();
  assert.equal(posts, 3);
  await page.locator('[data-close=detailDialog]').click();
  await page.locator('#newManual').click();
  await page.locator('[name=title]').fill('Novo rascunho preservado');
  state = 'done';
  resolved = true;
  await page.waitForTimeout(2300);
  assert.equal(await page.locator('[name=title]').inputValue(), 'Novo rascunho preservado');

  state = 'idle';
  resolved = false;
  connected = false;
  await page.goto(fixture.base);
  await openCapture();
  await page.locator('#resolveCapture:disabled').waitFor();
  assert.match(await page.locator('#captureResolutionStatus').innerText(), /conect/i);
  connected = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('#resolveCapture:enabled').waitFor();
  capture.stage = 'product';
  await page.goto(fixture.base);
  await openCapture();
  assert.match(await page.locator('#detailContent').innerText(), /captura.*reconferir/is);
  // A completed job may refer to an offer that is no longer safe to approve.
  state = 'done';
  needsRefresh = true;
  await page.goto(fixture.base);
  await openCapture();
  await page.locator('#resolveCapture:enabled').waitFor();
  assert.match(await page.locator('#captureResolutionStatus').innerText(), /Validação vencida/);
  await startResolution();
  assert.equal(posts, 4);
  state = 'done';
  needsRefresh = false;
  resolved = true;
  await page.locator('#selectDetail:enabled').waitFor();
  assert.equal(await page.locator('[name=affiliateUrl]').inputValue(), offer.affiliateUrl);
  assert.equal(posts, 4);
  console.log(
    'Capture automatic UI: success, retry, resume, draft race and disconnected checks passed.',
  );
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
