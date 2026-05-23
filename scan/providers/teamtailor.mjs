/**
 * scan/providers/teamtailor.mjs — Teamtailor RSS feed
 *
 * Teamtailor exposes job openings at:
 *   https://{slug}.teamtailor.com/jobs.rss
 *
 * RSS XML; each <item> has <title>, <link>, <pubDate>, <description>,
 * and a <category> per department. We do a lightweight regex parse
 * rather than pull in an XML dep — the format is stable and shallow.
 */

const TEAMTAILOR_RE = /^https?:\/\/([^.]+)\.teamtailor\.com\b/i;
const FETCH_TIMEOUT_MS = 8000;

const HEADERS = {
  'Accept': 'application/rss+xml, text/xml, application/xml',
  'User-Agent': 'Mozilla/5.0 (compatible; CataBull/1.0)',
};

function teamtailorSlug(company) {
  const url = company.careers_url || '';
  const match = url.match(TEAMTAILOR_RE);
  return match ? match[1] : null;
}

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function extractTag(xml, tag) {
  // Prefer CDATA-wrapped content if present, else the plain inner.
  const cdata = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'));
  if (cdata) return cdata[1];
  const plain = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return plain ? decodeXmlEntities(plain[1]) : '';
}

function parseItems(xmlBody) {
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRe.exec(xmlBody))) {
    const block = match[1];
    items.push({
      title: extractTag(block, 'title').trim(),
      link: extractTag(block, 'link').trim(),
      pubDate: extractTag(block, 'pubDate').trim(),
      category: extractTag(block, 'category').trim(),
    });
  }
  return items;
}

async function fetchFeed(slug) {
  const url = `https://${slug}.teamtailor.com/jobs.rss`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export default {
  name: 'teamtailor',
  description: 'Teamtailor RSS feed (jobs.rss)',
  needsPlaywright: false,

  match(company) {
    return Boolean(teamtailorSlug(company));
  },

  matchUrl(href) {
    const m = String(href || '').match(TEAMTAILOR_RE);
    return m ? { slug: m[1] } : null;
  },

  buildCareersUrl(slug) {
    return `https://${slug}.teamtailor.com`;
  },

  async fetch(company) {
    const slug = teamtailorSlug(company);
    if (!slug) throw new Error('Not a Teamtailor URL');
    const xml = await fetchFeed(slug);
    const items = parseItems(xml);
    const jobs = items
      .filter((i) => i.title && i.link)
      .map((i) => ({
        title: i.title,
        url: i.link,
        company: company.name,
        location: i.category,
        postedAt: i.pubDate ? new Date(i.pubDate).toISOString().slice(0, 10) : '',
      }));
    return { jobs };
  },

  _internal: { teamtailorSlug, parseItems, decodeXmlEntities, TEAMTAILOR_RE },
};
