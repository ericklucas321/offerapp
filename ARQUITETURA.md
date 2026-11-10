# Código do Offer

O Offer usa Node.js 24, SQLite e JavaScript sem framework. Não há servidor externo nem etapa de compilação para executar o aplicativo.

O fluxo é: pesquisar → ler o produto e obter o link afiliado → selecionar por aprovação manual ou regras do automático → atualizar preço e estoque → enviar → registrar o resultado.

## Onde alterar

| Arquivo | Responsabilidade |
| --- | --- |
| `src/app.mjs` | Iniciar e encerrar servidor, pesquisa, fila e WhatsApp. |
| `src/http/server.mjs` | API local, arquivos do painel e validação de acesso. |
| `src/application/platform.mjs` | Coordenar grupos, temas, revisão e trabalhos do navegador. |
| `src/application/offers.mjs` | Cadastrar, editar, preparar e listar ofertas. |
| `src/application/automatic-publication.mjs` | Configurar o automático e escolher uma oferta por grupo. |
| `src/domain/` | Regras de preço, mensagem, horários, repetição e publicação. |
| `src/infrastructure/repository.mjs` | Consultas e gravações no SQLite. |
| `src/infrastructure/whatsapp.mjs` | Sessão e transporte WhatsApp. |
| `src/jobs/queue.mjs` | Executar a fila e conferir as regras antes do envio. |
| `src/shared/` | Parser e contrato de captura compartilhados com a extensão. |
| `public/` | Painel: HTML, CSS e JavaScript. |
| `extension/` | Ponte com o painel e leitura das páginas das lojas. |

## Persistência e execução

O SQLite guarda ofertas, capturas, temas, grupos, conexões, trabalhos do navegador, aprovações e histórico. As migrações preservam os dados existentes. `Store.transaction()` concentra o commit e o rollback das operações síncronas; a criação de oferta mantém seu tratamento próprio de duplicidade.

Uma trava impede dois processos usando o mesmo banco. O repositório reutiliza consultas preparadas. As listas reaproveitam as ofertas carregadas e os destinos são consultados diretamente nas associações entre ofertas, temas e grupos. A automação consulta a conexão da extensão sem montar o estado inteiro do painel e carrega seus candidatos uma vez por ciclo.

A pesquisa roda a cada 30 minutos, sem ciclos simultâneos. A fila verifica pausa, destinos, horários, intervalo, identidade do produto, preço, estoque e repetição antes de transportar a mensagem. A checagem final também usa as regras atuais do automático. Uma entrega incerta não é reenviada automaticamente.

A inicialização pausa os envios quando o automático está desligado. Com o automático ligado, preserva sua configuração e a pausa existentes. O encerramento aguarda a execução em andamento e a gravação da sessão.

## Navegador e painel

A extensão MV3 usa pareamento e token local. O servidor valida Host e origem; apenas a extensão registrada acessa as rotas de trabalhos e resultados. As credenciais das lojas permanecem no navegador.

Os adaptadores de Mercado Livre, Amazon e Shopee leem páginas e ferramentas afiliadas visíveis. Falhas de uma oferta não devem suspender toda a loja; bloqueios da conta exigem revalidação.

O painel tem três telas: Ofertas (interruptor da operação, encontradas e envios), Canais (WhatsApp e modo de cada grupo) e Configurar (extensão, teste do Mercado Livre e temas). Atualiza os dados a cada 5 segundos, sem sobrescrever um formulário em edição. Os envios usam paginação por cursor.

Cada grupo tem um modo (`off`, `review`, `automatic`, migração 4). A lista do automático é derivada desses modos. O interruptor (`POST /api/platform/operation`) liga a busca, o automático e a fila juntos. Falhas de leitura são classificadas em `Platform.failJob`: só problemas de conta, ou o gerador de afiliado falhando 3 vezes seguidas, suspendem a loja, e `tick()` testa a loja suspensa sozinho a cada ciclo.

## Verificação

`npm run verify` verifica extensão, sintaxe, testes e formatação. `npm run test:ui` exercita o servidor e a interface com banco temporário, requisições externas bloqueadas e transporte fictício. Os testes não substituem a conferência das integrações reais nas contas do usuário.
