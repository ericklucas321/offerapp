import { extractMarketDocument, snapshotFromDocument, webMessages } from './capture.js';
import {
  STORE_ADAPTERS,
  findProducts,
  readProduct,
  clickAffiliate,
  closeAffiliate,
  readAffiliate,
} from './store-adapters.js';

const EMPTY_READ = 'A leitura da página não retornou dados. Confira a loja.';
const coded = (message, code) => Object.assign(new Error(message), { code });

// Each job runs in a dedicated minimized window, so store pages never take the user's focus.
// Every step is recorded (name, ok, ms, detail) and sent with the result for diagnosis.
export function createBrowserWorker({
  chromeApi = globalThis.chrome,
  fetchImpl = globalThis.fetch,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
  clock = () => Date.now(),
} = {}) {
  let busy = false;
  // MV3 service workers restart often; the window id is kept in storage so a restart
  // reuses the same minimized window instead of opening another one.
  const windowStore = () => chromeApi.storage?.session || chromeApi.storage?.local;
  let windowId = null;
  const execute = async (tabId, func, args = []) => {
    const results = await chromeApi.scripting.executeScript({ target: { tabId }, func, args });
    if (!results?.length || results[0].result == null || results[0].error)
      throw new Error(EMPTY_READ);
    if (results[0].result.error) throw coded(results[0].result.error, results[0].result.code);
    return results[0].result;
  };
  async function workerWindow() {
    if (!chromeApi.windows?.create) return null;
    if (windowId === null)
      try {
        const saved = (await windowStore()?.get?.('workerWindowId'))?.workerWindowId;
        if (Number.isInteger(saved)) windowId = saved;
      } catch {
        /* Storage unavailable: a new window is created below. */
      }
    if (windowId !== null)
      try {
        await chromeApi.windows.get(windowId);
        return windowId;
      } catch {
        windowId = null;
      }
    const created = await chromeApi.windows.create({
      url: 'about:blank',
      focused: false,
      state: 'minimized',
    });
    windowId = created.id;
    try {
      await windowStore()?.set?.({ workerWindowId: windowId });
    } catch {
      /* Kept in memory only. */
    }
    return windowId;
  }
  async function openTab(url) {
    let target = null;
    try {
      target = await workerWindow();
    } catch {
      target = null;
    }
    const tab = await chromeApi.tabs.create(
      target === null ? { url, active: false } : { url, windowId: target, active: true },
    );
    for (let i = 0; i < 60; i++) {
      if ((await chromeApi.tabs.get(tab.id)).status === 'complete') {
        await delay(1500);
        return tab.id;
      }
      await delay(500);
    }
    try {
      await chromeApi.tabs.remove(tab.id);
    } catch {
      /* Already closed. */
    }
    throw coded(
      'A página da loja demorou para abrir. Confira a conexão com a internet.',
      'page_timeout',
    );
  }
  // A minimized window can throttle the store page. When the affiliate generator is slow,
  // the window is restored (unfocused, behind the user's window) and minimized again after.
  let restored = false;
  async function setWindowState(state) {
    if (windowId === null || !chromeApi.windows?.update) return;
    try {
      await chromeApi.windows.update(windowId, {
        state,
        ...(state === 'normal' ? { focused: false } : {}),
      });
      restored = state === 'normal';
    } catch {
      /* The user may have closed the window. */
    }
  }
  async function perform(job, steps) {
    const step = async (name, action) => {
      const started = clock();
      try {
        const value = await action();
        steps.push({ name, ok: true, ms: clock() - started });
        return value;
      } catch (error) {
        steps.push({
          name,
          ok: false,
          ms: clock() - started,
          detail: String(webMessages[error.message] || error.message || '').slice(0, 200),
          ...(error.code || webMessages[error.message]
            ? { code: error.code || error.message }
            : {}),
        });
        throw error;
      }
    };
    const adapter = STORE_ADAPTERS[job.marketplace];
    if (!adapter) throw new Error('Loja não suportada.');
    const tabId = await step('open_page', () =>
      openTab(job.kind === 'search' ? adapter.search(job.payload.keyword) : job.payload.productUrl),
    );
    try {
      if (job.kind === 'search') {
        const urls = await step('read_search', async () => {
          for (let attempt = 0; attempt < 30; attempt++) {
            try {
              return await execute(tabId, findProducts, [job.marketplace]);
            } catch (error) {
              if (error.message !== EMPTY_READ) throw error;
              await delay(500);
            }
          }
          throw coded(
            'Os resultados da busca não carregaram em 15 segundos. As próximas buscas continuam programadas.',
            'search_read_failed',
          );
        });
        return { urls };
      }
      const observation = await step('read_product', async () => {
        if (job.marketplace !== 'mercadolivre')
          return execute(tabId, readProduct, [job.marketplace]);
        for (let attempt = 0; ; attempt++) {
          try {
            return snapshotFromDocument(
              await execute(tabId, extractMarketDocument),
              job.payload.productUrl,
            );
          } catch (error) {
            if (
              !['source_browser_price_ambiguous', 'source_browser_identity_unknown'].includes(
                error.message,
              ) ||
              attempt === 19
            )
              throw error;
            await delay(500);
          }
        }
      });
      await step('open_affiliate', async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await execute(tabId, clickAffiliate, [job.marketplace]);
          } catch (error) {
            if (attempt === 23 || error.code === 'store_login_required') throw error;
            await delay(500);
          }
        }
      });
      const affiliateUrl = await step('read_affiliate', async () => {
        for (let attempt = 0; attempt < 60; attempt++) {
          if (attempt === 30) await setWindowState('normal');
          if (attempt === 30 && job.marketplace === 'mercadolivre') {
            await execute(tabId, closeAffiliate, [job.marketplace]);
            await delay(500);
            await execute(tabId, clickAffiliate, [job.marketplace]);
          }
          await delay(500);
          try {
            return await execute(tabId, readAffiliate, [job.marketplace, true]);
          } catch {
            /* Generator still loading. */
          }
        }
        throw coded(
          'O gerador afiliado não terminou de carregar em 30 segundos.',
          'affiliate_link_timeout',
        );
      });
      return { observation: { ...observation, affiliateUrl, affiliateObserved: true } };
    } finally {
      if (restored) await setWindowState('minimized');
      try {
        await chromeApi.tabs.remove(tabId);
      } catch {
        /* A tab already closed by the user does not invalidate a completed read. */
      }
    }
  }
  async function run() {
    if (busy) return;
    busy = true;
    try {
      const { base, token } = await chromeApi.storage.local.get(['base', 'token']);
      if (
        !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base || '') ||
        !/^[a-f0-9]{64}$/.test(token || '')
      )
        return;
      const api = async (path, data) => {
        const response = await fetchImpl(base + path, {
          method: data ? 'POST' : 'GET',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          signal: AbortSignal.timeout(10000),
          ...(data ? { body: JSON.stringify(data) } : {}),
        });
        const result = await response.json();
        if (!response.ok)
          throw Object.assign(new Error(result.message || 'Falha na conexão com o Offer.'), {
            status: response.status,
            code: result.error,
          });
        return result;
      };
      for (let count = 0; count < 5; count++) {
        const { job } = await api('/api/bridge/jobs');
        if (!job) break;
        const steps = [];
        let result;
        try {
          result = { ...(await perform(job, steps)), steps };
        } catch (error) {
          result = {
            error: webMessages[error.message] || error.message || 'Falha ao consultar a loja.',
            ...(error.code || webMessages[error.message]
              ? { code: error.code || error.message }
              : {}),
            steps,
          };
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await api('/api/bridge/result', { id: job.id, result });
            break;
          } catch (error) {
            if (error.status && error.status < 500) {
              if (!result.error)
                await api('/api/bridge/result', {
                  id: job.id,
                  result: {
                    error: error.message,
                    ...(error.code ? { code: error.code } : {}),
                    steps: [
                      ...steps,
                      {
                        name: 'save_result',
                        ok: false,
                        ms: 0,
                        detail: error.message,
                        ...(error.code ? { code: error.code } : {}),
                      },
                    ],
                  },
                });
              else throw error;
              break;
            }
            if (attempt === 2) throw error;
            await delay(300 * (attempt + 1));
          }
        }
      }
    } catch (error) {
      logger.warn?.('Offer connection:', error.message);
    } finally {
      busy = false;
    }
  }
  return { run, perform };
}
