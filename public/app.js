// Offer panel: three screens (Ofertas, Canais, Configurar) over the local API.
const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const money = (cents) =>
  cents == null
    ? ''
    : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const time = (iso) =>
  iso
    ? new Date(iso).toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
const clock = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
const hhmm = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const minutesOf = (value) => {
  const [h, m] = String(value).split(':').map(Number);
  return h * 60 + m;
};
const cents = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text.replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(number) || number < 0) throw new Error('Informe um preço válido.');
  return Math.round(number * 100);
};

const STEP_LABELS = {
  open_page: 'Abrir página da loja',
  read_search: 'Ler resultados da busca',
  read_product: 'Ler preço e estoque do produto',
  open_affiliate: 'Abrir gerador de link de afiliado',
  read_affiliate: 'Ler o link de afiliado (meli.la)',
  save_result: 'Salvar resultado no Offer',
};
const MODE_LABELS = { off: 'Não recebe', review: 'Com revisão', automatic: 'Automático' };
const DELIVERY_LABELS = {
  queued: ['Na fila', ''],
  sending: ['Enviando', ''],
  sent: ['Enviada', 'good'],
  failed: ['Falhou', 'bad'],
  uncertain: ['Confira no grupo', 'warn'],
  cancelled: ['Cancelada', 'muted'],
};

let section = 'offers';
let list = 'found';
let view = {};
let items = [];
let deliveries = [];
let deliveryCursor = null;
let waGroups = null;
let extensionId = null;
let pendingSend = null;
const selected = new Set();

async function api(path, data) {
  const response = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const body = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(body.message || 'Não foi possível concluir a operação.'), {
      code: body.error,
    });
  return body;
}
let toastTimer;
function toast(text, error = false) {
  const element = $('toast');
  element.textContent = text;
  element.className = error ? 'toast error' : 'toast';
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.hidden = true), error ? 7000 : 3500);
}
// Runs a button action with a busy state and reports errors; never leaves a button stuck.
async function act(button, fn) {
  if (button?.getAttribute('aria-busy') === 'true') return;
  button?.setAttribute('aria-busy', 'true');
  try {
    await fn();
  } catch (error) {
    toast(error.message || 'Falha inesperada.', true);
  } finally {
    button?.removeAttribute('aria-busy');
  }
}

// ---------- data ----------
async function refresh() {
  const query =
    section === 'offers' && list === 'found'
      ? 'offers'
      : section === 'channels'
        ? 'settings'
        : 'status';
  view = await api(`/api/view?section=${query}`);
  if (view.items) items = view.items.filter((i) => !['sent'].includes(i.state));
  if (section === 'offers' && list === 'deliveries') await loadDeliveries(true);
  render();
}
async function loadDeliveries(reset) {
  const page = await api(
    `/api/view?section=deliveries&filter=all${!reset && deliveryCursor ? `&before=${deliveryCursor}` : ''}`,
  );
  deliveries = reset ? page.deliveries : [...deliveries, ...page.deliveries];
  deliveryCursor = page.pagination.nextCursor;
}

// ---------- operation status and setup ----------
function setupSteps() {
  const p = view.platform || {};
  const ml = (p.connections || []).find((c) => c.marketplace === 'mercadolivre') || {};
  const groups = p.groups || [];
  return [
    {
      done: !!p.bridgeConnected,
      required: true,
      text: 'Instale e conecte a extensão do navegador',
      go: 'settings',
    },
    {
      done: ml.state === 'ready' && !ml.last_error,
      text: 'Entre na sua conta de afiliado do Mercado Livre e clique em Testar agora',
      go: 'settings',
    },
    {
      done: view.whatsapp?.state === 'connected',
      required: true,
      text: 'Conecte o WhatsApp',
      go: 'channels',
    },
    {
      done: groups.some((g) => g.mode !== 'off'),
      required: true,
      text: 'Escolha pelo menos um grupo para receber ofertas',
      go: 'channels',
    },
    {
      done: (p.topics || []).some((t) => t.enabled),
      required: true,
      text: 'Crie um tema com palavras-chave',
      go: 'settings',
    },
  ];
}
function operationText() {
  const p = view.platform || {};
  const ml = (p.connections || []).find((c) => c.marketplace === 'mercadolivre') || {};
  if (!p.operationEnabled) return 'Desligado. Ligue para pesquisar e enviar ofertas sozinho.';
  if (!p.bridgeConnected)
    return 'Atenção: a extensão não está respondendo. Abra o navegador com a extensão.';
  if (ml.state === 'attention')
    return `Atenção: ${ml.last_error || 'confira o Mercado Livre.'} O Offer testa de novo a cada 30 minutos.`;
  if (view.whatsapp?.state !== 'connected')
    return 'Atenção: WhatsApp desconectado. As ofertas ficam guardadas até reconectar.';
  if (p.pendingJobs) return `Buscando ofertas… (${p.pendingJobs} leituras na fila)`;
  const automatic = (p.groups || []).filter((g) => g.mode === 'automatic').length;
  return `Ligado. Próxima busca às ${clock(p.nextSearchAt) || '—'}. ${
    automatic
      ? `${automatic} grupo(s) recebem automaticamente.`
      : 'Nenhum grupo automático: as ofertas esperam sua revisão.'
  }`;
}
function renderOperation() {
  const p = view.platform || {};
  const steps = setupSteps();
  const missing = steps.filter((s) => !s.done);
  const on = !!p.operationEnabled;
  $('operationSwitch').setAttribute('aria-checked', String(on));
  $('operationLabel').textContent = on ? 'Ligado' : 'Desligado';
  $('operationStatus').textContent = operationText();
  // The store test is advised but not required: the first search confirms the account.
  $('operationSwitch').disabled = !on && missing.some((s) => s.required);
  $('setupSteps').hidden = !missing.length;
  $('setupSteps').innerHTML = missing.length
    ? `<li class="setup-title">Para o Offer trabalhar sozinho:</li>${steps
        .map(
          (s) =>
            `<li class="${s.done ? 'done' : ''}"><span aria-hidden="true">${s.done ? '✓' : '○'}</span> ${esc(s.text)}${s.done ? '' : ` <button class="link" data-go="${s.go}">Ir</button>`}</li>`,
        )
        .join('')}`
    : '';
  const queued = view.queue?.queued || 0;
  $('pausedBanner').hidden = !(p.publicationPaused && queued);
  $('pausedText').textContent = `Envios pausados: ${queued} oferta(s) aguardando.`;
}

// ---------- offers ----------
function offerState(item) {
  if (item.state === 'ready') return ['Pronta', 'good'];
  if (item.state === 'scheduled') return [`Na fila ${clock(item.scheduledAt)}`, ''];
  if (item.state === 'sending') return ['Enviando', ''];
  if (item.state === 'uncertain') return ['Confira no grupo', 'warn'];
  if (item.state === 'failed') return ['Falhou', 'bad'];
  return ['Pendente', 'warn'];
}
function renderOffers() {
  const ready = items.filter((i) => i.id && i.state === 'ready' && i.ready);
  for (const id of [...selected]) if (!ready.some((i) => i.id === id)) selected.delete(id);
  $('foundCount').textContent = String(items.length);
  $('selectAll').checked = ready.length > 0 && ready.every((i) => selected.has(i.id));
  $('selectAll').disabled = !ready.length;
  $('sendSelected').disabled = !selected.size;
  $('sendSelected').textContent = selected.size
    ? `Enviar selecionadas (${selected.size})`
    : 'Enviar selecionadas';
  $('offerRows').innerHTML = items.length
    ? items
        .map((item) => {
          const [label, tone] = offerState(item);
          const canSend = item.id && item.state === 'ready' && item.ready;
          return `<li class="row">
            ${canSend ? `<input type="checkbox" data-select="${item.id}" aria-label="Selecionar ${esc(item.title)}" ${selected.has(item.id) ? 'checked' : ''}>` : '<span class="row-spacer"></span>'}
            ${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="thumb"></span>'}
            <div class="row-main">
              <a href="${esc(item.productUrl)}" target="_blank" rel="noopener noreferrer" class="row-title">${esc(item.title)}</a>
              <div class="row-meta"><strong>${money(item.priceCents)}</strong> <span class="badge ${tone}">${esc(label)}</span></div>
              ${item.state !== 'ready' && item.reason ? `<p class="row-reason">${esc(item.reason)}</p>` : ''}
            </div>
            <div class="row-actions">
              ${canSend ? `<button class="small" data-send="${item.id}">Enviar</button>` : ''}
              ${!item.id && item.captureId ? `<button class="small secondary" data-resolve="${item.captureId}">Gerar link</button>` : ''}
              ${item.id ? `<button class="small secondary" data-message="${item.id}">Mensagem</button>` : ''}
              ${['ready', 'pending'].includes(item.state) ? `<button class="small secondary" data-discard="${item.id || ''}" data-capture="${item.captureId || ''}">Descartar</button>` : ''}
            </div>
          </li>`;
        })
        .join('')
    : `<li class="empty">${
        view.platform?.operationEnabled
          ? 'Nenhuma oferta ainda. O Offer está pesquisando; as encontradas aparecem aqui.'
          : 'Nenhuma oferta ainda. Ligue o Offer para começar a pesquisar.'
      }</li>`;
}
function groupName(id) {
  return (view.platform?.groups || []).find((g) => g.id === id)?.name || id;
}
function renderDeliveries() {
  $('deliveryRows').innerHTML = deliveries.length
    ? deliveries
        .map((d) => {
          const [label, tone] = DELIVERY_LABELS[d.state] || [d.state, ''];
          return `<li class="row">
            <div class="row-main">
              <span class="row-title">${esc(d.title)}</span>
              <div class="row-meta">${esc(groupName(d.destination))} · ${time(d.sent_at || d.scheduled_at || d.next_attempt_at)} <span class="badge ${tone}">${label}</span> ${d.mode === 'automatic' ? '<span class="badge muted">automático</span>' : ''}</div>
              ${d.last_error && d.state !== 'sent' ? `<p class="row-reason">${esc(d.last_error)}</p>` : ''}
            </div>
            <div class="row-actions">
              <button class="small secondary" data-delivery-message="${d.id}">Mensagem</button>
              ${['queued', 'failed'].includes(d.state) ? `<button class="small secondary" data-cancel="${d.id}">Cancelar</button>` : ''}
              ${d.state === 'uncertain' ? `<button class="small secondary" data-retry="${d.id}">Não chegou, enviar de novo</button>` : ''}
            </div>
          </li>`;
        })
        .join('')
    : '<li class="empty">Nenhum envio ainda.</li>';
  $('moreDeliveries').hidden = !deliveryCursor;
}
async function openSend(offerIds) {
  const groups = (view.platform?.groups || []).filter((g) => g.mode !== 'off');
  if (!groups.length) throw new Error('Escolha um grupo para receber ofertas em Canais.');
  const selection = offerIds
    .map((offerId) => {
      const item = items.find((i) => i.id === offerId);
      const groupIds = (item?.eligibleGroups || []).filter((id) => groups.some((g) => g.id === id));
      return { offerId, groupIds };
    })
    .filter((s) => s.groupIds.length);
  if (!selection.length)
    throw new Error('Essas ofertas já foram enviadas ou não podem ir para os grupos agora.');
  pendingSend = await api('/api/review/preview', { selection });
  $('sendTitle').textContent =
    pendingSend.count === 1 ? 'Enviar oferta' : `Enviar ${pendingSend.count} ofertas`;
  $('sendBody').innerHTML = pendingSend.rows
    .map(
      (row) =>
        `<div class="send-row"><strong>${esc(row.title)}</strong><p class="muted">Para: ${row.groups.map((g) => esc(g.name)).join(', ')}</p><pre class="message">${esc(row.message)}</pre></div>`,
    )
    .join('');
  $('sendError').hidden = true;
  $('sendDialog').showModal();
}

// ---------- channels ----------
function renderChannels() {
  const wa = view.whatsapp || {};
  const states = {
    connected: ['Conectado', 'good', 'Pronto para enviar aos grupos.'],
    qr: [
      'Aguardando QR',
      'warn',
      'Abra o WhatsApp no celular › Aparelhos conectados › Conectar aparelho e escaneie o QR.',
    ],
    connecting: ['Conectando', 'warn', 'Aguarde…'],
    disconnected: [
      'Desconectado',
      'bad',
      wa.errorMessage || 'Conecte o WhatsApp para enviar ofertas.',
    ],
  };
  const [label, tone, text] = states[wa.state] || states.disconnected;
  $('waBadge').textContent = label;
  $('waBadge').className = `badge ${tone}`;
  $('waText').textContent = text;
  $('waQr').hidden = !wa.qrDataUrl;
  if (wa.qrDataUrl) $('waQr').src = wa.qrDataUrl;
  $('waConnect').hidden = wa.state !== 'disconnected';
  $('waReconnect').hidden = wa.state === 'disconnected' && !wa.lastError;
  $('waLogout').hidden = wa.state === 'disconnected' && !wa.lastError;

  const editing = $('groupRows').contains(document.activeElement);
  const groups = view.platform?.groups || [];
  if (!editing)
    $('groupRows').innerHTML = groups.length
      ? groups
          .map(
            (g) => `<li class="row group-row"><form data-group="${esc(g.id)}" class="group-form">
              <strong class="group-name">${esc(g.name)}</strong>
              <label>Recebe<select name="mode">${Object.entries(MODE_LABELS)
                .map(
                  ([v, l]) =>
                    `<option value="${v}" ${g.mode === v ? 'selected' : ''}>${l}</option>`,
                )
                .join('')}</select></label>
              <label>Das<input name="start" type="time" value="${hhmm(g.start_minute)}" required></label>
              <label>Até<input name="end" type="time" value="${hhmm(g.end_minute)}" required></label>
              <label>A cada (min)<input name="interval" type="number" min="1" max="1440" value="${g.interval_minutes}" required></label>
              <div class="row-actions"><button class="small" type="submit">Salvar</button><button class="small secondary danger" type="button" data-remove-group="${esc(g.id)}">Remover</button></div>
            </form></li>`,
          )
          .join('')
      : '<li class="empty">Nenhum grupo ainda. Conecte o WhatsApp e clique em Buscar grupos.</li>';
  const saved = new Set(groups.map((g) => g.id));
  const available = (waGroups || []).filter((g) => !saved.has(g.id));
  $('availableGroups').innerHTML = waGroups
    ? available.length
      ? `<h3>Grupos do seu WhatsApp</h3><ul class="rows">${available
          .map(
            (g) =>
              `<li class="row"><div class="row-main"><span class="row-title">${esc(g.name)}</span><div class="row-meta">${g.size} participantes</div></div><div class="row-actions"><button class="small secondary" data-add-group="${esc(g.id)}">Adicionar</button></div></li>`,
          )
          .join('')}</ul>`
      : '<p class="muted">Todos os grupos do WhatsApp já foram adicionados.</p>'
    : '';
}

// ---------- settings ----------
function renderSettings() {
  const p = view.platform || {};
  $('bridgeBadge').textContent = p.bridgeConnected ? 'Conectada' : 'Não conectada';
  $('bridgeBadge').className = `badge ${p.bridgeConnected ? 'good' : 'bad'}`;
  $('pairExtension').textContent = p.bridgeConnected ? 'Conectar de novo' : 'Conectar extensão';
  const ml = (p.connections || []).find((c) => c.marketplace === 'mercadolivre') || {};
  const storeStates = {
    ready: ['Funcionando', 'good', 'O Offer pesquisa e gera links com sua conta de afiliado.'],
    attention: ['Precisa de atenção', 'bad', ml.last_error],
    validating: ['Testando', 'warn', 'Teste em andamento.'],
    unconfigured: ['Não testado', 'warn', 'Conecte a extensão para começar.'],
  };
  const [label, tone, text] = storeStates[ml.state] || storeStates.unconfigured;
  $('storeBadge').textContent = label;
  $('storeBadge').className = `badge ${tone}`;
  $('storeText').textContent = text || '';
  const test = p.diagnostic || { state: 'idle', steps: [] };
  $('runTest').textContent = test.state === 'running' ? 'Testando…' : 'Testar agora';
  $('runTest').disabled = test.state === 'running';
  $('testSteps').innerHTML =
    test.state === 'idle'
      ? ''
      : `${test.steps
          .map(
            (s) =>
              `<li class="${s.ok ? 'ok' : 'fail'}"><span aria-hidden="true">${s.ok ? '✓' : '✗'}</span> ${esc(STEP_LABELS[s.name] || s.name)} <span class="muted">${(s.ms / 1000).toFixed(1)}s</span>${s.detail ? `<br><small>${esc(s.detail)}</small>` : ''}</li>`,
          )
          .join('')}${
          test.state === 'running'
            ? '<li class="muted">Em andamento no navegador…</li>'
            : test.state === 'passed'
              ? `<li class="ok"><strong>Tudo certo: busca "${esc(test.keyword)}" e link de afiliado gerado.</strong></li>`
              : `<li class="fail"><strong>${esc(test.error || 'O teste falhou.')}</strong></li>`
        }`;

  const topics = p.topics || [];
  $('topicRows').innerHTML = topics.length
    ? topics
        .map(
          (
            t,
          ) => `<li class="row"><div class="row-main"><span class="row-title">${esc(t.name)} ${t.enabled ? '' : '<span class="badge muted">pausado</span>'}</span>
          <div class="row-meta">${t.keywords.map(esc).join(', ')} · ${money(t.min_cents) || 'R$ 0'} até ${t.max_cents == null ? 'sem limite' : money(t.max_cents)}</div></div>
          <div class="row-actions"><button class="small secondary" data-edit-topic="${t.id}">Editar</button><button class="small secondary danger" data-remove-topic="${t.id}">Excluir</button></div></li>`,
        )
        .join('')
    : '<li class="empty">Nenhum tema ainda.</li>';
}

function render() {
  for (const name of ['offers', 'channels', 'settings']) {
    $(`${name}View`).hidden = name !== section;
    document
      .querySelector(`[data-section="${name}"]`)
      .setAttribute('aria-current', name === section ? 'page' : 'false');
  }
  renderOperation();
  if (section === 'offers') {
    $('foundList').hidden = list !== 'found';
    $('deliveryList').hidden = list !== 'deliveries';
    document
      .querySelectorAll('[data-list]')
      .forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.list === list)));
    if (list === 'found') renderOffers();
    else renderDeliveries();
  }
  if (section === 'channels') renderChannels();
  if (section === 'settings') renderSettings();
}

// ---------- events ----------
function navigate(next) {
  section = next;
  render();
  refresh().catch((error) => toast(error.message, true));
}
document.querySelectorAll('[data-section]').forEach((button) => {
  button.onclick = () => navigate(button.dataset.section);
});
document.querySelectorAll('[data-list]').forEach((tab) => {
  tab.onclick = () => {
    list = tab.dataset.list;
    render();
    refresh().catch((error) => toast(error.message, true));
  };
});
$('operationSwitch').onclick = (e) =>
  act(e.currentTarget, async () => {
    const enabled = !view.platform?.operationEnabled;
    await api('/api/platform/operation', { enabled });
    await refresh();
    toast(enabled ? 'Offer ligado: pesquisando e enviando sozinho.' : 'Offer desligado.');
  });
$('resumeQueue').onclick = (e) =>
  act(e.currentTarget, async () => {
    await api('/api/publication/pause', { paused: false });
    await refresh();
    toast('Envios retomados.');
  });
$('selectAll').onchange = (e) => {
  for (const item of items.filter((i) => i.id && i.state === 'ready' && i.ready))
    if (e.target.checked) selected.add(item.id);
    else selected.delete(item.id);
  renderOffers();
};
$('sendSelected').onclick = (e) => act(e.currentTarget, () => openSend([...selected]));
$('moreDeliveries').onclick = (e) =>
  act(e.currentTarget, async () => {
    await loadDeliveries(false);
    renderDeliveries();
  });
$('confirmSend').onclick = (e) =>
  act(e.currentTarget, async () => {
    try {
      const result = await api('/api/review/approve', {
        id: pendingSend.id,
        token: pendingSend.token,
        confirmed: true,
        resume: true,
      });
      $('sendDialog').close();
      selected.clear();
      toast(`${result.count} envio(s) na fila.`);
      await refresh();
    } catch (error) {
      $('sendError').textContent = error.message;
      $('sendError').hidden = false;
    }
  });
$('copyMessage').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('messageText').textContent);
    toast('Mensagem copiada.');
  } catch {
    toast('Não foi possível copiar. Selecione o texto manualmente.', true);
  }
};
function showMessage(text) {
  $('messageText').textContent = text || '(sem mensagem)';
  $('messageDialog').showModal();
}
document.addEventListener('click', (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  const d = target.dataset;
  if (d.go) navigate(d.go);
  if (d.send) act(target, () => openSend([Number(d.send)]));
  if (d.message)
    act(target, async () => showMessage((await api(`/api/offers/${d.message}/preview`)).message));
  if (d.deliveryMessage) {
    const row = deliveries.find((x) => x.id === Number(d.deliveryMessage));
    showMessage(row?.sent_message || row?.approved_message);
  }
  if (d.discard !== undefined)
    act(target, async () => {
      await api(
        '/api/review/discard',
        d.discard ? { offerId: Number(d.discard) } : { captureId: Number(d.capture) },
      );
      await refresh();
      toast('Oferta descartada.');
    });
  if (d.resolve)
    act(target, async () => {
      await api(`/api/captures/${d.resolve}/resolve`, {});
      toast('Gerando o link pelo navegador. A oferta atualiza em instantes.');
    });
  if (d.cancel)
    act(target, async () => {
      await api(`/api/queue/${d.cancel}/cancel`, {});
      await refresh();
      toast('Envio cancelado.');
    });
  if (d.retry)
    act(target, async () => {
      if (!confirm('Confira o grupo: a mensagem realmente não chegou? Ela será enviada de novo.'))
        return;
      await api(`/api/queue/${d.retry}/retry`, { confirmedNotSent: true });
      await refresh();
      toast('Envio colocado na fila novamente.');
    });
  if (d.addGroup)
    act(target, async () => {
      await api('/api/platform/groups', { id: d.addGroup, mode: 'review' });
      await refresh();
      toast('Grupo adicionado com revisão. Mude para Automático quando quiser.');
    });
  if (d.removeGroup)
    act(target, async () => {
      if (!confirm('Remover este grupo? Os envios na fila para ele serão cancelados.')) return;
      await api('/api/platform/groups/delete', { id: d.removeGroup });
      await refresh();
      toast('Grupo removido.');
    });
  if (d.editTopic) {
    const topic = view.platform.topics.find((t) => t.id === Number(d.editTopic));
    const f = $('topicForm').elements;
    f.topicId.value = topic.id;
    f.topicName.value = topic.name;
    f.keywords.value = topic.keywords.join(', ');
    f.min.value = topic.min_cents ? String(topic.min_cents / 100).replace('.', ',') : '';
    f.max.value = topic.max_cents == null ? '' : String(topic.max_cents / 100).replace('.', ',');
    f.enabled.checked = !!topic.enabled;
    $('topicFormTitle').textContent = `Editar tema: ${topic.name}`;
    f.topicName.focus();
  }
  if (d.removeTopic)
    act(target, async () => {
      if (!confirm('Excluir este tema? As ofertas já encontradas continuam na lista.')) return;
      await api('/api/platform/topics/delete', { id: Number(d.removeTopic) });
      await refresh();
      toast('Tema excluído.');
    });
});
document.addEventListener('change', (event) => {
  const id = event.target.dataset?.select;
  if (!id) return;
  if (event.target.checked) selected.add(Number(id));
  else selected.delete(Number(id));
  renderOffers();
});
document.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-group]');
  if (!form) return;
  event.preventDefault();
  act(event.submitter, async () => {
    await api('/api/platform/groups', {
      id: form.dataset.group,
      mode: form.elements.mode.value,
      startMinute: minutesOf(form.elements.start.value),
      endMinute: minutesOf(form.elements.end.value),
      intervalMinutes: Number(form.elements.interval.value),
    });
    document.activeElement?.blur();
    await refresh();
    toast('Grupo salvo.');
  });
});
$('waConnect').onclick = (e) =>
  act(e.currentTarget, async () => {
    await api('/api/whatsapp/connect', {});
    await refresh();
  });
$('waReconnect').onclick = (e) =>
  act(e.currentTarget, async () => {
    await api('/api/whatsapp/reconnect', {});
    await refresh();
    toast('Reconectando o WhatsApp…');
  });
$('waLogout').onclick = (e) =>
  act(e.currentTarget, async () => {
    if (!confirm('Desconectar este WhatsApp? Para voltar, será preciso ler o QR de novo.')) return;
    await api('/api/whatsapp/logout', {});
    waGroups = null;
    await refresh();
    toast('WhatsApp desconectado.');
  });
$('loadGroups').onclick = (e) =>
  act(e.currentTarget, async () => {
    waGroups = (await api('/api/whatsapp/groups')).groups;
    renderChannels();
  });
window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'offer-extension') return;
  if (event.data.type === 'identity') extensionId = event.data.extensionId;
  if (event.data.type === 'paired') toast('Extensão conectada.');
});
$('pairExtension').onclick = (e) =>
  act(e.currentTarget, async () => {
    extensionId = null;
    window.postMessage({ source: 'offer-panel', type: 'identify' }, location.origin);
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (!extensionId)
      throw new Error('Extensão não encontrada. Instale ou recarregue a extensão e esta página.');
    const { token } = await api('/api/bridge/pair', { extensionId });
    window.postMessage({ source: 'offer-panel', type: 'pair', token }, location.origin);
    toast('Conexão enviada à extensão. Ela confirma em alguns segundos.');
  });
$('runTest').onclick = (e) =>
  act(e.currentTarget, async () => {
    await api('/api/platform/test', { marketplace: 'mercadolivre' });
    await refresh();
    toast('Teste iniciado no navegador. Acompanhe as etapas abaixo.');
  });
$('topicForm').onsubmit = (event) => {
  event.preventDefault();
  const f = event.target.elements;
  act(event.submitter, async () => {
    try {
      const keywords = f.keywords.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!f.topicName.value.trim()) throw new Error('Informe o nome do tema.');
      if (!keywords.length) throw new Error('Informe pelo menos uma palavra-chave.');
      const minCents = cents(f.min.value) ?? 0;
      const maxCents = cents(f.max.value);
      if (maxCents !== null && maxCents < minCents)
        throw new Error('O preço máximo precisa ser maior que o mínimo.');
      await api('/api/platform/topics', {
        ...(f.topicId.value ? { id: Number(f.topicId.value) } : {}),
        name: f.topicName.value.trim(),
        keywords,
        stores: ['mercadolivre'],
        minCents,
        maxCents,
        enabled: f.enabled.checked,
      });
      $('topicError').hidden = true;
      resetTopic();
      await refresh();
      toast('Tema salvo.');
    } catch (error) {
      $('topicError').textContent = error.message;
      $('topicError').hidden = false;
    }
  });
};
function resetTopic() {
  const form = $('topicForm');
  form.reset();
  form.elements.topicId.value = '';
  $('topicFormTitle').textContent = 'Novo tema';
  $('topicError').hidden = true;
}
$('resetTopic').onclick = resetTopic;

refresh().catch((error) => toast(error.message, true));
setInterval(() => {
  if (document.hidden || document.querySelector('dialog[open]')) return;
  refresh().catch(() => {
    $('operationStatus').textContent =
      'Sem conexão com o Offer. Confira se o aplicativo está aberto.';
  });
}, 5000);
