/**
 * scan/providers/sniff.mjs — outbound ATS link sniffer (W5)
 *
 * Pure HTML-parsing fallback used when webfetch renders a careers page
 * and finds zero jobs. The page often turns out to be a marketing
 * landing page with a "View open positions" link that points to the
 * real ATS (greenhouse.io / ashbyhq.com / lever.co / myworkdayjobs.com /
 * etc.). This module extracts every outbound <a href> from the rendered
 * HTML and matches each against the ATS provider registry's matchUrl()
 * methods. If exactly one ATS-hosted destination is found (or one is
 * clearly the primary), the scanner can auto-retry with that URL via
 * the right provider — recovering jobs that would otherwise have been
 * misclassified as `unknown_ats`.
 *
 * Pure function — accepts a raw HTML string, no Playwright dep — so
 * unit tests run without a browser. webfetch.mjs is responsible for
 * grabbing the rendered HTML via page.content() before calling here.
 *
 * See docs/archive/SCAN_RELIABILITY.md (workstream W5) for the design.
 */

import { listAtsMatchers } from './index.mjs';

// Anchor-text scoring: if a link's visible text matches one of these
// phrases, it gets a small score boost. Real careers-page CTAs usually
// say things like "View open positions" rather than appearing as a raw
// host link.
const CTA_PHRASES = [
  /\bview\s+(?:all\s+|our\s+)?(?:open\s+)?(?:job|position|role|opportunit|opening)/i,
  /\bsee\s+(?:all\s+|our\s+)?(?:job|position|role|opportunit|opening)/i,
  /\bbrowse\s+(?:all\s+|our\s+)?(?:job|position|role|opportunit|opening)/i,
  /\bcurrent\s+(?:job|position|role|opportunit|opening)/i,
  /\bopen\s+(?:job|position|role|opportunit|opening)/i,
  /\b(?:join|work)\s+(?:our\s+team|us|with\s+us)/i,
  /\bwe[''']re\s+hiring/i,
  /\bview\s+careers?\b/i,
  /\bsearch\s+(?:job|position|role|opening)/i,
  /\bapply\s+(?:now|today|here)/i,
];

// Cap on how many anchors we'll process per page. Keeps DoS-style
// pathological pages (10k+ <a>) from burning CPU.
const MAX_ANCHORS = 1000;

// Strip from the company name when normalizing for slug-similarity
// matching. Lowercase first.
const COMPANY_SUFFIXES = [
  /\s+inc\.?$/i,
  /\s+incorporated$/i,
  /\s+llc\.?$/i,
  /\s+ltd\.?$/i,
  /\s+limited$/i,
  /\s+corp\.?$/i,
  /\s+corporation$/i,
  /\s+co\.?$/i,
  /\s+gmbh$/i,
  /\s+ag$/i,
  /\s+s\.a\.?$/i,
  /\s+plc$/i,
];

function normalizeCompanyName(name) {
  let n = String(name || '').toLowerCase().trim();
  for (const re of COMPANY_SUFFIXES) {
    n = n.replace(re, '');
  }
  // Reduce non-alphanumeric to nothing (so "Wells Fargo" and "wellsfargo"
  // both reduce to the same token).
  return n.replace(/[^a-z0-9]/g, '');
}

function safeUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract all <a href="..."> links from raw HTML along with their
 * visible anchor text. Resolves relative hrefs against baseUrl.
 *
 * Returns: Array<{ href: string, text: string }>
 *
 * Exported for testing.
 */
export function extractHrefs(html, baseUrl) {
  if (!html) return [];
  const out = [];
  const re = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  let match;
  let count = 0;
  while ((match = re.exec(html)) !== null) {
    if (++count > MAX_ANCHORS) break;
    const attrs = match[1] || '';
    const inner = match[2] || '';
    const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!hrefMatch) continue;
    const rawHref = decodeEntities(hrefMatch[1] || hrefMatch[2] || hrefMatch[3] || '').trim();
    if (!rawHref) continue;
    const lower = rawHref.toLowerCase();
    if (
      lower.startsWith('javascript:') ||
      lower.startsWith('mailto:') ||
      lower.startsWith('tel:') ||
      lower.startsWith('#')
    ) continue;
    const absolute = safeUrl(rawHref, baseUrl);
    if (!absolute) continue;
    const text = stripTags(decodeEntities(inner));
    out.push({ href: absolute, text });
  }
  return out;
}

function looksLikeCta(text) {
  const t = String(text || '');
  return CTA_PHRASES.some((re) => re.test(t));
}

function scoreCandidate(candidate, normalizedCompany, anchorTexts) {
  let score = 0;

  // (1) Slug contains a token from the normalized company name. The
  // strongest single signal — a "View jobs" button at example.com
  // almost always points to the company's own ATS slug.
  const slug = String(candidate.slug || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalizedCompany && slug) {
    if (slug === normalizedCompany) score += 10;
    else if (slug.includes(normalizedCompany) || normalizedCompany.includes(slug)) score += 6;
  }

  // (2) CTA-style anchor text on at least one occurrence. Pages often
  // include the same target multiple times (header + footer + body);
  // any one of those being a CTA is a green flag.
  if (anchorTexts.some(looksLikeCta)) score += 3;

  // (3) Frequency: a target that appears in multiple places on the
  // page is more likely to be the canonical CTA than a footer "powered
  // by Greenhouse" badge.
  if (anchorTexts.length > 1) score += 1;

  return score;
}

function pickPrimary(matches) {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  // Highest score wins; ties → null (caller surfaces all candidates
  // for manual review rather than guessing).
  const sorted = [...matches].sort((a, b) => b.score - a.score);
  if (sorted[0].score === sorted[1].score) return null;
  return sorted[0];
}

/**
 * Sniff outbound ATS links from a rendered careers-page HTML.
 *
 * @param {string} html — full HTML as returned by Playwright's page.content().
 * @param {string} baseUrl — the URL the page was loaded from. Used to resolve
 *   relative hrefs and to filter same-origin self-references.
 * @param {object} [opts]
 * @param {string} [opts.companyName] — used to score slug similarity.
 *
 * @returns {{
 *   matches: Array<{
 *     provider: string,
 *     slug: string,
 *     url: string,
 *     anchorText: string,
 *     occurrences: number,
 *     score: number,
 *   }>,
 *   primary: ({ provider, slug, url, ... }) | null,
 * }}
 */
export function sniffAtsLinks(html, baseUrl, { companyName = '' } = {}) {
  const hrefs = extractHrefs(html, baseUrl);
  if (hrefs.length === 0) return { matches: [], primary: null };

  const matchers = listAtsMatchers();
  const normalizedCompany = normalizeCompanyName(companyName);

  // Group raw hits by (provider, slug) so multiple anchors pointing at
  // the same destination collapse into one candidate with the union of
  // anchor texts and a frequency count.
  const grouped = new Map();

  for (const { href, text } of hrefs) {
    // Self-referential link (the very page we just scanned linking to
    // itself) — drop, prevents infinite Phase-2 retry loops.
    if (sameOrigin(href, baseUrl) && href === baseUrl) continue;

    for (const matcher of matchers) {
      const result = matcher.matchUrl(href);
      if (!result) continue;
      const key = `${matcher.name}::${result.slug}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.anchorTexts.push(text);
        existing.occurrences += 1;
      } else {
        grouped.set(key, {
          provider: matcher.name,
          slug: result.slug,
          url: href,
          anchorTexts: [text],
          occurrences: 1,
          extra: result, // tenant/shard/site for Workday, etc.
        });
      }
      break; // first matching provider wins per href
    }
  }

  const matches = Array.from(grouped.values()).map((c) => ({
    provider: c.provider,
    slug: c.slug,
    url: c.url,
    anchorText: c.anchorTexts.find((t) => looksLikeCta(t)) || c.anchorTexts.find((t) => t) || '',
    occurrences: c.occurrences,
    score: scoreCandidate(c, normalizedCompany, c.anchorTexts),
    ...(c.extra && (c.extra.tenant || c.extra.shard || c.extra.site)
      ? { tenant: c.extra.tenant, shard: c.extra.shard, site: c.extra.site }
      : {}),
  }));

  // Sort matches by score descending so callers consuming `matches[0]`
  // (e.g. "show top suggestion") get the best candidate first.
  matches.sort((a, b) => b.score - a.score);

  const primary = pickPrimary(matches);
  return { matches, primary };
}
