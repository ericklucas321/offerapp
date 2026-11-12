import { CAPTURE_PROTOCOL } from './capture-protocol.js';
const $ = (id) => document.getElementById(id);
const names = { mercadolivre: 'Mercado Livre', amazon: 'Amazon', shopee: 'Shopee' };
const labels = {
  queued: 'Agendado',
  sending: 'Enviando',
  sent: 'Enviado',
  cancelled: 'Cancelado',
  failed: 'Falha',
  uncertain: 'Conferir resultado',
};
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const safeUrl = (v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? esc(u.href) : '';
  } catch {
    return '';
  }
};
const money = (v) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v / 100);
const date = (v) =>
  v
    ? new Date(v).toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
const time = (v) =>
  `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
const minutes = (v) => {
  const [h, m] = v.split(':').map(Number);
  return h * 60 + m;
};
let section = 'offers',
  filter = 'all',
  page = 0,
  view = {},
  items = [],
  pendingItems = null,
  settingsTab = 'connections',
  settingsRendered = false,
  deliveryFilter = 'active',
  deliveryCursor = null,
  polling = false,
  refreshPromise = null,
  timer,
  packet,
  batch,
  extensionId,
  pairingUntil = 0,
  detailRequest = 0,
  toastTimer;
const selected = new Map(),
  pageSize = 20,
  deliveryCursors = [];
function toast(message, bad = false) {
  clearTimeout(toastTimer);
  $('toastText').textContent = message;
  $('toast').classList.toggle('error', bad);
  $('toast').hidden = false;
  if (!bad) toastTimer = setTimeout(() => ($('toast').hidden = true), 6500);
}
async function api(path, data) {
  const response = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(12000),
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const body = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(body.message || 'Não foi possível concluir a operação.'), {
      code: body.error,
    });
  return body;
}
async function act(button, fn) {
  if (button.disabled || button.hasAttribute('aria-busy')) return;
  const originalText = button.textContent;
  const busyText =
    button.dataset.busy ||
    {
      pairExtension: 'Conectando extensão…',
      connectWa: 'Conectando WhatsApp…',
      loadGroups: 'Carregando grupos…',
      pauseButton: 'Atualizando envios…',
      searchToggle: 'Atualizando busca…',
      reviewBatch: 'Preparando revisão…',
      confirmBatch: 'Aprovando lote…',
      confirmCapture: 'Adicionando capturas…',
      copyDetail: 'Copiando…',
      discardDetail: 'Descartando…',
    }[button.id] ||
    (button.type === 'submit' ? 'Salvando…' : 'Processando…');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = busyText;
  try {
    await fn();
  } catch (error) {
    toast(error.message || 'Confira a conexão com o Offer.', true);
  } finally {
    button.removeAttribute('aria-busy');
    if (button.textContent === busyText) button.textContent = originalText;
    button.disabled = button.dataset.saved === 'true';
    syncActionStates();
  }
}
function actionState(button, text, disabled = false) {
  if (!button || button.hasAttribute('aria-busy')) return;
  button.textContent = text;
  button.disabled = disabled;
}
function syncActionStates() {
  syncCaptureConnection();
  if ($('automaticStatus'))
    $('automaticStatus').textContent = view.automatic ? 'Ligado' : 'Desligado';
  actionState($('pauseButton'), view.publicationPaused ? 'Retomar envios' : 'Pausar envios');
  actionState(
    $('searchToggle'),
    view.platform?.searchEnabled ? 'Pausar busca' : 'Ativar busca contínua',
  );
  actionState($('reviewBatch'), `Revisar lote (${selected.size})`, selected.size === 0);
  actionState($('confirmBatch'), 'Confirmar aprovação', !batch || !!view.publicationPaused);
  actionState($('confirmCapture'), 'Adicionar à revisão', !packet);
  if (section === 'deliveries') {
    actionState($('deliveryPrevious'), '← Anterior', deliveryCursors.length === 0);
    actionState($('deliveryNext'), 'Próxima →', !view.pagination?.nextCursor);
  }
  if (section === 'settings' && settingsTab === 'connections') updateConnectionStatus();
}
function markSaved(form, label) {
  const button = form.querySelector('button[type=submit]');
  button.dataset.saved = 'true';
  button.textContent = label;
  button.disabled = true;
}
function bindSaveFeedback(form, label) {
  const changed = () => {
    const button = form.querySelector('button[type=submit]');
    if (button.dataset.saved !== 'true') return;
    delete button.dataset.saved;
    if (!button.hasAttribute('aria-busy')) actionState(button, label);
  };
  form.addEventListener('input', changed);
  form.addEventListener('change', changed);
}
function showDialog(id) {
  if (!$(id).open) $(id).showModal();
}
function groups() {
  return (view.platform?.groups || []).filter((g) => g.enabled);
}
function groupNames(ids) {
  return ids.map((id) => groups().find((g) => g.id === id)?.name || id).join(', ');
}
function image(url) {
  return safeUrl(url)
    ? `<img class="product-image" src="${safeUrl(url)}" alt="" loading="lazy">`
    : '<span class="product-image image-placeholder" aria-hidden="true">▧</span>';
}
function empty(title, description, action = '') {
  return `<div class="empty-state"><strong>${esc(title)}</strong><p>${esc(description)}</p>${action}</div>`;
}
function header() {
  const wa = view.whatsapp?.state === 'connected';
  $('operationStatus').textContent = view.publicationPaused
    ? 'Envios pausados'
    : wa
      ? view.automatic
        ? 'Automático ligado'
        : 'Envios aprovados liberados'
      : 'WhatsApp precisa de atenção';
  $('connectionDetail').textContent =
    `${wa ? 'WhatsApp conectado' : 'WhatsApp desconectado'} · ${groups().length} grupo(s) ativo(s) · ${view.platform?.bridgeConnected ? 'Navegador conectado' : 'Navegador não conectado'}`;
  $('queueCount').textContent = view.queue?.queued || 0;
  syncActionStates();
  $('listDescription').textContent = view.platform?.searchEnabled
    ? view.platform.searchBlockedReason
      ? `Busca impedida · ${view.platform.searchBlockedReason}`
      : !view.platform.bridgeConnected
        ? 'Busca aguardando o navegador conectado.'
        : `Busca a cada 30 minutos · ${view.platform.pendingJobs} leitura(s) em andamento · ${view.automatic ? 'envio automático' : 'envio após aprovação'}${view.platform.lastSearchError ? ' · Última leitura falhou: ' + view.platform.lastSearchError : ''}`
    : 'A busca contínua está pausada.';
}
function filtered() {
  const query = $('searchInput').value.trim().toLocaleLowerCase('pt-BR'),
    store = $('storeFilter').value;
  return items.filter(
    (i) =>
      (filter === 'all' || (filter === 'ready' ? i.ready : !i.ready)) &&
      (store === 'all' || i.marketplace === store) &&
      (!query || i.title.toLocaleLowerCase('pt-BR').includes(query)),
  );
}
function visibleItems() {
  return filtered().slice(page * pageSize, (page + 1) * pageSize);
}
function selectionState() {
  document.querySelector('.batch-bar').classList.toggle('idle', selected.size === 0);
  $('selectionCount').textContent = selected.size
    ? `${selected.size} oferta(s) selecionada(s)`
    : 'Nenhuma oferta selecionada';
  $('selectionHelp').textContent = selected.size
    ? 'Confira mensagens e destinos antes de liberar os envios.'
    : 'Selecione as ofertas prontas para revisar o lote.';
  actionState($('reviewBatch'), `Revisar lote (${selected.size})`, selected.size === 0);
  $('clearSelection').hidden = !selected.size;
  const selectable = visibleItems().filter((i) => i.ready && i.id);
  $('selectPage').checked = selectable.length > 0 && selectable.every((i) => selected.has(i.id));
  $('selectPage').indeterminate =
    selectable.some((i) => selected.has(i.id)) && !$('selectPage').checked;
  $('selectPage').disabled = !selectable.length;
}
let lastRenderKey = '';
const productHeader = (item) =>
  `<div class="detail-product">${image(item.imageUrl)}<div><h3>${esc(item.title)}</h3><strong>${money(item.priceCents)}</strong><small>${esc(names[item.marketplace])} · ${date(item.observedAt)}</small></div></div>`;
function renderOffers() {
  lastRenderKey = JSON.stringify([items, view.platform]);
  const all = filtered();
  page = Math.min(page, Math.max(0, Math.ceil(all.length / pageSize) - 1));
  const rows = visibleItems();
  $('readyCount').textContent = items.filter((i) => i.ready).length;
  $('pendingCount').textContent = items.filter((i) => !i.ready).length;
  $('reviewCount').textContent = items.length;
  document
    .querySelectorAll('[data-filter]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
  $('offerRows').innerHTML = rows.length
    ? rows
        .map((i) => {
          const destinations = selected.get(i.id)?.groupIds || i.suggestedGroups || [];
          return `<article class="offer-row ${selected.has(i.id) ? 'selected' : ''}">
      <div class="product-cell"><input type="checkbox" data-select="${i.id || ''}" aria-label="Selecionar ${esc(i.title)}" ${!i.ready || !i.id ? 'disabled' : ''} ${selected.has(i.id) ? 'checked' : ''}>${image(i.imageUrl)}<div class="product-text"><span class="product-title">${esc(i.title)}</span><small>${esc(names[i.marketplace])}${i.variant ? ' · ' + esc(i.variant) : ''}</small></div></div>
      <div class="price-cell"><strong>${money(i.priceCents)}</strong><small>${date(i.observedAt)}</small></div>
      <div class="status-cell"><span class="badge ${i.ready ? '' : 'pending'}">${i.ready ? 'Pronta para revisar' : 'Pendente'}</span><small class="${i.ready ? 'group-label' : ''}">${esc(i.ready ? (destinations.length ? groupNames(destinations) : 'Escolha os grupos no detalhe') : i.reason)}</small></div>
      <button class="row-open" data-detail="${i.id ? 'offer:' + i.id : 'capture:' + i.captureId}" aria-label="Conferir ${esc(i.title)}">↗</button></article>`;
        })
        .join('')
    : empty(
        items.length ? 'Nenhuma oferta neste filtro' : 'Sua próxima oferta começa aqui.',
        items.length
          ? 'Ajuste os filtros para encontrar outras sugestões.'
          : 'Conecte o navegador e configure seus temas. As sugestões aparecerão aqui para sua revisão.',
        items.length ? '' : '<button data-go-settings>Configurar operação →</button>',
      );
  $('pageInfo').textContent = all.length
    ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, all.length)} de ${all.length} ofertas`
    : '0 ofertas';
  $('previousPage').disabled = page === 0;
  $('nextPage').disabled = (page + 1) * pageSize >= all.length;
  const needs =
    !view.platform?.bridgeConnected ||
    !groups().length ||
    !(view.platform?.topics || []).length ||
    !view.platform?.connections.some((c) => c.state === 'ready');
  $('setupGuide').hidden = !needs;
  if (needs) {
    const step = !view.platform?.bridgeConnected
      ? 'Conecte a extensão para buscar e atualizar produtos.'
      : !view.platform.connections.some((c) => c.state === 'ready')
        ? 'Valide uma loja com um produto real da sua conta afiliada.'
        : !groups().length
          ? 'Conecte o WhatsApp e escolha seus grupos.'
          : 'Defina os temas e a faixa de preço das sugestões.';
    const tab =
      !view.platform?.bridgeConnected || !view.platform.connections.some((c) => c.state === 'ready')
        ? 'connections'
        : !groups().length
          ? 'groups'
          : 'topics';
    $('setupGuide').innerHTML =
      `<div><strong>Vamos preparar sua operação?</strong><p>${esc(step)}</p></div><button class="secondary small" data-go-settings="${tab}">Continuar configuração →</button>`;
  }
  selectionState();
}
async function navigate(next) {
  section = next;
  document
    .querySelectorAll('[data-section]')
    .forEach((b) => b.setAttribute('aria-current', b.dataset.section === next ? 'page' : 'false'));
  for (const s of ['offers', 'deliveries', 'settings']) $(s + 'View').hidden = s !== next;
  if (next === 'settings') settingsRendered = false;
  window.scrollTo(0, 0);
  await refresh();
  schedule();
}
async function refresh(force = false) {
  if (document.hidden) return;
  if (polling) {
    if (force) {
      await refreshPromise;
      return refresh(true);
    }
    return;
  }
  polling = true;
  let finishRefresh;
  refreshPromise = new Promise((resolve) => (finishRefresh = resolve));
  const current = section;
  try {
    const query = new URLSearchParams({ section: current });
    if (current === 'deliveries') {
      query.set('filter', deliveryFilter);
      query.set('group', $('deliveryGroup').value || 'all');
      if (deliveryCursor) query.set('before', deliveryCursor);
    }
    const result = await api(`/api/view?${query}`);
    if (current !== section) return;
    view = result;
    header();
    if (current === 'offers') {
      // Everything renderOffers reads from the server; unchanged polls skip the DOM rebuild.
      const renderKey = JSON.stringify([result.items, result.platform]);
      if (!force && (selected.size || $('detailDialog').open || $('batchDialog').open)) {
        if (JSON.stringify(result.items) !== JSON.stringify(items)) {
          pendingItems = result.items;
          $('newSuggestions').hidden = false;
        } else {
          pendingItems = null;
          $('newSuggestions').hidden = true;
        }
      } else if (force || renderKey !== lastRenderKey) {
        items = result.items;
        pendingItems = null;
        $('newSuggestions').hidden = true;
        renderOffers();
      }
    }
    if (current === 'deliveries') renderDeliveries();
    if (current === 'settings' && !settingsRendered) {
      renderSettings();
      settingsRendered = true;
    }
    if (current === 'settings' && settingsTab === 'connections') updateConnectionStatus();
  } catch (error) {
    $('operationStatus').textContent = 'Offer indisponível';
    toast(
      error.message === 'Failed to fetch'
        ? 'Não foi possível conectar ao Offer. Confira se o aplicativo está aberto.'
        : error.message,
      true,
    );
  } finally {
    polling = false;
    finishRefresh();
    if (current !== section) queueMicrotask(() => refresh());
  }
}
function schedule() {
  clearTimeout(timer);
  if (!document.hidden)
    timer = setTimeout(
      async () => {
        await refresh();
        schedule();
      },
      section === 'settings' && view.whatsapp?.state === 'qr' ? 3000 : 10000,
    );
}
function renderDeliveries() {
  const chosen = $('deliveryGroup').value;
  $('deliveryGroup').innerHTML =
    '<option value="all">Todos os grupos</option>' +
    (view.platform?.groups || [])
      .map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`)
      .join('');
  $('deliveryGroup').value = chosen;
  const states = {
    active: ['queued', 'sending'],
    attention: ['failed', 'uncertain'],
    history: ['sent', 'cancelled'],
  };
  const rows = (view.deliveries || []).filter(
    (d) =>
      states[deliveryFilter].includes(d.state) && (chosen === 'all' || d.destination === chosen),
  );
  $('deliveryRows').innerHTML = rows.length
    ? rows
        .map(
          (d) =>
            `<article class="delivery-row"><div><strong>${esc(d.title)}</strong><small>${esc((view.platform?.groups || []).find((g) => g.id === d.destination)?.name || d.destination)}</small></div><div>${date(d.sent_at || d.next_attempt_at)}<small>Horário de Brasília</small></div><div><span class="badge ${['failed', 'uncertain'].includes(d.state) ? 'error' : d.state === 'sent' ? '' : 'neutral'}">${esc(labels[d.state])}</span><small>${esc(d.last_error || '')}</small></div><div class="actions"><button class="secondary small" data-delivery-message="${d.id}">Mensagem</button>${['queued', 'failed'].includes(d.state) ? `<button class="text-button" data-cancel="${d.id}">Cancelar</button>` : ''}${d.state === 'uncertain' ? `<button class="secondary small" data-retry="${d.id}">Conferir resultado</button>` : ''}</div></article>`,
        )
        .join('')
    : empty(
        deliveryFilter === 'active' ? 'Sua fila está em dia.' : 'Nenhum registro aqui.',
        deliveryFilter === 'active'
          ? 'As ofertas aprovadas aparecerão aqui, organizadas por grupo.'
          : 'Os resultados desta categoria aparecerão aqui.',
      );
  $('deliveryPageInfo').textContent =
    `${rows.length} envio(s) nesta página · ${view.pagination?.total || 0} no total`;
  $('deliveryPrevious').disabled = deliveryCursors.length === 0;
  $('deliveryNext').disabled = !view.pagination?.nextCursor;
}
function groupChecks(ids, name = 'destinations', eligible = null) {
  return (
    groups()
      .map(
        (g) =>
          `<label class="check"><input type="checkbox" name="${name}" value="${esc(g.id)}" ${ids.includes(g.id) ? 'checked' : ''} ${eligible && !eligible.includes(g.id) ? 'disabled' : ''}>${esc(g.name)}${eligible && !eligible.includes(g.id) ? ' · já programado, enviado ou indisponível' : ''}</label>`,
      )
      .join('') || '<p>Configure um grupo para escolher os destinos.</p>'
  );
}
function syncCaptureConnection() {
  const button = $('resolveCapture'),
    status = $('captureResolutionStatus');
  if (!button || !status || button.hasAttribute('aria-busy')) return;
  button.disabled = !view.platform?.bridgeConnected;
  status.textContent = `${status.dataset.message || ''}${!view.platform?.bridgeConnected ? ' Conecte a extensão ao painel para validar o produto.' : ''}`;
}
function openCaptureDetail(item, request) {
  const card = item.stage !== 'product';
  $('detailTitle').textContent = card ? 'Validar produto da vitrine' : 'Validar produto capturado';
  $('detailContent').innerHTML = `
    ${productHeader(item)}
    <p class="muted">${card ? 'Dados da vitrine ainda não confirmados.' : 'Dados da captura a reconferir.'} O navegador conectado abrirá o produto para conferir preço, disponibilidade e gerar o link da sua conta afiliada.</p>
    <p id="captureResolutionStatus" role="status" aria-live="polite"></p>
    <div class="form-actions"><button id="resolveCapture" disabled>Validar produto e gerar link</button><a href="${safeUrl(item.productUrl)}" target="_blank" rel="noopener">Abrir produto ↗</a></div>
    <hr class="section-divider"><button class="text-button" id="discardDetail">Descartar sugestão</button>`;
  const content = $('detailContent').firstElementChild,
    button = $('resolveCapture'),
    status = $('captureResolutionStatus'),
    ownsDialog = () =>
      request === detailRequest &&
      content.isConnected &&
      $('detailDialog').open &&
      section === 'offers';
  let checking = false;
  const update = (busy, message, retry = false) => {
    if (!ownsDialog()) return;
    button.disabled = busy || !view.platform?.bridgeConnected;
    button.toggleAttribute('aria-busy', busy);
    if (busy) button.setAttribute('aria-busy', 'true');
    button.textContent = busy
      ? 'Validando produto e gerando link…'
      : retry
        ? 'Tentar novamente: validar produto e gerar link'
        : 'Validar produto e gerar link';
    status.dataset.message = message;
    status.textContent = message;
    syncCaptureConnection();
  };
  const follow = async (result) => {
    if (!ownsDialog()) return;
    if (result.state === 'done' && result.needsRefresh) {
      update(false, result.refreshReason || 'A oferta precisa ser validada novamente.', true);
    } else if (result.state === 'done') {
      update(true, 'Produto validado. Carregando a oferta e os grupos de destino…');
      await refresh(true);
      if (!ownsDialog()) return;
      const offer = items.find((i) => i.id === result.offerId);
      if (!offer) throw new Error('Oferta validada ainda indisponível. Confira novamente.');
      await openDetail(
        offer,
        () => content.isConnected && $('detailDialog').open && section === 'offers',
      );
    } else if (['pending', 'running'].includes(result.state)) {
      update(
        true,
        'O navegador conectado está conferindo o produto e gerando seu link. Você pode fechar esta janela e acompanhar depois.',
      );
      setTimeout(() => checkResolution(), 2000);
    } else {
      const failed = ['failed', 'cancelled'].includes(result.state);
      update(
        false,
        failed
          ? result.error || 'A validação não foi concluída. Tente novamente.'
          : 'Pronto para validar pelo navegador conectado.',
        failed,
      );
    }
  };
  const checkResolution = async (start = false) => {
    if (!ownsDialog() || checking) return;
    checking = true;
    update(true, 'Conferindo validação do produto…');
    try {
      let result = await api(`/api/captures/${item.captureId}/resolution`);
      if (!ownsDialog()) return;
      if (
        start &&
        (!['pending', 'running', 'done'].includes(result.state) ||
          (result.state === 'done' && result.needsRefresh))
      ) {
        if (!view.platform?.bridgeConnected) {
          update(false, '');
          return;
        }
        result = await api(`/api/captures/${item.captureId}/resolve`, {});
        result = { ...result, state: 'pending' };
      }
      await follow(result);
    } catch (error) {
      update(false, error.message, true);
    } finally {
      checking = false;
    }
  };
  button.onclick = () => checkResolution(true);
  $('discardDetail').onclick = (e) =>
    act(e.currentTarget, async () => {
      await api('/api/review/discard', { captureId: item.captureId });
      if (ownsDialog()) $('detailDialog').close();
      await refresh(true);
    });
  showDialog('detailDialog');
  checkResolution();
  return content;
}
async function openDetail(item = null, canOpen = null) {
  const request = ++detailRequest;
  let preview = null;
  if (item?.id)
    try {
      preview = await api(`/api/offers/${item.id}/preview`);
    } catch (error) {
      if (request === detailRequest) toast(error.message, true);
      return;
    }
  if (request !== detailRequest || (canOpen && !canOpen())) return;
  if (!item?.id && item?.captureId) return openCaptureDetail(item, request);
  $('detailTitle').textContent = item ? 'Conferir oferta' : 'Adicionar oferta';
  const browser = item?.source === 'browser',
    captured = !item?.id && !!item?.captureId,
    reconfirmOnly = item?.source === 'manual' && !!preview?.offer?.published_at,
    locked = captured || browser || reconfirmOnly;
  const destinationIds = selected.get(item?.id)?.groupIds || item?.suggestedGroups || [];
  $('detailContent').innerHTML =
    `${item ? `${productHeader(item)}${!item.ready ? `<p class="inline-error">${esc(item.reason)}</p>` : ''}` : ''}
    ${reconfirmOnly ? '<p class="muted">Esta oferta já teve um envio. Confira novamente preço e estoque para aprovar os destinos restantes. O conteúdo enviado fica preservado.</p>' : ''}
    <form id="detailForm"><label>Link do produto<input name="productUrl" type="url" required value="${esc(item?.productUrl || '')}" ${locked ? 'readonly' : ''}></label><label>Título<input name="title" required maxlength="500" value="${esc(item?.title || '')}" ${reconfirmOnly ? 'readonly' : ''}></label>
    <div class="fields-row"><label class="field-label">Preço em reais<input name="price" inputmode="decimal" required value="${item ? esc((item.priceCents / 100).toFixed(2).replace('.', ',')) : ''}" ${locked ? 'readonly' : ''}></label><label class="field-label">Imagem (opcional)<input name="imageUrl" type="url" value="${esc(item?.imageUrl || '')}" ${locked ? 'readonly' : ''}></label></div>
    <label>Link da sua conta afiliada<input name="affiliateUrl" type="url" required value="${esc(item?.affiliateUrl || '')}" ${browser || reconfirmOnly ? 'readonly' : ''} placeholder="Link gerado pela loja"></label>
    ${browser ? '<p class="muted">Dados e link obtidos pelo navegador conectado. Preço e disponibilidade serão conferidos antes do envio.</p>' : '<label class="check"><input name="affiliateConfirmed" type="checkbox" required> Conferi o produto e gerei o link na minha conta.</label>'}
    ${!captured && !browser ? '<label class="check"><input name="availableConfirmed" type="checkbox" required> Conferi o preço e a disponibilidade agora.</label>' : ''}
    ${item?.priceCondition ? `<p class="muted">Condição de pagamento confirmada: <strong>${esc(item.priceCondition)}</strong>. Essa informação acompanha a mensagem.</p>` : ''}<label>Observação (opcional)<textarea name="note" maxlength="1000" ${reconfirmOnly ? 'readonly' : ''}>${esc(item?.note || '')}</textarea></label>
    <p id="detailError" class="inline-error" role="alert" hidden></p>
    <div class="form-actions"><button type="submit" ${captured && !item.canPrepare ? 'disabled' : ''}>${reconfirmOnly ? 'Revalidar preço e estoque' : 'Salvar e atualizar mensagem'}</button>${item?.productUrl ? `<a href="${safeUrl(item.productUrl)}" target="_blank" rel="noopener">Abrir produto ↗</a>` : ''}</div></form>
    ${preview ? `<hr class="section-divider"><h3>Mensagem</h3><pre class="message-preview">${esc(preview.message)}</pre><h3>Grupos de destino</h3><div id="detailDestinations" class="check-list">${groupChecks(destinationIds, 'destinations', item.eligibleGroups || null)}</div><div class="form-actions"><button id="selectDetail" ${!item.ready ? 'disabled' : ''}>Selecionar para o lote</button><button class="secondary" id="copyDetail">Copiar mensagem</button></div>` : ''}
    ${item ? '<hr class="section-divider"><button class="text-button" id="discardDetail">Descartar sugestão</button>' : ''}`;
  $('detailForm').addEventListener('submit', (e) => {
    e.preventDefault();
    act(e.submitter, async () => {
      const submittedForm = e.currentTarget,
        f = submittedForm.elements,
        data = {
          productUrl: f.productUrl.value,
          title: f.title.value,
          price: f.price.value,
          imageUrl: f.imageUrl.value,
          affiliateUrl: f.affiliateUrl.value,
          affiliateConfirmed: browser || !!f.affiliateConfirmed?.checked,
          availableConfirmed: !!f.availableConfirmed?.checked,
          note: f.note.value,
        };
      const route = captured
        ? `/api/captures/${item.captureId}/prepare`
        : item?.id
          ? `/api/offers/${item.id}/edit`
          : '/api/offers';
      try {
        const r = await api(route, data);
        selected.delete(item?.id);
        const ownsDialog = submittedForm.isConnected && $('detailDialog').open;
        if (ownsDialog) $('detailDialog').close();
        await refresh(true);
        if (ownsDialog && submittedForm.isConnected && !$('detailDialog').open) {
          const savedForm = await openDetail(items.find((i) => i.id === r.offer.id));
          if (savedForm?.isConnected) markSaved(savedForm, 'Alterações salvas');
        }
        toast('Oferta salva. Confira a mensagem e os destinos.');
      } catch (error) {
        if (submittedForm.isConnected) {
          const detailError = submittedForm.querySelector('#detailError');
          detailError.textContent = error.message;
          detailError.hidden = false;
        }
        throw error;
      }
    });
  });
  bindSaveFeedback(
    $('detailForm'),
    reconfirmOnly ? 'Revalidar preço e estoque' : 'Salvar e atualizar mensagem',
  );
  if ($('selectDetail'))
    $('selectDetail').onclick = () => {
      const ids = [...$('detailDestinations').querySelectorAll('input:checked:not(:disabled)')].map(
        (e) => e.value,
      );
      if (!ids.length) {
        toast('Escolha pelo menos um grupo.', true);
        return;
      }
      selected.set(item.id, { offerId: item.id, groupIds: ids });
      $('detailDialog').close();
      renderOffers();
      toast('Oferta selecionada para o lote.');
    };
  if ($('copyDetail'))
    $('copyDetail').onclick = (e) =>
      act(e.currentTarget, async () => {
        const button = $('copyDetail');
        try {
          await navigator.clipboard.writeText(preview.message);
        } catch {
          throw new Error('Selecione o texto da mensagem para copiar.');
        }
        button.textContent = 'Mensagem copiada';
        toast('Mensagem copiada.');
      });
  if ($('discardDetail'))
    $('discardDetail').onclick = (e) =>
      act(e.currentTarget, async () => {
        const form = $('detailForm');
        await api('/api/review/discard', { offerId: item.id, captureId: item.captureId });
        selected.delete(item.id);
        if (form.isConnected) $('detailDialog').close();
        await refresh(true);
        toast('Sugestão descartada.');
      });
  showDialog('detailDialog');
  return $('detailForm');
}
async function previewBatch() {
  batch = await api('/api/review/preview', { selection: [...selected.values()] });
  $('batchSummary').textContent =
    `${batch.count} oferta(s) · ${batch.deliveries} envio(s). Confira as mensagens e os grupos abaixo.`;
  $('batchContent').innerHTML = batch.rows
    .map(
      (r) =>
        `<details class="batch-item" open><summary>${esc(r.title)}</summary><small>${esc(names[r.marketplace])}</small><pre class="message-preview">${esc(r.message)}</pre><div class="group-chips">${r.groups.map((g) => `<span class="group-chip">${esc(g.name)} · ${time(g.start_minute)}–${time(g.end_minute)} · a cada ${g.interval_minutes} min</span>`).join('')}</div></details>`,
    )
    .join('');
  $('batchError').hidden = !view.publicationPaused;
  $('batchError').textContent = view.publicationPaused
    ? 'Os envios estão pausados. Feche esta revisão e use Retomar envios quando estiver pronto.'
    : '';
  if (!$('confirmBatch').hasAttribute('aria-busy'))
    $('confirmBatch').disabled = !!view.publicationPaused;
  showDialog('batchDialog');
}
function updateConnectionStatus() {
  const p = view.platform || {};
  if ($('pairExtension')) $('pairExtension').dataset.connected = String(!!p.bridgeConnected);
  if ($('connectWa'))
    $('connectWa').dataset.connected = String(view.whatsapp?.state === 'connected');
  if (p.bridgeConnected) pairingUntil = 0;
  const pairing = pairingUntil > Date.now();
  actionState(
    $('pairExtension'),
    p.bridgeConnected
      ? 'Extensão conectada'
      : pairing
        ? 'Conectando extensão…'
        : 'Conectar extensão',
    !!p.bridgeConnected || pairing,
  );
  if ($('bridgeHelp'))
    $('bridgeHelp').textContent = p.bridgeConnected
      ? 'A extensão está conectada a este painel. Valide as contas das lojas abaixo para começar.'
      : 'Use o navegador onde suas contas afiliadas já estão conectadas. Instale a extensão e conecte-a a este painel.';
  if ($('bridgeStatus')) {
    $('bridgeStatus').className = p.bridgeConnected ? 'badge' : 'badge neutral';
    $('bridgeStatus').textContent = p.bridgeConnected
      ? 'Navegador conectado'
      : pairing
        ? 'Aguardando confirmação da extensão'
        : 'Navegador não conectado';
  }
  const waState = view.whatsapp?.state;
  actionState(
    $('connectWa'),
    waState === 'connected'
      ? 'WhatsApp conectado'
      : waState === 'qr'
        ? 'Aguardando leitura do QR'
        : waState === 'connecting'
          ? 'Conectando WhatsApp…'
          : 'Conectar WhatsApp',
    ['connected', 'qr', 'connecting'].includes(waState),
  );
  if ($('waStatus'))
    $('waStatus').textContent =
      view.whatsapp?.state === 'connected'
        ? 'WhatsApp conectado'
        : view.whatsapp?.state === 'qr'
          ? 'Escaneie o QR com o WhatsApp'
          : waState === 'connecting'
            ? 'Aguarde a conexão com o WhatsApp'
            : 'Conecte o WhatsApp para carregar os grupos';
  if ($('waQr')) {
    $('waQr').hidden = !view.whatsapp?.qrDataUrl;
    if (view.whatsapp?.qrDataUrl) $('waQr').src = view.whatsapp.qrDataUrl;
    else $('waQr').removeAttribute('src');
  }
  if ($('waDiagnostic'))
    $('waDiagnostic').textContent = view.whatsapp?.errorMessage || view.whatsapp?.lastError || '';
  for (const connection of p.connections || []) {
    const badge = $('state-' + connection.marketplace);
    if (!badge) continue;
    badge.textContent = {
      unconfigured: 'Aguardando conexão',
      validating: 'Validando no navegador…',
      ready: 'Leitura e link confirmados',
      attention: 'Produto de teste não validado',
    }[connection.state];
    badge.className =
      'badge ' +
      (connection.state === 'ready' ? '' : connection.state === 'attention' ? 'error' : 'neutral');
    const error = $('error-' + connection.marketplace);
    error.textContent = connection.last_error;
    error.hidden = !connection.last_error;
    const button = document.querySelector(
      `[data-validate-store="${connection.marketplace}"] button`,
    );
    actionState(
      button,
      connection.state === 'validating'
        ? 'Validando conexão…'
        : connection.state === 'ready'
          ? 'Revalidar produto'
          : connection.state === 'attention'
            ? 'Testar produto novamente'
            : 'Testar produto',
      !p.bridgeConnected || connection.state === 'validating',
    );
    if (button) button.title = !p.bridgeConnected ? 'Conecte primeiro a extensão ao painel.' : '';
  }
}
function renderSettings() {
  document
    .querySelectorAll('[data-settings-tab]')
    .forEach((b) =>
      b.setAttribute('aria-current', b.dataset.settingsTab === settingsTab ? 'step' : 'false'),
    );
  const target = $('settingsContent');
  if (settingsTab === 'connections') {
    target.innerHTML = `<div class="settings-grid"><article class="settings-card"><h2>Navegador</h2><p id="bridgeHelp">Use o navegador onde suas contas afiliadas já estão conectadas. Instale a extensão e conecte-a a este painel.</p><span id="bridgeStatus" class="badge neutral"></span><div class="form-actions"><a href="/downloads/browser-extension.zip" class="secondary button-link" download>Baixar extensão</a><button id="pairExtension">Conectar extensão</button></div><details><summary>Como instalar ou atualizar</summary><p>Extraia o ZIP, abra chrome://extensions ou edge://extensions e ative o modo do desenvolvedor. Use Carregar sem compactação e selecione a pasta extraída. Depois, recarregue este painel e clique em Conectar extensão.</p></details></article><article class="settings-card"><h2>WhatsApp</h2><p id="waStatus"></p><img id="waQr" class="qr" alt="QR para conectar seu WhatsApp" hidden><p id="waDiagnostic" class="connection-warning">${esc(view.whatsapp?.lastError || '')}</p><button id="connectWa" class="secondary">${view.whatsapp?.state === 'connected' ? 'Conferir conexão' : 'Conectar WhatsApp'}</button></article></div>
    <h2>Teste das lojas</h2><p>Com sua conta afiliada aberta no navegador, teste o link da página de um produto. O Offer confere o anúncio, o menor preço total e sua condição de pagamento, a disponibilidade e o link afiliado. Isso não envia mensagens.</p>
    <div class="settings-grid">${Object.entries(names)
      .map(
        ([key, label]) =>
          `<article class="settings-card"><h3>${label}</h3><span id="state-${key}" class="badge neutral">Aguardando conexão</span><p>${key === 'mercadolivre' ? 'Entre na sua conta e confira se a ferramenta de afiliados aparece na página do produto.' : 'Conclua seu cadastro de afiliado e entre na conta antes de validar.'}</p><form data-validate-store="${key}"><label>Link de um produto<input name="productUrl" type="url" required placeholder="https://…"></label><p id="error-${key}" class="inline-error" hidden></p><button type="submit" class="secondary">Validar conexão</button></form></article>`,
      )
      .join('')}</div>`;
    $('pairExtension').onclick = (e) =>
      act(e.currentTarget, async () => {
        extensionId = null;
        window.postMessage({ source: 'offer-panel', type: 'identify' }, location.origin);
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (!extensionId)
          throw new Error('Instale ou recarregue a extensão e atualize este painel.');
        const r = await api('/api/bridge/pair', { extensionId });
        window.postMessage(
          { source: 'offer-panel', type: 'pair', token: r.token },
          location.origin,
        );
        pairingUntil = Date.now() + 15000;
        setTimeout(() => {
          if (pairingUntil && !view.platform?.bridgeConnected) {
            pairingUntil = 0;
            updateConnectionStatus();
            toast(
              'A extensão ainda não confirmou a conexão. Confira se está ativa e tente novamente.',
              true,
            );
          }
        }, 15000);
        toast('Conexão solicitada à extensão. Aguarde a confirmação.');
      });
    $('connectWa').onclick = (e) =>
      act(e.currentTarget, async () => {
        await api('/api/whatsapp/connect', {});
        await refresh(true);
        if (view.whatsapp?.state === 'disconnected' && view.whatsapp?.lastError)
          throw new Error(
            view.whatsapp.errorMessage ||
              'A conexão com o WhatsApp falhou. Confira o aviso nesta seção e tente novamente.',
          );
        toast(
          view.whatsapp?.state === 'connected'
            ? 'WhatsApp conectado.'
            : view.whatsapp?.state === 'qr'
              ? 'Escaneie o QR com o WhatsApp no celular.'
              : 'Conexão iniciada. Aguarde o QR ou a confirmação.',
        );
      });
    target.querySelectorAll('[data-validate-store]').forEach(
      (form) =>
        (form.onsubmit = (e) => {
          e.preventDefault();
          act(e.submitter, async () => {
            if (!view.platform?.bridgeConnected)
              throw new Error('Conecte primeiro a extensão ao painel.');
            await api('/api/platform/validate', {
              marketplace: form.dataset.validateStore,
              productUrl: form.elements.productUrl.value,
            });
            toast(
              'Teste enviado ao navegador. Aguarde a leitura do produto e a conferência do link afiliado.',
            );
            await refresh(true);
          });
        }),
    );
    updateConnectionStatus();
  }
  if (settingsTab === 'groups') {
    const configured = view.platform?.groups || [];
    target.innerHTML = `<article class="settings-card"><div class="card-heading"><div><h2>Grupos de destino</h2><p>Cada grupo tem seus próprios horários e intervalo. Horários de Brasília. Início igual ao fim permite o dia inteiro.</p></div><button id="loadGroups" class="secondary">Carregar grupos</button></div><div id="availableGroups"></div></article><div id="groupCards" class="settings-grid">${configured.map(groupForm).join('')}</div>`;
    $('loadGroups').onclick = (e) =>
      act(e.currentTarget, async () => {
        const availableGroups = $('availableGroups'),
          loadButton = $('loadGroups');
        const r = await api('/api/whatsapp/groups');
        if (!availableGroups.isConnected) return;
        availableGroups.innerHTML = r.groups.length
          ? `<label>Escolha um grupo<select id="newGroup"><option value="">Selecionar…</option>${r.groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select></label>`
          : '<p>Nenhum grupo encontrado nesta conta.</p>';
        if ($('newGroup'))
          $('newGroup').onchange = () => {
            const g = r.groups.find((v) => v.id === $('newGroup').value);
            if (!g) return;
            const existing = document.querySelector(`[data-group-form="${CSS.escape(g.id)}"]`);
            if (existing) {
              existing.scrollIntoView({ block: 'center' });
              existing.querySelector('input').focus();
              return;
            }
            $('groupCards').insertAdjacentHTML(
              'beforeend',
              groupForm({
                ...g,
                enabled: 1,
                start_minute: 480,
                end_minute: 1320,
                interval_minutes: 60,
              }),
            );
            bindGroups();
          };
        loadButton.textContent = 'Atualizar grupos';
        toast(
          r.groups.length
            ? `${r.groups.length} grupo(s) carregado(s). Escolha um grupo para configurar.`
            : 'Nenhum grupo encontrado nesta conta.',
        );
      });
    bindGroups();
  }
  if (settingsTab === 'topics') {
    const topics = view.platform?.topics || [];
    target.innerHTML = `<div class="settings-grid"><article class="settings-card"><h2 id="topicFormTitle">Novo tema</h2><p>Escolha o que buscar e em quais grupos essas ofertas fazem sentido.</p><form id="topicForm"><input name="id" type="hidden"><label>Nome do tema<input name="name" required maxlength="100" placeholder="Ex.: Casa e cozinha"></label><label>Palavras-chave, separadas por vírgula<input name="keywords" required placeholder="Ex.: cafeteira, panela, organizador"></label><div class="fields-row"><label class="field-label">Preço mínimo (R$)<input name="minPrice" type="number" min="0" step="0.01" value="0" required></label><label class="field-label">Preço máximo (opcional)<input name="maxPrice" type="number" min="0" step="0.01"></label></div><span class="field-label">Lojas</span><div class="check-list">${Object.entries(
      names,
    )
      .map(
        ([key, label]) =>
          `<label class="check"><input name="stores" type="checkbox" value="${key}" ${key === 'mercadolivre' ? 'checked' : ''}>${label}</label>`,
      )
      .join(
        '',
      )}</div><span class="field-label">Grupos sugeridos</span><div class="check-list">${groupChecks([], 'groupIds')}</div><label class="check"><input name="enabled" type="checkbox" checked> Tema ativo</label><div class="form-actions"><button type="submit">Salvar tema</button><button type="button" id="resetTopic" class="text-button">Limpar</button></div></form></article><div>${topics.length ? topics.map((t) => `<article class="settings-card"><div class="card-heading"><h3>${esc(t.name)}</h3><span class="badge ${t.enabled ? '' : 'neutral'}">${t.enabled ? 'Ativo' : 'Pausado'}</span></div><p>${esc(t.keywords.join(', '))}</p><small>${money(t.min_cents)}${t.max_cents !== null ? ' a ' + money(t.max_cents) : ' em diante'}<br>${esc(t.stores.map((s) => names[s]).join(' · '))}<br>${esc(groupNames(t.groupIds))}</small><div class="form-actions"><button class="secondary small" data-edit-topic="${t.id}">Editar tema</button></div></article>`).join('') : empty('Quais ofertas combinam com seu público?', 'Crie seu primeiro tema e escolha os grupos de destino.')}</div></div>`;
    const form = $('topicForm');
    target.insertAdjacentHTML(
      'afterbegin',
      `<form id="automaticForm" class="settings-card"><div class="card-heading"><h2>Pesquisa e envio automático</h2><span class="badge" id="automaticStatus">${view.automatic ? 'Ligado' : 'Desligado'}</span></div><p>Encontre produtos dos temas e envie sem aprovação individual. O Offer confere preço, estoque e link afiliado antes de enviar e respeita os horários, intervalos e limites de preço configurados.</p><label class="check"><input name="enabled" type="checkbox" ${view.automatic ? 'checked' : ''}> Pesquisar e enviar automaticamente</label><span class="field-label">Grupos autorizados para envio automático</span><div class="check-list">${groupChecks(view.platform?.automaticGroupIds || [], 'automaticGroupIds')}</div><p class="muted">A faixa de preço não comprova desconto. Produtos incompatíveis, leituras incompletas e envios incertos ficam sem publicação automática. “Pausar envios” interrompe os envios dos dois modos.</p><button type="submit" class="secondary">Salvar modo de envio</button></form>`,
    );
    const automaticForm = $('automaticForm');
    bindSaveFeedback(automaticForm, 'Salvar modo de envio');
    automaticForm.onsubmit = (e) => {
      e.preventDefault();
      act(e.submitter, async () => {
        const submittedValues = JSON.stringify([...new FormData(automaticForm)]);
        const enabled = automaticForm.elements.enabled.checked;
        const groupIds = [
          ...automaticForm.querySelectorAll('[name=automaticGroupIds]:checked'),
        ].map((c) => c.value);
        await api('/api/platform/automatic', { enabled, groupIds });
        await refresh(true);
        if (submittedValues === JSON.stringify([...new FormData(automaticForm)]))
          markSaved(automaticForm, 'Salvo');
        toast(
          enabled
            ? 'Pesquisa e envio automático ligados nos grupos selecionados.'
            : 'Envio automático desligado. As sugestões continuam disponíveis para revisão.',
        );
      });
    };
    bindSaveFeedback(form, 'Salvar tema');
    form.onsubmit = (e) => {
      e.preventDefault();
      act(e.submitter, async () => {
        const f = form.elements;
        await api('/api/platform/topics', {
          ...(f.id.value ? { id: Number(f.id.value) } : {}),
          name: f.name.value,
          keywords: f.keywords.value
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
          minCents: Math.round(Number(f.minPrice.value) * 100),
          maxCents: f.maxPrice.value ? Math.round(Number(f.maxPrice.value) * 100) : null,
          stores: [...form.querySelectorAll('[name=stores]:checked')].map((v) => v.value),
          groupIds: [...form.querySelectorAll('[name=groupIds]:checked')].map((v) => v.value),
          enabled: f.enabled.checked,
        });
        settingsRendered = false;
        await refresh(true);
        toast('Tema salvo. Será usado nos próximos ciclos de busca.');
      });
    };
    $('resetTopic').onclick = () => {
      form.reset();
      form.elements.id.value = '';
      $('topicFormTitle').textContent = 'Novo tema';
      actionState(form.querySelector('button[type=submit]'), 'Salvar tema');
    };
    target.querySelectorAll('[data-edit-topic]').forEach(
      (b) =>
        (b.onclick = () => {
          const t = topics.find((v) => v.id === Number(b.dataset.editTopic)),
            f = form.elements;
          f.id.value = t.id;
          f.name.value = t.name;
          f.keywords.value = t.keywords.join(', ');
          f.minPrice.value = t.min_cents / 100;
          f.maxPrice.value = t.max_cents === null ? '' : t.max_cents / 100;
          f.enabled.checked = !!t.enabled;
          form
            .querySelectorAll('[name=stores]')
            .forEach((c) => (c.checked = t.stores.includes(c.value)));
          form
            .querySelectorAll('[name=groupIds]')
            .forEach((c) => (c.checked = t.groupIds.includes(c.value)));
          $('topicFormTitle').textContent = 'Editar tema';
          actionState(form.querySelector('button[type=submit]'), 'Salvar alterações do tema');
          f.name.focus();
        }),
    );
  }
}
function groupForm(g) {
  return `<form class="settings-card" data-group-form="${esc(g.id)}"><h3>${esc(g.name)}</h3><label class="check"><input name="enabled" type="checkbox" ${g.enabled ? 'checked' : ''}> Receber ofertas neste grupo</label><div class="fields-row"><label class="field-label">Início<input name="start" type="time" required value="${time(g.start_minute)}"></label><label class="field-label">Fim<input name="end" type="time" required value="${time(g.end_minute)}"></label></div><label>Intervalo entre envios (minutos)<input name="interval" type="number" min="1" max="1440" required value="${g.interval_minutes}"></label><p class="muted">Alterar as regras invalida aprovações antigas deste grupo. As ofertas precisarão de nova revisão.</p><button type="submit" class="secondary">Salvar grupo</button></form>`;
}
function bindGroups() {
  document.querySelectorAll('[data-group-form]').forEach((form) => {
    if (form.dataset.bound) return;
    form.dataset.bound = 'true';
    bindSaveFeedback(form, 'Salvar grupo');
    form.onsubmit = (e) => {
      e.preventDefault();
      act(e.submitter, async () => {
        const submittedValues = JSON.stringify([...new FormData(form)]);
        const f = form.elements;
        await api('/api/platform/groups', {
          id: form.dataset.groupForm,
          enabled: f.enabled.checked,
          startMinute: minutes(f.start.value),
          endMinute: minutes(f.end.value),
          intervalMinutes: Number(f.interval.value),
        });
        await refresh(true);
        const unchanged = submittedValues === JSON.stringify([...new FormData(form)]);
        if (unchanged) markSaved(form, 'Salvo');
        toast(
          unchanged
            ? 'Grupo salvo com seus horários e intervalo.'
            : 'Grupo salvo. Há novas alterações neste formulário que ainda precisam ser salvas.',
        );
      });
    };
  });
}
document
  .querySelectorAll('[data-section]')
  .forEach((b) => (b.onclick = () => navigate(b.dataset.section)));
document.querySelectorAll('[data-settings-tab]').forEach(
  (b) =>
    (b.onclick = () => {
      settingsTab = b.dataset.settingsTab;
      renderSettings();
    }),
);
document.querySelectorAll('[data-filter],[data-quick-filter]').forEach(
  (b) =>
    (b.onclick = () => {
      filter = b.dataset.filter || b.dataset.quickFilter;
      page = 0;
      renderOffers();
    }),
);
document.querySelector('[data-open-queue]').onclick = () => navigate('deliveries');
document.querySelectorAll('[data-delivery-filter]').forEach(
  (b) =>
    (b.onclick = () => {
      deliveryFilter = b.dataset.deliveryFilter;
      document
        .querySelectorAll('[data-delivery-filter]')
        .forEach((n) => n.setAttribute('aria-pressed', String(n === b)));
      deliveryCursor = null;
      deliveryCursors.length = 0;
      refresh(true);
    }),
);
$('deliveryGroup').onchange = () => {
  deliveryCursor = null;
  deliveryCursors.length = 0;
  refresh(true);
};
$('deliveryNext').onclick = (e) =>
  act(e.currentTarget, async () => {
    deliveryCursors.push(deliveryCursor);
    deliveryCursor = view.pagination.nextCursor;
    await refresh(true);
  });
$('deliveryPrevious').onclick = (e) =>
  act(e.currentTarget, async () => {
    deliveryCursor = deliveryCursors.pop() ?? null;
    await refresh(true);
  });
$('searchInput').oninput = $('storeFilter').onchange = () => {
  page = 0;
  renderOffers();
};
$('previousPage').onclick = () => {
  page--;
  renderOffers();
};
$('nextPage').onclick = () => {
  page++;
  renderOffers();
};
$('offerRows').addEventListener('change', (e) => {
  const id = Number(e.target.dataset.select);
  if (!id) return;
  const item = items.find((i) => i.id === id);
  if (e.target.checked) {
    if (!item.suggestedGroups?.length && !selected.get(id)?.groupIds.length) {
      e.target.checked = false;
      openDetail(item);
      return;
    }
    selected.set(id, { offerId: id, groupIds: selected.get(id)?.groupIds || item.suggestedGroups });
  } else selected.delete(id);
  renderOffers();
});
$('selectPage').onchange = () => {
  const checked = $('selectPage').checked;
  for (const i of visibleItems().filter((v) => v.ready && v.id)) {
    if (checked && i.suggestedGroups?.length)
      selected.set(i.id, {
        offerId: i.id,
        groupIds: selected.get(i.id)?.groupIds || i.suggestedGroups,
      });
    else if (!checked) selected.delete(i.id);
  }
  renderOffers();
  if (checked && visibleItems().some((i) => i.ready && !i.suggestedGroups?.length))
    toast('Algumas ofertas precisam de grupos de destino. Abra os detalhes para escolher.', true);
};
$('clearSelection').onclick = () => {
  selected.clear();
  renderOffers();
};
$('newSuggestions').onclick = () => {
  selected.clear();
  if (pendingItems) items = pendingItems;
  pendingItems = null;
  $('newSuggestions').hidden = true;
  renderOffers();
};
$('newManual').onclick = (e) => act(e.currentTarget, () => openDetail());
$('pauseButton').onclick = (e) =>
  act(e.currentTarget, async () => {
    await api('/api/publication/pause', { paused: !view.publicationPaused });
    await refresh(true);
    toast(
      view.publicationPaused
        ? 'Envios pausados. A busca continua independente.'
        : 'Envios retomados. Apenas ofertas aprovadas podem sair.',
    );
  });
$('searchToggle').onclick = (e) =>
  act(e.currentTarget, async () => {
    if (
      !view.platform.searchEnabled &&
      (!view.platform.bridgeConnected ||
        !view.platform.topics.some((t) => t.enabled) ||
        !view.platform.connections.some((c) => c.state === 'ready'))
    )
      throw new Error('Conecte o navegador, valide uma loja e configure ao menos um tema ativo.');
    await api('/api/platform/search', { enabled: !view.platform.searchEnabled });
    await refresh(true);
    toast(view.platform.searchEnabled ? 'Busca contínua ativada.' : 'Novas buscas pausadas.');
  });
$('reviewBatch').onclick = (e) => act(e.currentTarget, previewBatch);
$('confirmBatch').onclick = (e) =>
  act(e.currentTarget, async () => {
    try {
      const r = await api('/api/review/approve', {
        id: batch.id,
        token: batch.token,
        confirmed: true,
      });
      $('batchDialog').close();
      selected.clear();
      await refresh(true);
      toast(`${r.count} envio(s) aprovado(s). Acompanhe na área Envios.`);
    } catch (error) {
      if (error.code === 'publication_review_changed') batch = null;
      $('batchError').textContent =
        error.code === 'publication_review_changed'
          ? 'O lote mudou. Volte e confira uma nova prévia antes de aprovar.'
          : error.message;
      $('batchError').hidden = false;
      throw error;
    }
  });
$('closeToast').onclick = () => ($('toast').hidden = true);
document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) $(close.dataset.close).close();
  const setupAction = e.target.closest('[data-go-settings]');
  if (setupAction) {
    settingsTab = setupAction.dataset.goSettings || 'connections';
    navigate('settings');
  }
  const detail = e.target.closest('[data-detail]');
  if (detail) {
    const [type, id] = detail.dataset.detail.split(':');
    act(detail, () =>
      openDetail(
        items.find((i) => (type === 'offer' ? i.id === Number(id) : i.captureId === Number(id))),
      ),
    );
  }
  const cancel = e.target.closest('[data-cancel]');
  if (cancel)
    act(cancel, async () => {
      await api(`/api/queue/${cancel.dataset.cancel}/cancel`, {});
      await refresh(true);
      toast('Envio cancelado. A oferta pode ser revisada novamente.');
    });
  const retry = e.target.closest('[data-retry]');
  if (retry)
    act(retry, async () => {
      if (
        !confirm('Confira o grupo no WhatsApp. Você confirma que esta mensagem NÃO foi recebida?')
      )
        return;
      await api(`/api/queue/${retry.dataset.retry}/retry`, { confirmedNotSent: true });
      await refresh(true);
      toast('Nova tentativa solicitada. Os dados serão verificados antes do envio.');
    });
  const message = e.target.closest('[data-delivery-message]');
  if (message) {
    const d = view.deliveries.find((v) => v.id === Number(message.dataset.deliveryMessage));
    $('detailTitle').textContent = 'Mensagem do envio';
    $('detailContent').innerHTML =
      `<p>${esc(labels[d.state])} · ${esc(groupNames([d.destination]))}</p><pre class="message-preview">${esc(d.sent_message || d.approved_message || 'Este envio antigo não tem mensagem registrada.')}</pre>`;
    showDialog('detailDialog');
  }
});
window.addEventListener('message', (event) => {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    event.data?.source !== 'offer-extension'
  )
    return;
  if (event.data.type === 'identity') extensionId = event.data.extensionId;
  if (event.data.type === 'paired') {
    toast('Extensão conectada. Agora valide as contas das lojas.');
    setTimeout(() => refresh(), 1500);
  }
});
function receiveCapture() {
  if (!location.hash.startsWith('#browser-capture=')) return;
  const raw = location.hash.slice(17);
  history.replaceState(null, '', location.pathname + location.search);
  try {
    if (raw.length > CAPTURE_PROTOCOL.maxFragmentChars) throw new Error();
    const data = JSON.parse(decodeURIComponent(raw));
    if (
      data.version !== CAPTURE_PROTOCOL.version ||
      !Array.isArray(data.items) ||
      !data.items.length ||
      data.items.length > CAPTURE_PROTOCOL.maxItems
    )
      throw new Error();
    packet = data;
    $('capturePreview').innerHTML = data.items
      .map((i) => `<li>${esc(String(i?.title || 'Produto').slice(0, 500))}</li>`)
      .join('');
    showDialog('captureDialog');
  } catch {
    toast('Captura inválida. Use a extensão na página da loja.', true);
  }
}
$('confirmCapture').onclick = (e) =>
  act(e.currentTarget, async () => {
    await api('/api/browser-import/capture', { packet, confirmed: true });
    packet = null;
    $('captureDialog').close();
    await refresh(true);
    toast('Capturas adicionadas à revisão.');
  });
window.addEventListener('hashchange', receiveCapture);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer);
  else refresh().then(schedule);
});
await refresh();
schedule();
receiveCapture();
