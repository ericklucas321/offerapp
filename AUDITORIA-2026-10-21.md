# Offer 5.0.2 — estabilização de 21/10/2026

## Entrega e procedência

A pasta inicial desta tarefa estava vazia. A base localizada foi `C:/Users/user/Documents/Codex/2026-10-18/vamos-continuar-o-trabalho-no-offer/offer-machine`, versão 5.0.1. Foi copiada para esta tarefa, sem dados, credenciais, `.env`, distribuições ou diretórios de revisão. Não havia metadados Git nessa base. A instalação anterior foi preservada.

O reconhecimento abrangeu todos os módulos de `src/`, `public/`, `extension/`, `scripts/`, os testes, manifests, lockfile, atalhos e documentação. Código implementado foi separado de comportamento comprovado. O inventário e os hashes das diferenças ficam em `evidence/source-comparison.json`.

Existe também uma instância 5.0.1 na porta 3210. Ela foi consultada somente por GET: WhatsApp conectado, publicação pausada, busca desligada; leitura de grupos HTTP 200, com contrato válido e grupos presentes. Não foram armazenados nomes, IDs ou mensagens desses grupos. Essa evidência não homologa a versão corrigida nem demonstra persistência após reinício real. Ver `evidence/live-existing-instance.json`.

## Arquitetura e dependências

- Node.js >=24; nesta auditoria, 24.19.0 do Codex. O `node` padrão do Windows é 22.20.0. Os atalhos existentes localizam o runtime compatível.
- Servidor HTTP nativo em loopback; frontend JavaScript/CSS sem framework; não há build de SPA ou serviço remoto próprio.
- SQLite nativo (`node:sqlite`), WAL, foreign keys, migrações 1–3, consultas preparadas e trava por diretório. Persiste ofertas, capturas, preços, eventos, grupos, temas, trabalhos de navegador, prévias e entregas.
- WhatsApp: Baileys 6.7.24, Pino 9.9.0 e QRCode 1.5.4. Sessão em `DATA_DIR/wa-auth`; pacotes opcionais carregaram sem abrir conexão real nova.
- Extensão MV3 para Mercado Livre, Amazon e Shopee, com pareamento local e token. Descoberta e links usam páginas e ferramentas afiliadas visíveis no navegador. Não há cliente OAuth/API REST Mercado Livre nesta base.
- Fila de execução única, revisão explícita por destino, revalidação browser antes do transporte, limites por grupo e tratamento de resultados incertos sem repetição automática.
- Dependências da base foram reutilizadas por junction de `node_modules`, sem instalação global ou alteração da instalação compartilhada. Playwright 1.62.1 e Edge 155 foram fornecidos pelo ambiente. O ZIP não inclui dependências instaladas.

## Falhas reproduzidas e correções

Skills e ferramentas validadas: Superpowers (depuração, planejamento delimitado, testes antes das correções, verificação e revisão); Playwright CLI 0.1.22 e pacote Playwright 1.62.1; UI UX Pro Max com script de busca executável e resultados em `evidence/ui-ux-rules.txt`; Firecrawl autenticado, busca técnica e leitura de documentação oficial. O Python isolado foi usado somente para inspeção local do ZIP. Skills de publicidade, finanças e criação de sites não agregavam valor a esta estabilização e não foram aplicadas. Não foi encontrado perfil instalado chamado **Independent Audit Review**; um subagente separado assumiu esse papel com revisão crítica e reproduções próprias. Uma segunda frente de UI produziu testes Playwright sem editar código do produto.

| Falha | Evidência e correção |
| --- | --- |
| Reinício retomava publicação quando a configuração anterior estava ativa | Teste de processo real falhou antes; toda inicialização agora exige retomada explícita. |
| Lote manual reservava horário posterior à validade de 15 minutos da confirmação | Recusa no agendamento individual e em lote; rollback integral, sem aprovação parcial. Estoque manual vencido em fila cancela a aprovação em vez de adiar indefinidamente. |
| Recuperação manual após envio parcial bloqueava edição e cadastro duplicado | Reconfirmação exige consentimento de disponibilidade, conteúdo normalizado integralmente igual e ausência de entregas ativas/incertas. Atualiza só evidência; conteúdo e histórico enviados ficam preservados. Interface oferece campos somente leitura e ação específica. |
| Envio fora da ordem de IDs escondia a pendência manual | Revisão considera destinos cancelados/falhos ainda não enviados; conclusão de todos os destinos retira a sugestão. |
| Tracking diferente na URL bloqueava produto browser idêntico | Aceita mudança de URL somente com mesma loja, chave e variante de produto browser. Guardas das capturas pontuais foram preservadas. |
| Callback tardio de socket WhatsApp podia gravar credenciais e alterar o erro atual | Eventos novos de socket antigo são ignorados; escritas aceitas são serializadas e drenadas no encerramento e antes da reconexão. |
| Encerramento não aguardava gravação de credenciais | `close()` retorna a drenagem e o aplicativo aguarda. Teste com gravação controlada e restauração real do helper de autenticação, sem rede. |
| Oferta sem grupo aparecia pendente sem motivo | Estado e texto orientam habilitar um grupo em Configurações. |
| Campos mobile de 11px e navegação com 34,5px | UI UX Pro Max orientou a correção medida: campos 16px e navegação de pelo menos 44×44px. Playwright confirmou, sem transbordamento nas áreas testadas. |

Testes antigos alterados: relógio do Platform na fixture HTTP agora usa o mesmo relógio dos serviços; teste de idempotência manual usa intervalos dentro da validade; fila de vários dias utiliza observações browser, que têm atualização automática. Os testes de agendamento e recaptura pontual continuam ativos. Não foram removidos testes para ocultar falhas.

## Validação e evidências

| Verificação | Resultado / evidência |
| --- | --- |
| Base original | 103 testes aprovados, `baseline-tests.log` |
| Regressões antes das correções | Falhas esperadas em `evidence/regression-before.log`, `no-group-before.log`, `partial-before.log`, `partial-visibility-before.log`, `partial-completed-before.log` |
| Backend e contratos após correções | 113 testes; execução final em `evidence/verify.log` |
| Playwright com servidor e SQLite reais, publisher falso | 10 cenários; `test-ui/evidence/ui-after.json`, `ui-after.log` e screenshots |
| Responsividade | Revisar, Envios e Configurações em 375, 768 e 1440px; sem requisições externas ou exceções JavaScript no contexto de teste |
| Sessão WhatsApp | QR, concorrência, desconexão, recuperação de erro e callbacks simulados; gravação/restauração de credenciais com helper Baileys real e socket falso |
| Instância real anterior | WhatsApp conectado e leitura de grupos HTTP 200; somente leitura, `evidence/live-existing-instance.json` |
| Fila e integridade | Bancos temporários; idempotência, rollback, migração, reinício, pausas, horários, preço/estoque, duplicação, resultado incerto e envio parcial simulados |
| Dependências | Imports reais aprovados; `npm audit --json` registrou zero vulnerabilidades conhecidas em `evidence/npm-audit.json` na data da execução |
| Distribuição | Build limpo, inspeção do ZIP e smoke da versão corrigida registrados em `evidence/` |
| Revisão independente | `docs/INDEPENDENT-AUDIT.md`: execução própria de 113 testes e sintaxe; sem achados acionáveis confirmados após correções |

`verify` executa build da extensão, sintaxe, testes e formatação. `test:ui` é separado e requer Playwright/navegador disponíveis; não instala dependências silenciosamente. A revisão independente não executou Playwright por conta própria; a frente de UI e o executor principal registram essas evidências separadamente. Zero alertas no npm audit não equivale a ausência de riscos ou certificação de segurança.

O executor principal repetiu `npm run test:ui` após os últimos ajustes: 10/10 cenários aprovados (`evidence/playwright-final.log`). O smoke da 5.0.2 em http://127.0.0.1:3211/ retornou HTTP 200 para página e estado, fila vazia/pausada, busca desligada e WhatsApp desconectado em banco isolado (`evidence/smoke.json`). A inspeção do ZIP confirmou integridade e ausência de banco, `.env`, sessões e dependências instaladas (`evidence/release-inspection.json`).

## Investigação Mercado Livre HTTP 401

Foi pesquisada a árvore atual, as cópias anteriores relevantes e os logs locais de servidor disponíveis, sem encontrar a requisição original do 401. A integração atual não chama `api.mercadolibre.com`; utiliza extensão, DOM e ferramenta afiliada.

A [documentação oficial de autenticação](https://developers.mercadolivre.com.br/en_us/authentication-and-authorization) exige access token no header Authorization e descreve expiração e rotação de tokens. Ausência/expiração/revogação de token é hipótese para um cliente REST, não conclusão sobre o incidente informado.

Sonda pública anônima e somente leitura: `GET https://api.mercadolibre.com/sites/MLB/search?q=cafeteira&limit=1`, sem header Authorization, retornou **403 forbidden** em 21/10/2026. O registro está em `evidence/ml-anonymous-probe.json`. Não foi reproduzido HTTP 401. Documentação pública consultada pelo Firecrawl; nenhum código, credencial ou dado interno foi enviado ao serviço.

Para fechar o incidente é necessária a URL/fluxo original, status e resposta sanitizada, sem token/cookie, e a conta autorizada no navegador. Não foi introduzido um novo subsistema OAuth para tratar um cliente inexistente nesta versão.

## Bloqueios externos objetivos

1. Pareamento e reconexão da versão corrigida com conta real ainda não homologados. A sessão existente não foi copiada, derrubada ou usada simultaneamente em outra instância. Reinício/persistência reais exigem janela operacional coordenada.
2. Seleção de grupos reais e transporte supervisionado exigem autorização específica para o destino e conteúdo. Nenhuma mensagem real foi enviada. Seleção e armazenamento foram validados em banco temporário com grupos fictícios.
3. Garimpo real, leitura de preço/estoque e geração/destino dos links exigem extensão instalada no navegador habitual, sessões das lojas e permissões de afiliado. Adaptadores/contratos foram testados com fixtures; comissão, redirecionamento final e layouts reais não foram homologados.
4. O HTTP 401 histórico precisa da requisição original; a sonda atual retornou 403 e não basta para atribuir a causa.
5. O app continua local e de um operador. Não está homologado como serviço multiusuário público. O ZIP deve receber `INSTALAR.bat` em ambiente novo; uma reinstalação limpa independente de todas as dependências não foi executada nesta auditoria.

## Próximas melhorias

| Prioridade / melhoria | Impacto | Esforço | Dependências |
| --- | --- | --- | --- |
| Homologação real controlada de WhatsApp e três lojas | Alto | Médio | Operador, contas, extensão e autorização de um envio supervisionado |
| Capturar diagnóstico sanitizado do 401 original | Alto | Baixo | Requisição/fluxo original, sem segredos |
| CI com Node24, backend, Playwright e instalação limpa | Alto | Médio | Repositório Git/CI definido e navegador de teste |
| Backup/restauração e atualização ensaiada com dados sintéticos | Alto | Médio | Política de retenção e janela de manutenção |
| Telemetria local sanitizada de reconexões, fila e falhas | Médio | Médio | Definir retenção, privacidade e sinais operacionais |
| Adaptadores homologados contra mudanças reais das lojas | Alto | Contínuo | Contas de teste autorizadas e páginas de referência permitidas |
| Revalidação guiada quando preço manual muda após envio parcial | Médio | Médio | UX para criar revisão nova e manter identidade/histórico |
| Acessibilidade ampliada com leitores de tela e dispositivos físicos | Médio | Médio | Dispositivos, navegação por teclado e testes assistivos |
| Modelo comercial, autenticação/isolamento multiusuário se virar serviço | Alto | Alto | Definir produto, hospedagem, obrigações e termos das integrações |

## Reprodução local

Use `TESTAR.bat` para o backend e checks. No terminal com Node24: `npm run verify`, `npm run test:ui`, `npm run build:package`. O launcher `INICIAR.bat` usa porta3210 por padrão; para coexistir com a instância anterior, a sessão desta entrega foi iniciada com `PORT=3211`, banco novo e fila pausada. Não substitua os dados anteriores sem backup e homologação operacional.
