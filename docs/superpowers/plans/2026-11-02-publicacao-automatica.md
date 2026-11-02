# Publicação automática — plano

Goal: pesquisar e publicar sem aprovação individual, autorizado em 02/11/2026, inicialmente somente no ACHADINHOS ML, usando os temas, preços, janela e intervalo atuais.

Architecture: preservar extensão, captura, evidências e fila existentes. Configuração explícita em settings com grupos autorizados. Scheduler independente do intervalo de pesquisa, uma entrega pendente por grupo. Usar mode=automatic já suportado pelo repositório e registrar o snapshot da mensagem. Revalidar regras de automação também na verificação final síncrona antes do transporte.

Tech stack: Node 24, SQLite local, extensão Chrome, Baileys existentes. Sem dependências ou IA adicionais.

Constraints: somente ofertas source=browser, tema ativo correspondente e grupo autorizado, preço dentro da faixa, título compatível com palavras-chave; evidência válida e loja pronta. Não repetir produto fora da política de 72h/queda10%, não reenviar entrega incerta ou falha esgotada. Pausa global e desligamento do automático bloqueiam novos envios. Um envio pendente por grupo evita enchimento da fila; respeitar horários/intervalo. Manter aprovação manual disponível. Não anunciar desconto sem comprovação.

- [x] 1. Testes de configuração, elegibilidade, agendamento idempotente, pausa, regras alteradas e fila real com publisher falso. Observar falha antes de implementar.
- [x] 2. Domínio automatic.mjs com configuração e elegibilidade atual; aplicação automatic-publication.mjs com scheduler. Integrar ao timer Platform e ao preflight final da PublicationPolicy.
- [x] 3. API autenticada local e controles de interface em Temas e preços; refletir estado ativo, aguardando conexão/horário e envio após aprovação quando desligado. Testar UI isolada.
- [ ] 4. Verificar backend/UI, aplicar servidor, revalidar ML e busca real com extensão 0.3.7. Ativar grupo autorizado e acompanhar um envio real completo, sem contornar desafios da loja.

Review focus: configuração editada entre seleção e transporte; duplicata em dois temas; envio incerto; preço/condição alterados na atualização; grupo fora de janela ou intervalo; falha de um produto não deve suspender pesquisas não relacionadas quando não é bloqueio de conta.

