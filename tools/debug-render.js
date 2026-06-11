// Diagnostica: apre la UI di Antigravity in Chromium, registra console/errori/
// richieste fallite e salva uno screenshot. Uso: node debug-render.js <url>
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const URL_TO_TEST = process.argv[2] || 'https://127.0.0.1:50569/';

function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
  const candidates = [
    path.join(base, 'chromium-1223', 'chrome-win64', 'chrome.exe'),
    path.join(base, 'chromium-1140', 'chrome-win', 'chrome.exe')
  ];
  return candidates.find((c) => fs.existsSync(c));
}

(async () => {
  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: true,
    args: ['--ignore-certificate-errors']
  });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 850 } });

  page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text().slice(0, 500)}`));
  page.on('pageerror', (e) => console.log(`[pageerror] ${String(e).slice(0, 800)}`));
  page.on('requestfailed', (r) => console.log(`[reqfail] ${r.method()} ${r.url().slice(0, 200)} -> ${r.failure() && r.failure().errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url().slice(0, 200)}`); });

  console.log('Apro ' + URL_TO_TEST);
  await page.goto(URL_TO_TEST, { waitUntil: 'domcontentloaded', timeout

: 20000 }).catch((e) => console.log('[goto] ' + e.message));
  await page.waitForTimeout(8000);

  for (const frame of page.frames()) {
    const rootInfo = await frame.evaluate(() => {
      const root = document.getElementById('root');
      return {
        rootChildren: root ? root.childElementCount : -1,
        rootHtmlLen: root ? root.innerHTML.length : -1,
        bodyText: document.body ? document.body.innerText.slice(0, 300) : '',
        title: document.title
      };
    }).catch((e) => ({ err: String(e).slice(0, 200) }));
    console.log('[dom ' + frame.url().slice(0, 80) + '] ' + JSON.stringify(rootInfo));
  }

  await page.screenshot({ path: path.join(__dirname, 'render-test.png') });
  console.log('[screenshot] salvato in tools/render-test.png');
  await browser.close();
})();
