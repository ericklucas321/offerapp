import fs from 'node:fs';
import { launchBrowser } from './playwright-runtime.mjs';
import { startFixture } from './fixture.mjs';
const f = await startFixture();
const b = await launchBrowser();
const p = await b.newPage({ viewport: { width: 375, height: 900 } });
try {
  await p.goto(f.base);
  await p.locator('#operationStatus').filter({ hasText: 'Envios pausados' }).waitFor();
  const data = await p.evaluate(() => ({
    brand: [...document.querySelectorAll('.brand, .brand *')].map((e) => ({
      text: e.textContent,
      tag: e.tagName,
      cls: e.className,
      display: getComputedStyle(e).display,
      rect: JSON.stringify(e.getBoundingClientRect().toJSON()),
    })),
    smallTargets: [...document.querySelectorAll('button,a,input,select')]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width && r.height && (r.width < 24 || r.height < 24);
      })
      .map((e) => ({
        text: e.textContent?.trim() || e.getAttribute('aria-label'),
        width: e.getBoundingClientRect().width,
        height: e.getBoundingClientRect().height,
      })),
    smallText: [...document.querySelectorAll('input,select,textarea')]
      .filter((e) => e.getBoundingClientRect().width)
      .map((e) => ({ id: e.id, size: getComputedStyle(e).fontSize })),
  }));
  fs.writeFileSync('test-ui/evidence/ux-measurements.json', JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data, null, 2));
} finally {
  await b.close();
  await f.close();
}
