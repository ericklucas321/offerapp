# Testes de interface isolados

`npm run test:ui` executa dois scripts com Node 24, Playwright e um navegador:

- `run.mjs`: o painel inteiro (Ofertas, Canais, Configurar) contra o servidor real e um banco SQLite temporário.
- `payment-parser.mjs`: a leitura das páginas do Mercado Livre (preço, Pix, variantes, estoque, gerador de links) em páginas de exemplo.

O runner procura primeiro uma instalação local de `playwright`. Em outro ambiente, defina `OFFER_PLAYWRIGHT_PATH` para o caminho de `playwright/index.mjs` e `OFFER_BROWSER_CHANNEL` para o canal instalado (`chrome`, `msedge`, etc.; o padrão é `msedge`). Use `OFFER_BROWSER_CHANNEL=chromium` para o Chromium que acompanha o Playwright (Linux e CI). Não instala dependências nem navegadores.

No Linux/CI:

```bash
OFFER_BROWSER_CHANNEL=chromium npm run test:ui
```

O workflow `.github/workflows/ci.yml` executa `npm run verify` e `npm run test:ui` com Node 24 e Chromium a cada push e pull request.

## O que `run.mjs` cobre

- As três telas e o guia de configuração; o interruptor "Offer trabalhando sozinho" fica bloqueado até a configuração mínima.
- Canais: WhatsApp conectado com Reconectar e Desconectar, grupo adicionado e colocado em Automático.
- Configurar: tema criado, validado e editado; "Testar agora" exige a extensão e mostra as etapas.
- Ofertas: ligar e desligar o Offer, enviar uma oferta pronta e vê-la na fila em Envios.
- 375, 768 e 1440 px sem rolagem horizontal e com botões de navegação de pelo menos 44 px.
- Nenhum erro de JavaScript e nenhuma requisição fora do servidor local.

O publisher do WhatsApp é fictício e nunca envia mensagens. A fila não é iniciada. `evidence/results.json` e as capturas de tela são substituídos a cada execução.

Esses testes não comprovam conexão real com o WhatsApp, a conta de afiliado nem as páginas reais das lojas. Para isso, use "Testar agora" em Configurar com sua conta.
