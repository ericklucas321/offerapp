import test from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../src/shared/capture-contract.mjs';
import * as extension from '../extension/capture.js';
const item = {
  stage: 'product',
  productKey: 'MLB123456789',
  variant: '',
  title: 'Captura isolada do contrato',
  productUrl: 'https://produto.mercadolivre.com.br/MLB-123456789-fixture',
  imageUrl: '',
  priceCents: 6990,
  available: true,
  stockStatus: 'available',
  observedAt: new Date().toISOString(),
  priceCondition: 'Preço à vista anunciado',
};
test('extensão gerada e servidor usam o mesmo protocolo, DTO e validação', () => {
  assert.deepEqual(extension.CAPTURE_PROTOCOL, server.CAPTURE_PROTOCOL);
  const dto = extension.captureItem(item, 'product');
  assert.deepEqual(dto, server.captureItem(item, 'product'));
  const packet = { version: extension.CAPTURE_PROTOCOL.version, items: [dto] };
  assert.deepEqual(extension.validateBrowserCapture(packet), server.validateBrowserCapture(packet));
  const card = extension.captureItem(item, 'card');
  assert.equal(card.stockStatus, 'unknown');
  assert.equal(card.available, false);
  assert.deepEqual(
    extension.validateBrowserCapture({ version: 1, items: [card] }),
    server.validateBrowserCapture({ version: 1, items: [card] }),
  );
});
test('nenhum lado aceita pacote com versão, identidade, estoque ou preço incoerentes', () => {
  for (const packet of [
    { version: 99, items: [item] },
    { version: 1, items: [{ ...item, productKey: 'MLB999999999' }] },
    { version: 1, items: [{ ...item, priceCents: 0 }] },
    { version: 1, items: [{ ...item, stockStatus: 'unknown' }] },
  ]) {
    for (const contract of [extension, server])
      assert.throws(() => contract.validateBrowserCapture(packet), /browser_import_invalid/);
  }
});
