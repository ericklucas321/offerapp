# Auditoria do Offer — 5.0.1

Data: 18/10/2026. Versão da extensão: 0.3.1. Execução em Windows com Node.js 24.19.0.

## Resultado

Revisão de backend, regras de publicação, persistência/migrações, API HTTP, interface, extensão, conexão WhatsApp e distribuição. As falhas encontradas foram corrigidas e receberam testes de regressão. A suíte passou de 68 para **103 testes**, todos aprovados, sem testes ignorados. Os 11 primeiros cenários adversariais falharam na implementação anterior; uma falha adicional de suspensão de loja foi reproduzida durante a revisão final.

`npm run verify` aprovou a geração da extensão, a análise de sintaxe de todos os módulos, os 103 testes e a formatação. `npm audit` e a auditoria das dependências de produção retornaram **zero vulnerabilidades conhecidas** na consulta realizada. Isso não constitui garantia de ausência de falhas.

## Problemas corrigidos

A gravidade abaixo é uma classificação prática de impacto no uso local, sem atribuição de CVSS.

| Gravidade | Falha encontrada                                                                                                                                                | Correção e verificação                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alta      | Descartar uma oferta depois da prévia ainda permitia aprovar o lote.                                                                                            | O descarte integra a identidade da prévia e bloqueia a política de publicação. Teste rejeita a aprovação sem entregas parciais.                                         |
| Alta      | Duas versões do mesmo produto para o mesmo grupo podiam entrar no lote e bloquear uma à outra.                                                                  | Validação por loja/produto/variante/destino na prévia e na transação de aprovação.                                                                                      |
| Alta      | Revalidação podia atualizar a versão mais recente do produto, em vez da oferta da entrega aprovada.                                                             | A atualização usa a entrega e a identidade exatas; divergências não alteram outra oferta.                                                                               |
| Alta      | Alterações durante o transporte podiam registrar um preço diferente do texto enviado.                                                                           | Texto e preço calculados são congelados antes do transporte e preservados no histórico.                                                                                 |
| Alta      | Uma loja suspensa podia publicar usando uma atualização recente já concluída.                                                                                   | A política e a preparação do envio exigem conexão validada; retomada depende de nova validação.                                                                         |
| Alta      | Duas instâncias podiam abrir o banco e interferir no estado de envio.                                                                                           | Trava exclusiva por processo, recuperação de proprietário encerrado e liberação pelo próprio proprietário; teste também entre processos distintos.                      |
| Alta      | Interromper o executor durante uma consulta assíncrona ainda podia iniciar o transporte.                                                                        | Encerramento aguarda a execução atual; nova checagem síncrona ocorre antes do envio. Desconexão comprovadamente anterior ao transporte é distinta de resultado incerto. |
| Alta      | URL de imagem arbitrária podia ser buscada pelo transporte.                                                                                                     | URLs HTTPS restritas aos domínios de imagens das lojas, sem credenciais ou portas alternativas; registros antigos também são checados antes do envio.                   |
| Média     | Perda da confirmação HTTP podia transformar uma leitura concluída da extensão em falha ou repetir seus efeitos.                                                 | A extensão repete o mesmo resultado; o servidor reconhece resultados terminais idênticos por hash e ignora respostas de trabalhos cancelados.                           |
| Média     | Suspender loja ou editar tema deixava leituras antigas executáveis; observações antigas podiam substituir novas.                                                | Cancelamento de trabalhos obsoletos, concessão condicionada à conexão e rejeição de dados com data regressiva.                                                          |
| Média     | Leitura genérica podia clicar em “Texto” fora da ferramenta afiliada ou recuperar link de um campo sem relação.                                                 | Seleção restrita à ferramenta afiliada visível ou ao diálogo correspondente; elementos ocultos, preço condicional e produto divergente são rejeitados.                  |
| Média     | Atualização de preço podia perder o cálculo do cupom; ofertas manuais e automáticas podiam perder sua origem; queda de 10% podia deixar de gerar nova sugestão. | Recálculo do cupom, preservação das origens e aplicação da regra de repetição por destino, com regressões específicas.                                                  |
| Média     | Filas longas podiam ultrapassar o horizonte fixo de agendamento e falhar. Datas inválidas no histórico podiam liberar a janela.                                 | Busca começa depois da última reserva; horários inválidos bloqueiam a publicação. Sem teto diário.                                                                      |
| Média     | Os registros anteriores aos últimos 200 ficavam inacessíveis pela interface.                                                                                    | Paginação por cursor e filtros no servidor; cancelamento consulta diretamente a entrega. Teste percorre 225 registros sem perda ou duplicação.                          |
| Média     | Token Unicode malformado podia produzir erro interno; proteção de origem não cobria todos os caminhos.                                                          | Formato hexadecimal estrito; rejeição de origem/Host/cross-site antes do preflight CORS; cabeçalhos CSP, nosniff e política de referência.                              |
| Baixa     | Polling podia disputar atualizações; botões e QR ficavam em estado obsoleto; captura pontual usava porta fixa.                                                  | Atualização coordenada, estados derivados da seleção/pausa, limpeza do QR, destinos elegíveis e uso da porta pareada.                                                   |

## Testes e evidências

- Regras: preço, cupom, estoque desconhecido/indisponível, validade, variantes, repetição em 72 horas, queda adicional de 10%, horários de Brasília, intervalos e independência dos grupos.
- Persistência: migrações, transações, reinício, filas, resultados incertos e preservação de histórico.
- API: captura/importação, revisão, aprovação, idempotência, seleção inválida, limite de corpo, JSON UTF-8, autenticação, origem e cabeçalhos.
- Extensão: execução serial, confirmação perdida, repetição do mesmo resultado, preservação da aba em falha e leitura conservadora de elementos/preço/link.
- WhatsApp: inicialização, QR e reconexão simulados; dependências ausentes, desconexão antes de enviar e encerramento do socket.
- Interface no navegador: seleção em lote, bloqueio durante pausa, aprovação simulada, agendamentos, cancelamento, histórico, filtros e paginação com 61 registros (50 + 11). Configurações e tela de 390 px verificadas, sem transbordamento horizontal no cenário observado.
- Banco real: uma cópia consistente foi reaberta com a versão nova. As **19 tabelas foram comparadas registro por registro**, sem diferenças; `PRAGMA integrity_check` retornou `ok`, com a publicação pausada.

### Cobertura automatizada

`npm run test:coverage`: **83,25% das linhas, 79,16% das ramificações e 85,89% das funções** dos módulos carregados pela suíte. Exemplos: repositório 99,03%; executor 96,05%; aplicação de ofertas 94,20%; plataforma 94,45%; política de publicação 93,87%.

A medição inclui módulos do backend e da extensão carregados nos testes, inclusive o parser gerado. Não mede a cobertura do frontend nem executa o processo principal completo, a instalação real da extensão ou páginas autenticadas das lojas. Há ramos de erro e de leitura de DOM sem cobertura. Os testes de navegador acima são verificações funcionais separadas.

### Desempenho

Em cinco leituras de uma base temporária com 500 ofertas e cinco grupos, a geração da revisão passou de 1.065–1.114 ms para **251–277 ms** (mediana: 1.092 → 258 ms, redução aproximada de 76%). A melhoria reutiliza consultas SQL preparadas por conexão. A medição é local, sem acesso a lojas e sem transporte WhatsApp; não é uma promessa de latência em outros computadores.

## Limites da validação operacional

O fluxo automático nas contas afiliadas reais de Mercado Livre, Amazon e Shopee ainda precisa de validação com a extensão atualizada no navegador habitual. As contas de Amazon e Shopee dependem de cadastro/aprovação. Os adaptadores foram revisados e testados com cenários controlados; alterações de layout e ferramentas afiliadas reais podem exigir ajustes.

Não foi feito novo envio real a grupos durante a auditoria. O transporte foi simulado nos testes; conexão operacional e estado da fila são conferidos após a atualização local. Os envios reais permanecem pausados. A confirmação de recebimento real e a automação autenticada das lojas continuam como testes operacionais pendentes.

## Reproduzir

```text
npm run verify
npm run test:coverage
npm audit
npm run build:package
```

Preserve `data/` e `.env`. O backup anterior à auditoria fica separado da distribuição. O pacote gerado exclui banco, credenciais, sessão WhatsApp, dependências instaladas e dados de teste.
