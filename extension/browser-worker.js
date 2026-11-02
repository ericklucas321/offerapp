import { extractMarketDocument, snapshotFromDocument, webMessages } from './capture.js';
import {
  STORE_ADAPTERS,
  findProducts,
  readProduct,
  clickAffiliate,
  closeAffiliate,
  readAffiliate,
} from './store-adapters.js';

export function createBrowserWorker({
  chromeApi = globalThis.chrome,
  fetchImpl = globalThis.fetch,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
} = {}) {
  let busy = false;
  const execute = async (tabId, func, args = []) => {
    const results = await chromeApi.scripting.executeScript({ target: { tabId }, func, args });
    if (!results?.length || results[0].result == null || results[0].error)
      throw new Error('A leitura da página não retornou dados. Confira a loja.');
    if (results[0].result.error)
      throw Object.assign(new Error(results[0].result.error), { code: results[0].result.code });
    return results[0].result;
  };
  async function page(url, active = false) {
    const tab = await chromeApi.tabs.create({ url, active });
    for (let i = 0; i < 60; i++) {
      if ((await chromeApi.tabs.get(tab.id)).status === 'complete') {
        await delay(1500);
        return tab.id;
      }
      await delay(500);
    }
    throw new Error('A página da loja demorou para abrir. Confira a aba no navegador.');
  }
  async function perform(job) {
    const adapter = STORE_ADAPTERS[job.marketplace];
    if (!adapter) throw new Error('Loja não suportada.');
    const previous =
      job.kind === 'search'
        ? (await chromeApi.tabs.query({ active: true, currentWindow: true }))[0]
        : null;
    const tabId = await page(
      job.kind === 'search' ? adapter.search(job.payload.keyword) : job.payload.productUrl,
      job.kind === 'search',
    );
    let success = false;
    try {
      if (job.kind === 'search') {
        let urls;
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            urls = await execute(tabId, findProducts, [job.marketplace]);
            break;
          } catch (error) {
            if (error.message !== 'A leitura da página não retornou dados. Confira a loja.')
              throw error;
            if (attempt === 29)
              throw Object.assign(
                new Error(
                  'Os resultados da busca não carregaram em 15 segundos. Confira a aba da loja; as próximas buscas continuam programadas.',
                ),
                { code: 'search_read_failed' },
              );
            await delay(500);
          }
        }
        success = true;
        return { urls };
      }
      let observation;
      if (job.marketplace === 'mercadolivre') {
        for (let attempt = 0; attempt < 20; attempt++) {
          try {
            observation = snapshotFromDocument(
              await execute(tabId, extractMarketDocument),
              job.payload.productUrl,
            );
            break;
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
      } else observation = await execute(tabId, readProduct, [job.marketplace]);
      for (let attempt = 0; attempt < 24; attempt++) {
        try {
          await execute(tabId, clickAffiliate, [job.marketplace]);
          break;
        } catch (error) {
          if (attempt === 23) throw error;
          await delay(500);
        }
      }
      let affiliateUrl;
      for (let attempt = 0; attempt < 60; attempt++) {
        if (attempt === 30 && job.marketplace === 'mercadolivre') {
          await execute(tabId, closeAffiliate, [job.marketplace]);
          await delay(500);
          await execute(tabId, clickAffiliate, [job.marketplace]);
        }
        await delay(500);
        try {
          affiliateUrl = await execute(tabId, readAffiliate, [job.marketplace, true]);
          break;
        } catch (error) {
          if (attempt === 59)
            throw new Error(
              'O gerador afiliado não terminou de carregar em 30 segundos. Confira a aba da loja e tente novamente.',
            );
        }
      }
      success = true;
      return { observation: { ...observation, affiliateUrl, affiliateObserved: true } };
    } finally {
      if (success)
        try {
          await chromeApi.tabs.remove(tabId);
        } catch {
          /* A tab already closed by the user does not invalidate a completed read. */
        }
      if (previous?.id && previous.id !== tabId)
        try {
          await chromeApi.tabs.update(previous.id, { active: true });
        } catch {
          /* The user may have closed the previous tab. */
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
        let result;
        try {
          result = await perform(job);
        } catch (error) {
          result = {
            error: webMessages[error.message] || error.message || 'Falha ao consultar a loja.',
            ...(error.code || webMessages[error.message]
              ? { code: error.code || error.message }
              : {}),
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
                  result: { error: error.message, ...(error.code ? { code: error.code } : {}) },
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
