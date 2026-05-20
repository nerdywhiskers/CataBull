/**
 * dashboard-web/lib/security.mjs — local-only auth + CSP for the dashboard.
 *
 * The dashboard binds to 127.0.0.1, but localhost is reachable from any
 * other process on the machine — including a malicious website the user
 * happens to have open. Without a check, that page can hit /api/v1/* or
 * /api/v1/terminal/ws and drive a real CLI agent.
 *
 * This module installs three things:
 *
 *   1. A per-server-run session token. Random 32-byte hex, generated at
 *      module load. Logged once on boot.
 *   2. A cookie bootstrap: every text/html response sets `cb_session`
 *      (HttpOnly, SameSite=Strict, path=/). The browser auto-attaches it
 *      to subsequent fetch + WebSocket calls; cross-site requests don't
 *      get the cookie at all.
 *   3. A preHandler that rejects any /api/v1/* request without a valid
 *      cookie or `Authorization: Bearer <token>` header. The Bearer
 *      header is for curl / scripts; the cookie is for the browser.
 *
 * WebSocket upgrades go through the same check + an Origin allowlist.
 *
 * Companion to the Markdown sanitizer in components/markdown.mjs and the
 * CSP set below.
 */

import { randomBytes } from 'crypto';

// 32 bytes → 64 hex chars. Plenty of entropy for a localhost session.
export const SESSION_TOKEN = randomBytes(32).toString('hex');
const COOKIE_NAME = 'cb_session';

// Routes that are allowed without auth. Static assets (no /api/v1 prefix)
// are gated by Fastify's static plugin, not by us. We still reject any
// API route that doesn't match this list.
const PUBLIC_API_PATHS = new Set([
  // Reserved for future health probes — keep empty for now.
]);

// Tag a host:port pair as a same-origin destination. Browsers block
// cross-origin WebSocket handshakes from quietly carrying a cookie when
// SameSite=Strict, but a hostile page can still attempt the upgrade
// without the cookie and flood logs. The Origin header check stops that
// at the door.
function expectedOrigins(port) {
  const p = String(port);
  return new Set([
    `http://localhost:${p}`,
    `http://127.0.0.1:${p}`,
  ]);
}

function firstHeaderValue(value) {
  return String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
}

function requestHosts(req) {
  const hosts = new Set();
  const forwardedHost = firstHeaderValue(req.headers['x-forwarded-host']);
  const host = firstHeaderValue(req.headers.host);
  if (forwardedHost) hosts.add(forwardedHost);
  if (host) hosts.add(host);
  return hosts;
}

function requestOrigins(req) {
  const origins = new Set();
  for (const host of requestHosts(req)) {
    origins.add(`http://${host}`);
    origins.add(`https://${host}`);
  }
  return origins;
}

function requestWsOrigins(req, port) {
  const origins = new Set([
    `ws://localhost:${port}`,
    `ws://127.0.0.1:${port}`,
  ]);
  for (const host of requestHosts(req)) {
    origins.add(`ws://${host}`);
    origins.add(`wss://${host}`);
  }
  return origins;
}

function parseCookie(header) {
  if (!header) return {};
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function readSessionToken(req) {
  const cookies = parseCookie(req.headers.cookie);
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
}

// Constant-time-ish comparison so a timing attack from a co-resident
// process can't recover the token bit by bit. Length check is separate
// and intentionally non-constant; that's fine because the token length
// is fixed and public.
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Register the security layer with a Fastify app.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {{ port: number }} opts
 */
export function registerSecurity(app, { port }) {
  const ORIGINS = expectedOrigins(port);

  // 1. Set the session cookie on every HTML response. We only target
  //    HTML so static .js / .css / image responses don't burn cycles
  //    re-issuing it. The cookie carries the SESSION_TOKEN itself
  //    rather than a session ID — there's no DB to look up against,
  //    and the token never leaves the local machine.
  app.addHook('onSend', async (req, reply, payload) => {
    const ct = String(reply.getHeader('content-type') || '');
    if (!ct.startsWith('text/html')) return payload;
    const cookie = `${COOKIE_NAME}=${SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/`;
    reply.header('Set-Cookie', cookie);

    // Lock down what the page is allowed to load. We allow:
    //   - same-origin scripts/styles (the dashboard bundle)
    //   - Google Fonts (already in the markup)
    //   - data: URIs for inlined images (the avatar gradients use them)
    //   - inline styles for the existing `style="..."` attributes
    //   - WebSocket connections back to the same host:port
    // We deliberately do NOT allow inline scripts — even though the
    // app currently doesn't use any, this stops a future XSS from
    // executing injected <script> tags via innerHTML.
    const wsOrigins = [...requestWsOrigins(req, port)].join(' ');
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "connect-src 'self' " + wsOrigins,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
    reply.header('Content-Security-Policy', csp);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  // 2. Auth gate for /api/v1/*. Bypass: GETs to nothing — every API
  //    route requires a valid cookie or Bearer header. Static asset
  //    requests don't enter this branch (different prefix).
  app.addHook('preHandler', async (req, reply) => {
    const url = req.raw.url || '';
    if (!url.startsWith('/api/v1/')) return;
    const path = url.split('?')[0];
    if (PUBLIC_API_PATHS.has(path)) return;
    const token = readSessionToken(req);
    if (!tokensMatch(token, SESSION_TOKEN)) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // 3. WebSocket upgrade auth. @fastify/websocket fires its `preValidation`
  //    hook with the upgrade request; we reject before the socket is
  //    accepted. Two layers: the same cookie/Bearer check used for REST,
  //    and an Origin allowlist (browsers send Origin on the handshake;
  //    a missing/foreign Origin means the request didn't come from our
  //    own page).
  app.addHook('preValidation', async (req, reply) => {
    if (req.headers.upgrade?.toLowerCase() !== 'websocket') return;
    const origin = req.headers.origin || '';
    if (origin && !ORIGINS.has(origin) && !requestOrigins(req).has(origin)) {
      reply.code(403).send({ error: 'Forbidden origin' });
      return;
    }
    const token = readSessionToken(req);
    if (!tokensMatch(token, SESSION_TOKEN)) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });
}

/**
 * Print the per-run token to stdout once at boot. Lets users grab it
 * for curl / scripts without digging into source.
 */
export function logSessionToken(port) {
  console.log(`  Session token: ${SESSION_TOKEN}`);
  console.log(`  ↳ The browser cookie is set automatically when you load http://localhost:${port}/`);
  console.log(`  ↳ For curl: -H "Authorization: Bearer ${SESSION_TOKEN}"`);
}
