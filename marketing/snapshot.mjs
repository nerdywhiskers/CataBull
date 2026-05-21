// Snapshots the demo Discover page (with the chat rail) into
// marketing/assets/hero-discover.png so the landing page can lead with the
// real new design instead of an HTML stub. The demo is fully static, so we
// serve it via file:// — no dev server needed.
//
// Run: node marketing/snapshot.mjs
// Requires: playwright (already a dev dep)

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEMO_PAGE = pathToFileURL(resolve(__dirname, 'demo', 'index.html')).href;
const OUT_DIR = resolve(__dirname, 'assets');
const OUT_FILE = resolve(OUT_DIR, 'hero-discover.png');

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});
const page = await context.newPage();
await page.goto(DEMO_PAGE, { waitUntil: 'networkidle' });
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
await page.waitForTimeout(400);
await page.screenshot({ path: OUT_FILE, fullPage: false });
await browser.close();

console.log(`Wrote ${OUT_FILE}`);
