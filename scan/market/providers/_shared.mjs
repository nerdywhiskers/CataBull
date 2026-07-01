/**
 * Shared helpers for Level-4 market providers.
 */

export const MARKET_USER_AGENT = 'CataBull/1.0 (+https://github.com/nerdywhiskers/CataBull)';
export const MARKET_FETCH_HEADERS = {
  'user-agent': MARKET_USER_AGENT,
  'accept': 'application/json, application/rss+xml, application/xml, text/xml;q=0.9, text/plain;q=0.8, */*;q=0.5',
};

export function cleanText(value) {
  if (value == null) return '';
  return decodeEntities(
    String(value)
      .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, '$1')
      .replace(/<\/?(br|p|div|li|ul|ol|section|article|h\d)[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ).replace(/\s+/g, ' ').trim();
}

export function trimSnippet(value, max = 280) {
  const text = cleanText(value);
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function normalizeDate(value) {
  if (!value) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const dt = new Date(millis);
    return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
}

export function finalizeJob(record = {}, source) {
  const url = String(record.url || '').trim();
  const title = cleanText(record.title);
  if (!url || !title) return null;
  return {
    url,
    title,
    company: cleanText(record.company) || 'Unknown',
    location: cleanText(record.location),
    postedAt: normalizeDate(record.postedAt),
    source,
    searchSnippet: trimSnippet(record.searchSnippet),
  };
}

export function matchesQueryText(job = {}, query = '') {
  const text = String(query || '').trim().toLowerCase();
  if (!text) return true;
  const haystack = [job.title, job.company, job.location, job.searchSnippet]
    .map((value) => cleanText(value).toLowerCase())
    .filter(Boolean)
    .join(' ');
  if (!haystack) return false;
  if (haystack.includes(text)) return true;
  const tokens = text.split(/[^a-z0-9+#.]+/i).filter(Boolean);
  return tokens.length === 0 ? true : tokens.every((token) => haystack.includes(token));
}

export async function fetchText(url, { fetchImpl = globalThis.fetch, headers = {}, signal } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation unavailable');
  const response = await fetchImpl(url, {
    headers: { ...MARKET_FETCH_HEADERS, ...headers },
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return await response.text();
}

export async function fetchJson(url, opts = {}) {
  const body = await fetchText(url, opts);
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`invalid JSON from ${url}: ${err.message}`);
  }
}

export function parseRssItems(xml) {
  const text = String(xml || '');
  const items = [];
  for (const block of text.match(/<item\b[\s\S]*?<\/item>/gi) || []) {
    items.push({
      title: readXmlTag(block, 'title'),
      link: readXmlTag(block, 'link'),
      pubDate: readXmlTag(block, 'pubDate'),
      description: readXmlTag(block, 'description'),
      region: readXmlTag(block, 'region'),
      category: readXmlTag(block, 'category'),
      type: readXmlTag(block, 'type'),
    });
  }
  return items;
}

export function readXmlTag(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeEntities(match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, '$1').trim()) : '';
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_m, code) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => safeCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&hellip;/gi, '…')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—');
}

function safeCodePoint(value) {
  if (!Number.isFinite(value)) return '';
  try { return String.fromCodePoint(value); } catch { return ''; }
}
