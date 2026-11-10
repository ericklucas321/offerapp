# Offer

Aplicativo local para pesquisar ofertas e enviar aos grupos do WhatsApp. Usa Node.js 24, SQLite e uma interface sem framework.

## Iniciar

Execute `INSTALAR.bat` na primeira instalação e `INICIAR.bat` para abrir o aplicativo. O endereço padrão é http://127.0.0.1:3210/. `PORT` e `DATA_DIR` podem ser definidos no `.env`. Use somente uma instância por banco.

## Configurar e usar

O painel tem três telas: **Ofertas**, **Canais** e **Configurar**. Enquanto falta algo, a tela Ofertas mostra o que fazer.

1. **Configurar → Extensão:** baixe a extensão (versão **0.4.0**), extraia, carregue a pasta em `chrome://extensions` ou `edge://extensions` (modo do desenvolvedor) e clique **Conectar extensão**. Use o navegador onde você está logado na conta de afiliado do Mercado Livre.
2. **Configurar → Mercado Livre:** clique **Testar agora**. O Offer faz uma busca e gera um link de afiliado, mostrando cada etapa. Se algo falhar, a etapa e o motivo aparecem ali.
3. **Canais:** conecte o WhatsApp pelo QR, clique **Buscar grupos do WhatsApp** e adicione os grupos. Para cada grupo escolha **Não recebe**, **Com revisão** ou **Automático**, além do horário (Brasília) e do intervalo entre envios. Início igual ao fim permite 24 horas.
4. **Configurar → Temas:** palavras-chave e faixa de preço. Cada tema vale para todos os grupos que recebem ofertas.
5. **Ofertas:** ligue **Offer trabalhando sozinho**. Ele pesquisa a cada 30 minutos, gera os links e envia sozinho aos grupos em Automático. Nos grupos Com revisão, selecione as ofertas e clique **Enviar**.

Desligar o interruptor para a busca e os envios automáticos. Um envio que você confirma manualmente sempre sai. A extensão trabalha numa janela minimizada e não rouba o foco.

**O que acontece quando algo falha:** um produto com problema é ignorado e a busca continua. Só um problema na conta (deslogado, verificação da loja ou o gerador de links falhando em 3 produtos seguidos) suspende o Mercado Livre. Nesse caso o aviso aparece em Ofertas e o Offer testa de novo sozinho a cada 30 minutos. Computador, aplicativo e navegador precisam continuar ligados.

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
