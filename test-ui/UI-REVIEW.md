# Avaliação UI/UX

Critérios: skill UI UX Pro Max local; consulta UX sobre mensagens de erro, carregamento, recuperação e responsividade. Verificações executadas com Playwright e inspeção das capturas, sem conexão externa.

Fluxos já funcionais observados:

- Navegação clara entre Revisar, Envios e Configurações; etapas de configuração preservam contexto.
- Indicador de pausa, WhatsApp e navegador distingue estados operacionais. Confirmação de lote permanece bloqueada durante pausa.
- Formulário usa rótulos visíveis, validação específica com `role=alert`, conserva valores após erro e reativa o botão ao concluir a requisição.
- Falha simulada de carregamento de grupos mostra mensagem recuperável, permite repetir e não duplica o grupo no DOM.
- Layout sem overflow horizontal nas três áreas em 375px, 768px e 1440px; CSS contempla redução de movimento; modais são diálogos nativos com fechamento acessível.

Problemas reproduzidos antes das correções:

1. Em 375px, busca e filtro usam 11px. A leitura fica pequena e campos podem provocar zoom automático em navegadores móveis. Regressão exige 16px nos campos editáveis mobile.
2. Em 375px, os três controles de navegação têm 34,5px de altura. A recomendação de interação para mobile usada na revisão é 44px. Regressão exige alvos com pelo menos 44px de altura e largura.
3. Oferta manual válida sem grupos apresenta `state=ready`, `ready=false` e motivo vazio. O usuário recebe pendência sem orientação concreta. Evidência em `no-group-before.json`.

Limites: não foi executado auditor completo WCAG, leitor de tela, iOS/Safari nem medição de contraste por pixel. A ausência de overflow e os atributos presentes não certificam acessibilidade completa. Dados e grupos nas capturas são artificiais.

## Revalidação após correções

Playwright/Edge executado novamente: dez etapas passaram. Busca e filtro mobile medem 16px; os três alvos de navegação medem 44px de altura. Formulário manual também preserva campos de pelo menos16px. Não houve overflow nas nove combinações de área/tamanho, exceções JavaScript nem requisições externas. A oferta sem grupo agora retorna `state=pending` e orientação para habilitar grupo em Configurações. Evidências finais: `ui-after.json`, `ui-after.log`, `ui-metrics.json`, `no-group-after.json` e capturas.

Também foi validada recuperação após envio parcial: uma entrega marcada `sent` artificialmente somente na base temporária, outra cancelada por evidência manual vencida. A lista mantém a pendência visível; o formulário bloqueia alterações no conteúdo enviado e permite confirmar preço/estoque. Após revalidar, apenas o grupo restante fica elegível e a entrega `sent` permanece idêntica no banco. Screenshot: `partial-revalidation.png`. Nenhum transporte foi chamado.
