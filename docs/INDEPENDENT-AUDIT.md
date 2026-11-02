# Independent Audit Review

Auditoria independente executada em 21/10/2026. Escopo: application, domain, jobs, HTTP, persistência e extensão. Nenhuma conta foi conectada; nenhum transporte real ou credencial foi utilizado. Reproduções utilizaram SQLite em diretórios temporários, observações fictícias e relógio injetado. O auditor não alterou código da aplicação.

## Achados confirmados antes das correções

### P1 — Oferta manual de lote expira sem caminho de revalidação na fila

Locais: `src/application/platform.mjs` (`approveBatch`, `preflight`), `src/domain/publication.mjs` (`checkOffer`), `src/infrastructure/repository.mjs` (`editOffer`).

Passos: criar duas ofertas manuais, confirmar disponibilidade e aprovar ambas para um grupo com intervalo padrão de 60 minutos. O lote reserva 15:00 e 16:00. Avançar o relógio injetado para 16:00 e executar `platform.preflight` da segunda oferta. Retorno observado: `allowed: false`, motivo `Preço antigo; atualize a captura ou os dados`. Tentar `offers.manual({...input, availableConfirmed:true}, id)` retorna `offer_not_editable`.

Impacto: os dados manuais expiram em 15 minutos, mas a fila reserva horários posteriores e fica adiando indefinidamente. É necessário cancelar, atualizar e revisar novamente; a interface deve tornar esse caminho explícito.

### P2 — Mudança de tracking bloqueia oferta do mesmo produto

Locais: `src/application/platform.mjs` (`observe`, atualização de `platform_observations`), `src/domain/publication.mjs` (`checkOffer`, comparação de `product_url`).

Passos: validar observação fictícia de `https://produto.mercadolivre.com.br/MLB-123456789-fixture`; `policy.ready` retorna `allowed: true`. Validar novamente a mesma identidade com `?tracking=changed`; `policy.ready` retorna `allowed: false`, motivo `Produto ou variante mudou; revise a oferta`.

Impacto: a URL da observação muda, enquanto a oferta conserva a URL antiga. URLs de busca e redirecionamento podem variar sem alterar o produto. É necessário preservar a identidade e invalidar aprovação quando houver alteração material, sem bloquear para sempre por tracking.

### Comportamento observado — Descarte persiste após nova captura

Local: `src/application/platform.mjs` (`observe`, busca da última oferta browser).

Passos: descartar a oferta browser e validar novamente a mesma observação. Resultado: uma oferta armazenada, zero itens visíveis. Não classificado como defeito sem decisão de produto: persistir descarte pode ser intencional e evita ressuscitar conteúdo rejeitado automaticamente.

## Validação independente inicial

Comando: Node 24 `scripts/test.mjs`.
Resultado: **103 testes, 103 aprovados, zero falhas**, duração reportada pelo runner de aproximadamente 5,7 segundos. Os dois problemas acima não eram cobertos pela suíte inicial e foram reproduzidos separadamente.

## Mercado Livre HTTP 401

A árvore ativa não contém cliente HTTP da API Mercado Livre. A integração presente lê DOM e gerador afiliado por extensão. Não foi possível reproduzir ou atribuir o 401 histórico a uma requisição concreta. Autenticação da conta da loja, permissões de afiliado e comportamento real das páginas continuam dependentes de integração autorizada. Não se deve afirmar que o erro histórico foi resolvido apenas porque os testes simulados passam.

## Limites

Sem teste real de conexão WhatsApp, persistência de credenciais de conta real, geração real de afiliados ou envio. Nenhum outro P1 confirmado nesta etapa inicial. A revisão final está registrada abaixo.

## Revisão final das alterações

Comparação independente realizada contra a base `2026-10-18/vamos-continuar-o-trabalho-no-offer/offer-machine`: revisados os diffs de inicialização/encerramento, Offers, Platform, política de publicação, mensagens HTTP, persistência de sessão WhatsApp, CSS e testes. A extensão e seus adaptadores permanecem sem alteração funcional nesta revisão.

- O P1 manual foi tratado com recusa antecipada de horários incompatíveis e rollback integral do lote; evidência vencida em fila cancela a aprovação e permite nova revisão.
- O P2 de tracking foi tratado apenas para ofertas browser, exigindo mesma loja, chave e variante. Conferência adicional direta confirmou que a origem extension conserva a validação anterior da URL e pode reservar horário futuro, dependendo de captura atualizada na execução.
- Uma reprodução adicional identificou recuperação bloqueada após envio parcial multidestino. O implementador acrescentou revalidação de evidência manual sem alterar conteúdo, somente quando não há entregas queued/sending/uncertain. Comparação profunda dos campos normalizados protege preço, título, link, imagem, cupom e identidade; published_at e histórico de entregas permanecem preservados. O teste cobre envio fora da ordem de IDs e visibilidade antes da revalidação.
- A fila inicia pausada em todo startup. Escritas de credenciais aceitas são serializadas e aguardadas no encerramento; callbacks novos de socket antigo são ignorados. Revisão não identificou sobrescrita de credenciais por callback tardio nas condições cobertas.
- Alterações dos testes anteriores são coerentes com o novo contrato de validade manual e relógios injetados; os testes de captura pontual e seu agendamento foram preservados.

Execução independente final: **113 testes, 113 aprovados, zero falhas** (`scripts/test.mjs`, aproximadamente 8,3 segundos). Verificação de sintaxe `scripts/check.mjs` aprovada. O auditor não executou Playwright nesta frente: evidências de interface são responsabilidade da frente de UI e não são alegadas como verificação independente aqui.

As correções principais não possuem P1 ou P2 remanescente confirmado nesta revisão. Não equivalem à homologação comercial das integrações reais. Permanecem dependentes de contas autorizadas: pareamento e reconexão real WhatsApp, acesso aos grupos reais, layouts e permissões de afiliados das três lojas, geração e destino real dos links, transporte real e origem do HTTP 401 histórico. Não houve envio de mensagens, uso de sessão real ou operação externa irreversível nesta auditoria.


Confirmação posterior: o achado P3 de sugestão reaparecendo após concluir todos os destinos foi corrigido com exclusão explícita de destinos que já possuem `sent`. O auditor releu o predicado SQL e executou novamente `node --test test/stability.test.mjs`: **7/7 aprovados**, incluindo envio em ordem inversa, revalidação e desaparecimento da sugestão após conclusão. Nenhum achado acionável remanescente confirmado nesta revisão. A frente de UI informou 10/10 cenários Playwright aprovados; esse resultado não foi executado pelo auditor independente.
