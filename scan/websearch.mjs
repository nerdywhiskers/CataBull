/**
 * scan/websearch.mjs — WebSearch provider abstraction for Deep Scan Level 3.
 *
 * Three providers, swapped via env:
 *   CAREERBOT_WEBSEARCH=brave   — Brave Search API (recommended; free tier 2k req/mo)
 *   CAREERBOT_WEBSEARCH=serper  — Serper.dev (free tier 2.5k req/mo)
 *   CAREERBOT_WEBSEARCH=scrape  — DuckDuckGo HTML scrape (no key, fragile)
 *
 * API keys come from env:
 *   BRAVE_SEARCH_API_KEY
 *   SERPER_API_KEY
 *
 * Spec: Level 3 node-helper design notes.
 */

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESULTS = 20;

class WebSearchError extends Error {
  constructor(message, { code, provider } = {}) {
    super(message);
    this.code = code || 'websearch_error';
    this.provider = provider || 'unknown';
  }
}

/**
 * Pick a provider. Falls through env → explicit opt → 'scrape' default.
 * Returns `{ name, search }` where `search(query, opts)` resolves to an
 * array of `{ url, title, snippet }`.
 */
export function resolveProvider({ provider, env = process.env } = {}) {
  const requested = pickProviderName(provider, env);
  switch (requested) {
    case 'brave':  return braveProvider({ apiKey: env.BRAVE_SEARCH_API_KEY });
    case 'serper': return serperProvider({ apiKey: env.SERPER_API_KEY });
    case 'scrape':
    case 'duckduckgo':
    case 'ddg':
      return scrapeProvider();
    default:
      throw new WebSearchError(`Unknown WebSearch provider "${requested}"`, { provider: requested });
  }
}

export function pickProviderName(provider, env = process.env) {
  const explicit = String(provider || env.CAREERBOT_WEBSEARCH || '').trim().toLowerCase();
  if (explicit) return explicit;
  for (const candidate of providerOrder(env)) {
    if (candidate === 'brave' && env.BRAVE_SEARCH_API_KEY) return 'brave';
    if (candidate === 'serper' && env.SERPER_API_KEY) return 'serper';
    if (candidate === 'scrape') return 'scrape';
  }
  return 'scrape';
}

export function providerOrder(env = process.env) {
  const raw = String(env.CAREERBOT_WEBSEARCH_ORDER || 'brave,serper,scrape')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .map((p) => (p === 'ddg' || p === 'duckduckgo') ? 'scrape' : p)
    .filter(Boolean);
  const seen = new Set();
  const order = [];
  for (const provider of raw) {
    if (!['brave', 'serper', 'scrape'].includes(provider) || seen.has(provider)) continue;
    seen.add(provider);
    order.push(provider);
  }
  if (!order.includes('scrape')) order.push('scrape');
  return order.length ? order : ['brave', 'serper', 'scrape'];
}

/**
 * Public entrypoint. Resolves the provider lazily so callers don't have
 * to thread one through; tests inject `fetchImpl` (a `fetch`-shaped function)
 * to avoid live network.
 */
export async function searchWeb(query, opts = {}) {
  const provider = opts.provider && typeof opts.provider === 'object'
    ? opts.provider
    : resolveProvider({ provider: opts.provider });
  return provider.search(query, opts);
}

// ── Brave Search API ────────────────────────────────────────────────

function braveProvider({ apiKey }) {
  return {
    name: 'brave',
    async search(query, { maxResults = DEFAULT_MAX_RESULTS, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      if (!apiKey) {
        throw new WebSearchError('BRAVE_SEARCH_API_KEY not set', { code: 'missing_key', provider: 'brave' });
      }
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(20, maxResults)}`;
      const res = await fetchWithTimeout(fetchImpl, url, {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': apiKey,
        },
      }, timeoutMs);
      if (!res.ok) {
        throw new WebSearchError(`Brave Search HTTP ${res.status}`, { code: 'http_error', provider: 'brave' });
      }
      const json = await res.json();
      const items = json?.web?.results || [];
      return items.slice(0, maxResults).map((r) => ({
        url: r.url,
        title: r.title || '',
        snippet: stripHtml(r.description || ''),
      })).filter((r) => r.url);
    },
  };
}

// ── Serper.dev ──────────────────────────────────────────────────────

function serperProvider({ apiKey }) {
  return {
    name: 'serper',
    async search(query, { maxResults = DEFAULT_MAX_RESULTS, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      if (!apiKey) {
        throw new WebSearchError('SERPER_API_KEY not set', { code: 'missing_key', provider: 'serper' });
      }
      const res = await fetchWithTimeout(fetchImpl, 'https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: query, num: Math.min(100, maxResults) }),
      }, timeoutMs);
      if (!res.ok) {
        throw new WebSearchError(`Serper HTTP ${res.status}`, { code: 'http_error', provider: 'serper' });
      }
      const json = await res.json();
      const items = json?.organic || [];
      return items.slice(0, maxResults).map((r) => ({
        url: r.link,
        title: r.title || '',
        snippet: r.snippet || '',
      })).filter((r) => r.url);
    },
  };
}

// ── DuckDuckGo HTML scrape (no key, fragile) ────────────────────────

function scrapeProvider() {
  return {
    name: 'scrape',
    async search(query, { maxResults = DEFAULT_MAX_RESULTS, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetchWithTimeout(fetchImpl, url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (CareerBot scan)' },
      }, timeoutMs);
      if (res.status === 202) {
        throw new WebSearchError('DDG HTML returned HTTP 202 challenge page', { code: 'challenge', provider: 'scrape' });
      }
      if (!res.ok) {
        throw new WebSearchError(`DDG HTML HTTP ${res.status}`, { code: 'http_error', provider: 'scrape' });
      }
      const html = await res.text();
      return parseDuckDuckGoHtml(html, maxResults);
    },
  };
}

// Parses DDG's HTML results list. Best-effort — DDG occasionally adjusts the
// markup and we'd rather degrade gracefully (return what we can find) than
// throw and abort the whole scan.
export function parseDuckDuckGoHtml(html, maxResults = DEFAULT_MAX_RESULTS) {
  const results = [];
  // Each result block contains `<a class="result__a" href="…">title</a>`
  // followed by `<a class="result__snippet">snippet</a>`. We walk linked
  // pairs rather than relying on positional indexes so partial matches
  // don't drift.
  const linkRegex = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const links = [];
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    links.push({ url: cleanDdgRedirect(m[1]), title: stripHtml(m[2]) });
    if (links.length >= maxResults) break;
  }

  const snippets = [];
  while ((m = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(m[1]));
    if (snippets.length >= maxResults) break;
  }

  for (let i = 0; i < links.length; i++) {
    const { url, title } = links[i];
    if (!url) continue;
    results.push({ url, title, snippet: snippets[i] || '' });
  }
  return results;
}

// DDG wraps result URLs in a redirect like `//duckduckgo.com/l/?uddg=…`. We
// unwrap so the caller gets the real destination URL.
function cleanDdgRedirect(href) {
  try {
    if (!href) return '';
    // Some hrefs are protocol-relative; build a complete URL to use URL().
    const abs = href.startsWith('//') ? `https:${href}` : href;
    const u = new URL(abs);
    if (u.hostname.endsWith('duckduckgo.com') && u.pathname.startsWith('/l/')) {
      const real = u.searchParams.get('uddg');
      return real ? decodeURIComponent(real) : '';
    }
    return u.toString();
  } catch {
    return '';
  }
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export { WebSearchError };
