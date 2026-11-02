# Plano e registro de execução

Objetivo fornecido pelo usuário: estabilizar a base existente com correções viáveis, testes críticos e auditoria independente; preservar arquitetura e funcionalidades operacionais; não enviar mensagens reais nem realizar operações irreversíveis.

Decisão: correções delimitadas nos fluxos existentes, sem novo subsistema ou redesign. A instrução explícita para executar as correções orientou execução contínua, com revisões e evidências verificáveis.

- [x] Localizar a versão atual, ler fontes/configuração/testes e validar runtimes e skills úteis.
- [x] Isolar código sem copiar dados ou sessões e executar a suíte inicial.
- [x] Auditoria independente de política, persistência, extensão e fila.
- [x] Escrever testes que reproduzem as falhas; guardar evidência de falha antes da correção.
- [x] Corrigir sessão, cronograma manual, identidade browser e recuperação multidestino com mudanças mínimas.
- [x] Usar UI UX Pro Max e Playwright para problemas medidos e recuperação pela interface.
- [x] Investigar 401 com código/logs, documentação oficial e sonda pública sem autenticação.
- [x] Revalidar regressões com auditor independente; preservar capturas e envio incerto.
- [x] Verificação final completa, ZIP limpo e smoke local pausado: `verify` aprovado, 113 testes, Playwright 10/10, ZIP inspecionado e 5.0.2 ativa na porta3211 com dados isolados.

Alterações principais: `src/app.mjs`, `src/infrastructure/whatsapp.mjs`, `src/domain/publication.mjs`, `src/application/offers.mjs`, `src/application/platform.mjs`, `src/http/server.mjs`, `public/app.js`, `public/styles.css`. Sem nova migração ou reescrita da extensão. Testes novos em `test/stability.test.mjs`, `test/whatsapp.test.mjs` e `test-ui/`.

Critérios: zero envio real; nenhuma nova conexão de conta; fila pausada ao iniciar; testes backend e UI aprovados; bloqueios externos explicitamente descritos. Referência: `AUDITORIA-2026-10-21.md`.
