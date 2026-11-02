import { startFixture } from './fixture.mjs';
const f = await startFixture();
try {
  const offer = f.platform.offers.manual({
    productUrl: 'https://produto.mercadolivre.com.br/MLB-123456789-teste',
    title: 'Sem grupo',
    price: '149,90',
    affiliateUrl: 'https://meli.la/oferta-local',
    affiliateConfirmed: true,
    availableConfirmed: true,
  });
  console.log(
    JSON.stringify(
      f.platform.reviewItems().find((i) => i.id === offer.id),
      null,
      2,
    ),
  );
} finally {
  await f.close();
}
