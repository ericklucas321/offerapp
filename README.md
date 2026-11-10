# Offer

Aplicativo local para pesquisar ofertas e enviar aos grupos do WhatsApp. Usa Node.js 24, SQLite e uma interface sem framework.

## Iniciar

Execute `INSTALAR.bat` na primeira instalação e `INICIAR.bat` para abrir o aplicativo. O endereço padrão é http://127.0.0.1:3210/. `PORT` e `DATA_DIR` podem ser definidos no `.env`. Use somente uma instância por banco.

## Configurar e usar

1. Em **Configurações**, conecte o WhatsApp e a extensão do navegador. A extensão atual é a **0.4.0**: extraia o download, carregue a pasta em `chrome://extensions` ou `edge://extensions` e clique **Conectar extensão** no painel. Depois de atualizar os arquivos, recarregue a extensão.
2. Valide cada loja com um produto real, usando sua conta afiliada conectada no navegador.
3. Escolha os **grupos**, seus horários e o intervalo entre envios. Os horários usam Brasília. Início igual ao fim permite 24 horas.
4. Defina **temas e preços**: palavras-chave, lojas, faixa de preço e grupos de destino.
5. Ative a **busca contínua**. Ela pesquisa a cada 30 minutos, sem executar dois ciclos ao mesmo tempo.

Há dois modos de envio:

- **Manual:** confira as ofertas, revise o lote e aprove os destinos. Retome os envios quando estiver pronto.
- **Automático:** habilite explicitamente os grupos autorizados em **Temas e preços**. O aplicativo agenda uma oferta pendente por grupo, respeitando temas, preços, horários e intervalo. O botão de pausa interrompe os envios nos dois modos.

Sem o automático habilitado, a inicialização pausa os envios. Com ele habilitado, a configuração e a pausa existentes são preservadas. Computador, aplicativo e navegador precisam permanecer ativos.

Também é possível cadastrar uma oferta manualmente ou capturar um produto do Mercado Livre pela extensão. Ofertas manuais exigem confirmação recente de preço e estoque.

## Regras do envio

- Ofertas do navegador precisam de preço, estoque e link afiliado confirmados. A leitura é atualizada antes de enviar.
- Aumento de preço ou mudança de condição cancela a aprovação. Queda de preço com a mesma condição atualiza a mensagem.
- Cada grupo tem horário e intervalo próprios. Não há teto diário de publicações.
- O mesmo produto e variante só podem se repetir no grupo após 72 horas, salvo queda adicional de 10%.
- Resultado incerto exige conferir o grupo antes de tentar novamente. Não há repetição automática desse envio.

Acompanhe a fila e o histórico em **Envios**. Mudanças nas regras do grupo cancelam suas aprovações pendentes.

## Verificar e distribuir

Use Node.js 24 ou superior:

```text
npm run verify          # extensão, sintaxe, testes e formatação
npm run test:ui         # interface com banco temporário e transporte fictício
npm run build:package   # distribuição sem dados e credenciais
```

Os testes de interface usam uma instalação existente de Playwright e um navegador; veja [test-ui/README.md](test-ui/README.md). No Linux, use `OFFER_BROWSER_CHANNEL=chromium`. O GitHub Actions executa `verify` e `test:ui` em cada push. Não enviam mensagens reais. A validação das contas e das páginas reais das lojas depende do ambiente do usuário.

Para atualizar, encerre o aplicativo e preserve `data/` e `.env`. Não compartilhe o banco nem a sessão do WhatsApp.

A extensão usa as ferramentas afiliadas visíveis das lojas. Alterações dessas páginas podem exigir ajustes. Não extrai credenciais nem utiliza serviços pagos.

Veja [ARQUITETURA.md](ARQUITETURA.md) para localizar o código. As auditorias anteriores permanecem em `AUDITORIA*.md` e `docs/` como registros históricos.
