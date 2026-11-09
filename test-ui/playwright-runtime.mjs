import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export async function loadPlaywright() {
  if (process.env.OFFER_PLAYWRIGHT_PATH)
    return import(pathToFileURL(path.resolve(process.env.OFFER_PLAYWRIGHT_PATH)).href);
  try {
    return await import('playwright');
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    const bundled = path.join(
      os.homedir(),
      '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs',
    );
    try {
      return await import(pathToFileURL(bundled).href);
    } catch (fallbackError) {
      throw new Error(
        'Playwright indisponível. Use uma instalação existente ou defina OFFER_PLAYWRIGHT_PATH para playwright/index.mjs.',
        { cause: fallbackError },
      );
    }
  }
}

// OFFER_BROWSER_CHANNEL escolhe o navegador (padrão: msedge). Use "chromium"
// para o Chromium que acompanha o Playwright, sem canal instalado no sistema.
export async function launchBrowser(options = {}) {
  const { chromium } = await loadPlaywright();
  const channel = process.env.OFFER_BROWSER_CHANNEL ?? 'msedge';
  return chromium.launch({
    headless: true,
    ...options,
    ...(channel && channel !== 'chromium' ? { channel } : {}),
  });
}
