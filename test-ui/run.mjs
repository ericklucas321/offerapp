import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPlaywright } from './playwright-runtime.mjs';
import { startFixture } from './fixture.mjs';
const { chromium } = await loadPlaywright();
const evidence = path.resolve('test-ui/evidence');
fs.mkdirSync(evidence, { recursive: true });
const fixture = await startFixture();
const browser = await chromium.launch({
  channel: process.env.OFFER_BROWSER_CHANNEL || 'msedge',
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  timezoneId: 'America/Sao_Paulo',
});
let syntheticSent = 0;
const externalRequests = [],
  pageErrors = [],
  results = [];
await context.route('**/*', (route) => {
  if (!route.request().url().startsWith(fixture.base)) {
    externalRequests.push(route.request().url());
    return route.abort();
  }
  return route.continue();
});
const page = await context.newPage();
page.on('pageerror', (error) => pageErrors.push(error.message));
const step = async (name, action) => {
  try {
    await action();
    results.push({ name, status: 'passed' });
  } catch (error) {
    results.push({ name, status: 'failed', error: error.message });
    await page.screenshot({
      path: path.join(evidence, `failure-${results.length}.png`),
      fullPage: true,
    });
    throw error;
  }
};
const field = (name) => page.locator(`#detailForm [name="${name}"]`);
const save = () => page.getByRole('button', { name: 'Salvar e atualizar mensagem' }).click();
const waitToast = (text) => page.locator('#toastText').filter({ hasText: text }).waitFor();
try {
  await step('Navegação, pausa segura e grupos do publisher falso', async () => {
    await page.goto(fixture.base);
    await page.locator('#operationStatus').filter({ hasText: 'Envios pausados' }).waitFor();
    await page.locator('[data-section="settings"]').click();
    await page.locator('[data-settings-tab="groups"]').click();
    await page.locator('#loadGroups').click();
    await page.locator('#newGroup').selectOption('123456789@g.us');
    await page.locator('[data-group-form] [name=start]').fill('00:00');
    await page.locator('[data-group-form] [name=end]').fill('00:00');
    await page.getByRole('button', { name: 'Salvar grupo' }).click();
    await waitToast('Grupo salvo');
    assert.equal(fixture.platform.groups().length, 1);
    await page.screenshot({ path: path.join(evidence, 'desktop-groups.png'), fullPage: true });
  });
  await step('Falha de integração mostra feedback, reativa botão e permite repetir', async () => {
    await page.route('**/api/whatsapp/groups', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'fixture_unavailable',
          message: 'WhatsApp indisponível nesta simulação. Tente novamente.',
        }),
      }),
    );
    await page.locator('#loadGroups').click();
    await waitToast('WhatsApp indisponível');
    assert.equal(await page.locator('#loadGroups').isEnabled(), true);
    await page.unroute('**/api/whatsapp/groups');
    await page.locator('#loadGroups').click();
    await page.locator('#newGroup').selectOption('123456789@g.us');
    assert.equal(await page.locator('[data-group-form]').count(), 1);
  });
  await step('Cadastro inválido preserva formulário e mostra erro recuperável', async () => {
    await page.locator('[data-section="offers"]').click();
    await page.locator('#newManual').click();
    await field('productUrl').fill('https://produto.mercadolivre.com.br/MLB-123456789-teste');
    await field('title').fill('Oferta de teste local');
    await field('price').fill('0');
    await field('affiliateUrl').fill('https://meli.la/oferta-local');
    await field('affiliateConfirmed').check();
    await field('availableConfirmed').check();
    await save();
    await page.locator('#detailError:not([hidden])').waitFor();
    assert.equal(await field('title').inputValue(), 'Oferta de teste local');
    assert.equal(fixture.store.listOffers().length, 0);
    await page.screenshot({ path: path.join(evidence, 'form-validation.png'), fullPage: true });
  });
  await step('Cadastro válido, edição e persistência após recarregar', async () => {
    await field('price').fill('149,90');
    await save();
    await waitToast('Oferta salva');
    await field('title').fill('Oferta editada local');
    await field('affiliateConfirmed').check();
    await field('availableConfirmed').check();
    await save();
    await waitToast('Oferta salva');
    await page.getByRole('button', { name: 'Fechar detalhes', exact: true }).click();
    await page.reload();
    await page.getByText('Oferta editada local', { exact: true }).waitFor();
    const rows = fixture.store.listOffers();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].price_cents, 14990);
    assert.equal(rows[0].title, 'Oferta editada local');
  });
  await step('Duplicação rejeitada sem criar dados extras', async () => {
    await page.locator('#newManual').click();
    for (const [name, value] of Object.entries({
      productUrl: 'https://produto.mercadolivre.com.br/MLB-123456789-teste',
      title: 'Duplicada',
      price: '149,90',
      affiliateUrl: 'https://meli.la/oferta-local',
    }))
      await field(name).fill(value);
    await field('affiliateConfirmed').check();
    await field('availableConfirmed').check();
    await save();
    await page.locator('#detailError:not([hidden])').waitFor();
    assert.equal(fixture.store.listOffers().length, 1);
    await page.getByRole('button', { name: 'Fechar detalhes', exact: true }).click();
  });
  await step('Revisão bloqueada por pausa; agendamento só na fixture sem worker', async () => {
    await page.locator('.row-open').first().click();
    await page.locator('#detailDestinations input').check();
    await page.locator('#selectDetail').click();
    await page.locator('#reviewBatch').click();
    await page.locator('#batchError:not([hidden])').waitFor();
    assert.equal(await page.locator('#confirmBatch').isDisabled(), true);
    assert.equal(fixture.store.listDeliveries().length, 0);
    await page.getByRole('button', { name: 'Fechar revisão do lote' }).click();
    // Only the isolated test DB is unpaused; no real publisher/worker exists.
    fixture.store.setSetting('publication_paused', 'false');
    await page.reload();
    await page.locator('.row-open').first().click();
    await page.locator('#detailDestinations input').check();
    await page.locator('#selectDetail').click();
    await page.locator('#reviewBatch').click();
    await page.locator('#confirmBatch').click();
    await page.locator('#batchDialog').waitFor({ state: 'hidden' });
    const deliveries = fixture.store.listDeliveries();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].state, 'queued');
    assert.ok(Date.parse(deliveries[0].next_attempt_at));
    fixture.store.setSetting('publication_paused', 'true');
    await page.locator('[data-section="deliveries"]').click();
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await page.locator('.delivery-row').waitFor({ state: 'hidden' });
    assert.equal(fixture.store.listDeliveries()[0].state, 'cancelled');
    await page.locator('[data-delivery-filter="history"]').click();
    await page.getByText('Cancelado', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'queue-cancelled.png'), fullPage: true });
  });
  await step('Responsividade em 375, 768 e 1440px sem rolagem horizontal', async () => {
    if (await page.locator('#toast').isVisible()) await page.locator('#closeToast').click();
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const section of ['offers', 'settings', 'deliveries']) {
        await page.locator(`[data-section="${section}"]`).click();
        const dimensions = await page.evaluate(() => ({
          viewport: innerWidth,
          content: document.documentElement.scrollWidth,
        }));
        assert.ok(
          dimensions.content <= dimensions.viewport + 1,
          `${section} ${width}: content=${dimensions.content}`,
        );
        await page.screenshot({
          path: path.join(evidence, `${section}-${width}.png`),
          fullPage: true,
        });
      }
    }
  });
  await step('Campos mobile legíveis (16px) e navegação com alvos de 44px', async () => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.locator('[data-section="offers"]').click();
    const metrics = await page.evaluate(() => ({
      fields: [...document.querySelectorAll('#searchInput,#storeFilter')].map((e) => ({
        selector: '#' + e.id,
        fontSize: parseFloat(getComputedStyle(e).fontSize),
      })),
      navigation: [...document.querySelectorAll('nav button')].map((e) => ({
        selector: `[data-section="${e.dataset.section}"]`,
        height: e.getBoundingClientRect().height,
        width: e.getBoundingClientRect().width,
      })),
    }));
    fs.writeFileSync(path.join(evidence, 'ui-metrics.json'), JSON.stringify(metrics, null, 2));
    assert.ok(
      metrics.fields.every((f) => f.fontSize >= 16) &&
        metrics.navigation.every((n) => n.height >= 44 && n.width >= 44),
      JSON.stringify(metrics),
    );
    await page.locator('#newManual').click();
    const formFields = await page
      .locator('#detailForm input:not([type="checkbox"]),#detailForm textarea')
      .evaluateAll((elements) =>
        elements.map((e) => ({ name: e.name, fontSize: parseFloat(getComputedStyle(e).fontSize) })),
      );
    assert.ok(
      formFields.every((f) => f.fontSize >= 16),
      JSON.stringify(formFields),
    );
    await page.getByRole('button', { name: 'Fechar detalhes', exact: true }).click();
  });
  await step(
    'Envio parcial simulado: revalidar manual preserva histórico e libera só destino restante',
    async () => {
      const secondGroup = { id: '987654321@g.us', name: 'Segundo grupo local' };
      fixture.platform.saveGroup(
        { ...secondGroup, startMinute: 0, endMinute: 0, intervalMinutes: 1 },
        [secondGroup],
      );
      const offer = fixture.platform.offers.manual({
        productUrl: 'https://produto.mercadolivre.com.br/MLB-987654321-parcial',
        title: 'Oferta parcial para revalidar',
        price: '79,90',
        affiliateUrl: 'https://meli.la/parcial-local',
        affiliateConfirmed: true,
        availableConfirmed: true,
      });
      fixture.store.setSetting('publication_paused', 'false');
      const batch = fixture.platform.batchPreview([
        { offerId: offer.id, groupIds: ['123456789@g.us', secondGroup.id] },
      ]);
      fixture.platform.approveBatch({ id: batch.id, token: batch.token, confirmed: true });
      const deliveries = fixture.store
        .listDeliveries()
        .filter((d) => d.offer_id === offer.id)
        .sort((a, b) => a.id - b.id);
      assert.equal(deliveries.length, 2);
      // Synthetic completion writes only temporary SQLite; there is no worker or transport call.
      fixture.store.markSent(deliveries[1].id, offer.id);
      syntheticSent += 1;
      const sentSnapshot = fixture.store.listDeliveries().find((d) => d.id === deliveries[1].id);
      fixture.store
        .prepare('UPDATE offers SET verified_at=? WHERE id=?')
        .run(new Date(Date.now() - 16 * 60000).toISOString(), offer.id);
      const job = fixture.store.nextDelivery();
      assert.equal(job.delivery_id, deliveries[0].id);
      const preflight = fixture.platform.policy.preflight(job);
      assert.equal(preflight.allowed, false);
      assert.equal(
        fixture.store.listDeliveries().find((d) => d.id === deliveries[0].id).state,
        'cancelled',
      );
      fixture.store.setSetting('publication_paused', 'true');
      await page.reload();
      const row = page.locator('.offer-row').filter({ hasText: offer.title });
      await row.getByText('Pendente', { exact: true }).waitFor();
      await row.getByRole('button', { name: 'Conferir ' + offer.title, exact: true }).click();
      assert.equal(await field('price').getAttribute('readonly'), '');
      assert.equal(await field('title').getAttribute('readonly'), '');
      await field('affiliateConfirmed').check();
      await field('availableConfirmed').check();
      await page.getByRole('button', { name: 'Revalidar preço e estoque', exact: true }).click();
      await waitToast('Oferta salva');
      const destinations = page.locator('#detailDestinations input');
      assert.equal(await destinations.count(), 2);
      assert.equal(
        await page.locator('#detailDestinations input[value="123456789@g.us"]').isEnabled(),
        true,
      );
      assert.equal(
        await page.locator(`#detailDestinations input[value="${secondGroup.id}"]`).isDisabled(),
        true,
      );
      const current = fixture.platform.reviewItems().find((i) => i.id === offer.id);
      assert.equal(current.ready, true);
      assert.deepEqual(current.eligibleGroups, ['123456789@g.us']);
      assert.deepEqual(
        fixture.store.listDeliveries().find((d) => d.id === sentSnapshot.id),
        sentSnapshot,
      );
      assert.equal(fixture.store.getOffer(offer.id).title, offer.title);
      await page.screenshot({
        path: path.join(evidence, 'partial-revalidation.png'),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Fechar detalhes', exact: true }).click();
    },
  );
  await step('Zero exceções de JS e nenhuma requisição externa', async () => {
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);
    assert.equal(fixture.store.queueStats().sent, syntheticSent);
  });
} finally {
  fs.writeFileSync(
    path.join(evidence, 'results.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        browser: browser.version(),
        results,
        pageErrors,
        externalRequests,
        isolation: 'Temporary SQLite; fake publisher; no worker; all non-local requests blocked',
      },
      null,
      2,
    ),
  );
  await context.close();
  await browser.close();
  await fixture.close();
}
console.log(JSON.stringify(results, null, 2));
