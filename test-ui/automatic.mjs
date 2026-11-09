import assert from 'node:assert/strict';
import { launchBrowser } from './playwright-runtime.mjs';
import { startFixture } from './fixture.mjs';
const fixture = await startFixture();
fixture.platform.saveGroup({ id: '123456789@g.us' }, [
  { id: '123456789@g.us', name: 'Grupo de teste local' },
]);
fixture.platform.saveTopic({
  name: 'Casa',
  keywords: ['cafeteira'],
  stores: ['mercadolivre'],
  groupIds: ['123456789@g.us'],
});
const browser = await launchBrowser();
const context = await browser.newContext();
await context.route('**/*', (route) =>
  route.request().url().startsWith(fixture.base) ? route.continue() : route.abort(),
);
const page = await context.newPage();
try {
  await page.goto(fixture.base);
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await page.getByRole('button', { name: '3. Temas e preços' }).click();
  const form = page.locator('#automaticForm');
  await form.locator('[name=enabled]').check();
  await form.getByRole('button', { name: 'Salvar modo de envio' }).click();
  await page.locator('#toastText').filter({ hasText: 'Confira os campos' }).waitFor();
  assert.equal(fixture.platform.status().automaticEnabled, false);
  await form.locator('[name=automaticGroupIds]').check();
  await form.getByRole('button', { name: 'Salvar modo de envio' }).click();
  await form.getByRole('button', { name: 'Salvo', exact: true }).waitFor();
  assert.equal(fixture.platform.status().automaticEnabled, true);
  assert.deepEqual(fixture.platform.status().automaticGroupIds, ['123456789@g.us']);
  await page.reload();
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await page.getByRole('button', { name: '3. Temas e preços' }).click();
  assert.equal(await page.locator('#automaticForm [name=enabled]').isChecked(), true);
  await page.locator('#automaticForm [name=enabled]').uncheck();
  await page.locator('#automaticForm button').click();
  await page.locator('#automaticForm button').filter({ hasText: 'Salvo' }).waitFor();
  assert.equal(fixture.platform.status().automaticEnabled, false);
  console.log('Automatic UI: explicit groups, enable, persistence and disable passed.');
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
