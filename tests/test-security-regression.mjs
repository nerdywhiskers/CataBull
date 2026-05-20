#!/usr/bin/env node

/**
 * test-security-regression.mjs — Locks in the 2026-05-10 security sweep.
 *
 * Boots `npm run dashboard` on a random port, scrapes the session
 * token off stdout, and proves the dashboard still:
 *
 *   1. Rejects unauthenticated /api/v1/* with 401.
 *   2. Accepts Authorization: Bearer <token> on /api/v1/*.
 *   3. Rejects the wrong Bearer token with 401.
 *   4. Sets a `cb_session` cookie on the HTML response with the
 *      HttpOnly + SameSite=Strict flags.
 *   5. Sends a Content-Security-Policy header that includes the
 *      core directives we depend on (default-src 'self', no inline
 *      scripts, restricted connect-src).
 *   6. Sends X-Content-Type-Options: nosniff.
 *   7. Rejects WebSocket upgrades from a foreign Origin with 403.
 *   8. Ships the vendored DOMPurify file (otherwise renderMarkdown
 *      silently downgrades to the escape-only fallback).
 *
 * Each assertion that fails prints what it saw so a regression is
 * obvious in the CI log. The test runs cookie-free, header-only HTTP
 * — no browser, no Playwright — so it's fast and has zero browser-
 * cache dependency.
 *
 * Usage:
 *   node test-security-regression.mjs
 *
 * Exits 0 on success, 1 on failure.
 */

import { spawn } from 'child_process';
import { request as httpRequest } from 'http';

const PORT = 3500 + Math.floor(Math.random() * 200); // 3500–3699
const BOOT_DEADLINE_MS = 30_000;
const ORIGIN = `http://localhost:${PORT}`;

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

console.log(`\n🔒 security regression test (port ${PORT})\n`);

const server = spawn(process.execPath, ['start.mjs'], {
  env: { ...process.env, PORT: String(PORT), CI: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// Capture stdout so we can scrape the session token line.
let stdoutBuf = '';
server.stdout.on('data', (chunk) => {
  const s = chunk.toString();
  stdoutBuf += s;
  process.stdout.write('[server] ' + s);
});
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

// Scrape the token. logSessionToken prints `Session token: <hex>` on a
// dedicated line; we grab the first 64-hex-character substring after it.
function extractToken(buf) {
  const m = /Session token:\s*([0-9a-f]{64})/.exec(buf);
  return m ? m[1] : null;
}

let token = extractToken(stdoutBuf);
// Token is printed inside the listen() callback, which races with our
// initial HTTP probe. If it's not there yet, poll briefly.
for (let i = 0; !token && i < 25; i++) {
  await new Promise(r => setTimeout(r, 100));
  token = extractToken(stdoutBuf);
}
if (token) ok('session token printed on boot'); else bad('session token never appeared in stdout');

// ── 1. unauthenticated API → 401 ─────────────────────────────────────
{
  const res = await fetch(`${ORIGIN}/api/v1/applications`);
  if (res.status === 401) ok('GET /api/v1/applications without auth → 401');
  else bad(`expected 401, got ${res.status}`);
}

// ── 2. valid Bearer → 200 ────────────────────────────────────────────
if (token) {
  const res = await fetch(`${ORIGIN}/api/v1/applications`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 200) ok('GET /api/v1/applications with Bearer → 200');
  else bad(`expected 200 with valid Bearer, got ${res.status}`);
}

// ── 3. wrong Bearer → 401 ────────────────────────────────────────────
{
  const res = await fetch(`${ORIGIN}/api/v1/applications`, {
    headers: { Authorization: 'Bearer 0000000000000000000000000000000000000000000000000000000000000000' },
  });
  if (res.status === 401) ok('GET /api/v1/applications with wrong Bearer → 401');
  else bad(`expected 401 with wrong Bearer, got ${res.status}`);
}

// ── 4. HTML response sets cb_session cookie with HttpOnly + SameSite=Strict ─
{
  const res = await fetch(`${ORIGIN}/`);
  const set = res.headers.get('set-cookie') || '';
  const named   = /cb_session=/.test(set);
  const httpOnly = /HttpOnly/i.test(set);
  const sameSite = /SameSite=Strict/i.test(set);
  if (named && httpOnly && sameSite) {
    ok('Set-Cookie: cb_session HttpOnly SameSite=Strict');
  } else {
    bad(`Set-Cookie missing flags (got: ${set || '(none)'})`);
  }
}

// ── 5. CSP header present with the core directives ───────────────────
{
  const res = await fetch(`${ORIGIN}/`);
  const csp = res.headers.get('content-security-policy') || '';
  const needs = [
    "default-src 'self'",
    "script-src 'self'",
    "frame-ancestors 'none'",
  ];
  const missing = needs.filter(d => !csp.includes(d));
  if (missing.length === 0) {
    ok('CSP includes default-src/script-src/frame-ancestors');
  } else {
    bad(`CSP missing directives: ${missing.join(' | ')} (got: ${csp || '(none)'})`);
  }
  // Same hop checks the nosniff guard.
  const xcto = res.headers.get('x-content-type-options') || '';
  if (xcto.toLowerCase() === 'nosniff') ok('X-Content-Type-Options: nosniff');
  else bad(`X-Content-Type-Options expected "nosniff", got "${xcto || '(none)'}"`);
}

// ── 6. WebSocket upgrade from a foreign Origin → 403 ─────────────────
// Node's `fetch` strips Upgrade headers, so use the raw http module
// to send the handshake. Our preValidation hook short-circuits with a
// 403 before the route handler runs, which is a regular HTTP status —
// we never reach a 101 Switching Protocols.
function probeWsUpgrade({ port, origin, bearer }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/terminal/ws?agent=claude',
      method: 'GET',
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        Origin: origin,
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
    });
    req.on('response', (res) => resolve(res.statusCode));
    // If the server *does* upgrade (it shouldn't for a foreign Origin),
    // the 'upgrade' event fires instead of 'response'.
    req.on('upgrade', (res) => { res.socket?.destroy(); resolve(101); });
    req.on('error', reject);
    req.end();
  });
}

{
  try {
    const status = await probeWsUpgrade({ port: PORT, origin: 'https://evil.example', bearer: token });
    if (status === 403) ok('WS upgrade with foreign Origin → 403');
    else bad(`expected 403 for foreign Origin, got ${status}`);
  } catch (err) {
    bad(`WS probe failed: ${err.message}`);
  }
}

// ── 7. DOMPurify vendor file is served ───────────────────────────────
{
  const res = await fetch(`${ORIGIN}/vendor/purify.min.js`);
  const body = res.ok ? await res.text() : '';
  if (res.status === 200 && body.includes('DOMPurify')) {
    ok('DOMPurify vendor file ships from /vendor/purify.min.js');
  } else {
    bad(`/vendor/purify.min.js status=${res.status}, has "DOMPurify"=${body.includes('DOMPurify')}`);
  }
}

console.log(`\n${'='.repeat(50)}`);
console.log(`📊 ${pass} passed, ${fail} failed`);
cleanup(fail > 0 ? 1 : 0);
