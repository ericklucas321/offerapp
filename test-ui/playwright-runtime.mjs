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
