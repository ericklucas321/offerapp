# Testes de interface isolados

Executar na raiz do Offer App com Node >=24, Playwright e um navegador instalado:

```powershell
& C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe test-ui/run.mjs
```

O runner procura primeiro uma instalação local de `playwright` e usa como alternativa o Playwright já fornecido pelo runtime Codex e Microsoft Edge em modo headless. Em outro ambiente, defina `OFFER_PLAYWRIGHT_PATH` para o caminho de `playwright/index.mjs` e `OFFER_BROWSER_CHANNEL` para o canal instalado (`chrome`, `msedge`, etc.). Não instala dependências nem navegadores.

Cada execução inicia o servidor HTTP real, a camada de aplicação real e SQLite em diretório temporário. O publisher retorna somente um grupo fictício e nunca abre conexão WhatsApp. Nenhum worker é iniciado. Todas as requisições do navegador fora do servidor local são bloqueadas. A pausa só é removida na base descartável para validar aprovação e fila; não há transporte capaz de enviar. A base é removida ao final.

Cobertura: navegação, configuração de grupo, falha recuperável de integração, validação de formulário com preservação dos campos, cadastro, edição, persistência após recarregar, duplicação, bloqueio por pausa, aprovação, agendamento, cancelamento, histórico e responsividade nas três áreas em 375/768/1440px. Também verifica tamanho legível dos campos mobile, alvos de navegação e ausência de exceções JavaScript/requisições externas.

`evidence/results.json` e screenshots são substituídos em cada execução. `ui-before.json` e `ui-before.log` preservam a regressão inicialmente reproduzida. `measure.mjs` coleta medidas adicionais; `no-group.mjs` reproduz o estado da oferta sem grupo configurado.

Esses testes não comprovam conexão/persistência de credenciais reais, WhatsApp Web, leitura real de grupos, envio real, autorização de afiliados nem garimpo nas lojas. Essas verificações dependem de integração e autorização próprias.

O cenário de envio parcial escreve artificialmente um estado `sent` na base temporária, preserva essa entrega e testa a revalidação do destino restante. Isso não envolve envio real nem chamada ao publisher.
