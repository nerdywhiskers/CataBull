#!/usr/bin/env node

/**
 * test-frontend-smoke.mjs — Headless render check for the dashboard.
 *
 * Boots `npm run dashboard` on a random port, points a Playwright
 * Chromium at it, and confirms:
 *   - the HTML page returns 200
 *   - no JS errors during initial render
 *   - no Content-Security-Policy violations (they show up as console
 *     errors with type "error")
 *   - the script bundle and the marked/DOMPurify vendor files load
 *
 * CI doesn't have a populated workspace, so the dashboard renders the
 * onboarding flow rather than the full app. The smoke test still
 * exercises every piece of the page that breaks easiest:
 * security middleware, static asset serving, CSP, font loading, and
 * the module bundle.
 *
 * Usage:
 *   node test-frontend-smoke.mjs
 *
 * Exits 0 on success, 1 on failure. Designed to be invoked from a
 * GitHub Actions workflow.
 */

import { spawn } from 'child_process';
import { chromium } from 'playwright';

const PORT = 3700 + Math.floor(Math.random() * 200); // 3700–3899
const BOOT_DEADLINE_MS = 30_000;
const PAGE_SETTLE_MS = 1500;

let pass = 0;
let fail = 0;
function ok(msg)  { console.log(`  ✅ ${msg}`); pass++; }
function bad(msg) { console.log(`  ❌ ${msg}`); fail++; }

function waitForBoot(port, deadlineMs) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`http://localhost:${port}/`, { redirect: 'manual' });
        if (res.status === 200) return resolve();
      } catch { /* not up yet */ }
      if (Date.now() - startedAt > deadlineMs) {
        return reject(new Error(`server did not boot within ${deadlineMs}ms`));
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

console.log(`\n🌐 frontend smoke test (port ${PORT})\n`);

const server = spawn(process.execPath, ['start.mjs'], {
  env: { ...process.env, PORT: String(PORT), CI: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// Stream server output to stdout so a failure is debuggable from the
// CI log. Prefix each line so it's obvious which side it came from.
server.stdout.on('data', (chunk) => process.stdout.write('[server] ' + chunk));
server.stderr.on('data', (chunk) => process.stderr.write('[server!] ' + chunk));

const cleanup = (code) => {
  try { server.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { server.kill('SIGKILL'); } catch {} process.exit(code); }, 500);
};
process.on('SIGINT', () => cleanup(130));

try {
  await waitForBoot(PORT, BOOT_DEADLINE_MS);
  ok(`server up on :${PORT}`);
} catch (err) {
  bad(`server failed to boot: ${err.message}`);
  cleanup(1);
}

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // Initial nav + settle.
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle', timeout: 20_000 });
  await page.waitForTimeout(PAGE_SETTLE_MS);

  // Either the onboarding container or the dashboard container should
  // end up visible. Either path proves the JS module graph executed.
  const visibility = await page.evaluate(() => {
    const onb = document.getElementById('onboarding-container');
    const dash = document.getElementById('dashboard-container');
    const css = (el) => el ? getComputedStyle(el).display : 'missing';
    return { onboarding: css(onb), dashboard: css(dash) };
  });
  const oneVisible = visibility.onboarding !== 'none' || visibility.dashboard !== 'none';
  if (oneVisible) {
    ok(`a container rendered (onboarding=${visibility.onboarding}, dashboard=${visibility.dashboard})`);
  } else {
    bad(`neither container rendered: ${JSON.stringify(visibility)}`);
  }

  // Module dependencies must be on `window` for the app to function —
  // both marked (Markdown parsing) and DOMPurify (Markdown sanitization).
  // If either is undefined, the index.html lost its <script> tag or the
  // vendor file failed to ship.
  const hasMarked = await page.evaluate(() => typeof marked !== 'undefined');
  const hasPurify = await page.evaluate(() => typeof DOMPurify !== 'undefined');
  if (hasMarked)  ok('marked loaded'); else bad('marked NOT loaded');
  if (hasPurify)  ok('DOMPurify loaded'); else bad('DOMPurify NOT loaded');

  if (consoleErrors.length === 0) {
    ok('no console errors');
  } else {
    bad(`console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log('       •', e);
  }

  if (pageErrors.length === 0) {
    ok('no uncaught page errors');
  } else {
    bad(`uncaught page errors: ${pageErrors.length}`);
    for (const e of pageErrors) console.log('       •', e);
  }

  await browser.close();
} catch (err) {
  bad(`smoke test crashed: ${err.message}`);
  try { await browser?.close(); } catch {}
}

console.log(`\n${'='.repeat(50)}`);
console.log(`📊 ${pass} passed, ${fail} failed`);
cleanup(fail > 0 ? 1 : 0);
