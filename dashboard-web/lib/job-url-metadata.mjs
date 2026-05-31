import { launchChromiumWithRetry } from '../../lib/playwright-launch.mjs';

const META_TAG_RE = /<meta\b[^>]*>/gi;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const SCRIPT_JSON_LD_RE = /<script[^>]*type=(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;
const TAG_RE = /<[^>]+>/g;
const WS_RE = /\s+/g;
const LINKEDIN_SEARCH_TITLE_RE = /(?:more than|mehr als|más de|plus de|meer dan)\s+\d+[\d,.]*\s+jobs?\s+for\b|vacatures\s+voor\b|empleos\s+de\b/i;
const LINKEDIN_GENERIC_COMPANY_RE = /\bLinkedIn\b/i;
const FETCH_HEADERS = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
};

function cleanText(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(TAG_RE, ' ')
    .replace(WS_RE, ' ')
    .trim();
}

function isUseful(text) {
  return Boolean(cleanText(text));
}

function uniqTexts(list = []) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const cleaned = cleanText(item);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function extractAttr(tag, attrName) {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  const match = tag.match(re);
  return match ? cleanText(match[2]) : '';
}

function extractMetaMap(html) {
  const meta = {};
  META_TAG_RE.lastIndex = 0;
  let match;
  while ((match = META_TAG_RE.exec(html)) !== null) {
    const tag = match[0];
    const key = extractAttr(tag, 'property') || extractAttr(tag, 'name');
    const value = extractAttr(tag, 'content');
    if (!key || !value) continue;
    meta[key.toLowerCase()] = value;
  }
  return meta;
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectJobPostingNodes(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectJobPostingNodes(item, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  const type = Array.isArray(node['@type']) ? node['@type'].join(',') : node['@type'];
  if (typeof type === 'string' && /jobposting/i.test(type)) out.push(node);
  for (const value of Object.values(node)) collectJobPostingNodes(value, out);
  return out;
}

function locationFromJobPosting(job) {
  const pieces = [];
  const addr = job?.jobLocation?.address || job?.jobLocation?.[0]?.address || job?.jobLocation?.addressRegion;
  const locality = cleanText(addr?.addressLocality || job?.jobLocation?.name || '');
  const region = cleanText(addr?.addressRegion || '');
  const country = cleanText(addr?.addressCountry || '');
  if (locality) pieces.push(locality);
  if (region && region.toLowerCase() !== locality.toLowerCase()) pieces.push(region);
  if (!pieces.length && country) pieces.push(country);
  const applicantReq = cleanText(job?.applicantLocationRequirements?.name || '');
  const base = pieces.join(', ');
  if (base && applicantReq && applicantReq.toLowerCase() !== base.toLowerCase()) return `${base} (${applicantReq})`;
  return base || applicantReq;
}

function parseJobPostingMetadataFromNodes(nodes = []) {
  const jobs = [];
  for (const node of nodes) collectJobPostingNodes(node, jobs);
  for (const job of jobs) {
    const role = cleanText(job?.title || '');
    const company = cleanText(job?.hiringOrganization?.name || '');
    const location = cleanText(locationFromJobPosting(job));
    if (role || company || location) {
      return { role, company, location, source: 'json-ld' };
    }
  }
  return null;
}

function parseJobPostingMetadata(html) {
  const nodes = [];
  SCRIPT_JSON_LD_RE.lastIndex = 0;
  let match;
  while ((match = SCRIPT_JSON_LD_RE.exec(html)) !== null) {
    const parsed = parseJsonSafe(match[2].trim());
    if (parsed) nodes.push(parsed);
  }
  return parseJobPostingMetadataFromNodes(nodes);
}

function splitCompanyLocation(text) {
  const parts = cleanText(text).split(/\s*[·|]\s*/).map(cleanText).filter(Boolean);
  if (parts.length >= 2) {
    return { company: parts[0], location: parts.slice(1).join(' · ') };
  }
  return { company: '', location: cleanText(text) };
}

function parseLinkedInTitle(title) {
  const cleaned = cleanText(title);
  if (!cleaned || LINKEDIN_SEARCH_TITLE_RE.test(cleaned)) return { role: '', company: '' };
  let candidate = cleaned.replace(/\s*\|\s*LinkedIn.*$/i, '').trim();
  if (!candidate || LINKEDIN_SEARCH_TITLE_RE.test(candidate)) return { role: '', company: '' };
  let m = candidate.match(/^(.+?)\s+-\s+(.+)$/);
  if (m) return { role: cleanText(m[1]), company: cleanText(m[2]) };
  m = candidate.match(/^(.+?),\s+(.+?)\s*$/);
  if (m) return { role: cleanText(m[1]), company: cleanText(m[2]) };
  return { role: '', company: '' };
}

function inferFromTitleAndMeta({ title, h1, meta, url }) {
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  if (host.includes('linkedin.com')) {
    const linkedIn = parseLinkedInTitle(meta['og:title'] || title || h1);
    const desc = splitCompanyLocation(meta['og:description'] || '');
    return {
      role: linkedIn.role || cleanText(h1),
      company: linkedIn.company || desc.company,
      location: desc.location,
      source: 'linkedin-meta',
    };
  }

  const role = cleanText(h1 || meta['og:title'] || title || '');
  const company = cleanText(meta['og:site_name'] || meta['twitter:site'] || '');
  const desc = cleanText(meta.description || meta['og:description'] || '');
  return { role, company, location: desc, source: 'html-meta' };
}

function sanitizeMetadata(metadata) {
  const input = metadata && typeof metadata === 'object' ? metadata : {};
  const role = cleanText(input.role);
  let company = cleanText(input.company);
  const location = cleanText(input.location);
  if (LINKEDIN_GENERIC_COMPANY_RE.test(company) && !role) company = '';
  return {
    role,
    company,
    location,
    source: input.source || 'unknown',
  };
}

function mergeMetadata(primary = {}, secondary = {}) {
  const a = sanitizeMetadata(primary);
  const b = sanitizeMetadata(secondary);
  return {
    role: a.role || b.role || '',
    company: a.company || b.company || '',
    location: a.location || b.location || '',
    source: [a.source, b.source].filter(Boolean).join('+') || 'unknown',
  };
}

function metadataSufficient(metadata = {}) {
  const cleaned = sanitizeMetadata(metadata);
  return Boolean(cleaned.role && cleaned.company);
}

export function extractJobMetadataFromHtml(html, url) {
  const source = String(html || '');
  const jsonLd = parseJobPostingMetadata(source);
  if (jsonLd && (jsonLd.role || jsonLd.company)) return sanitizeMetadata(jsonLd);

  const meta = extractMetaMap(source);
  const titleMatch = source.match(TITLE_RE);
  const h1Match = source.match(H1_RE);
  const inferred = inferFromTitleAndMeta({
    title: cleanText(titleMatch?.[1] || ''),
    h1: cleanText(h1Match?.[1] || ''),
    meta,
    url,
  });
  return sanitizeMetadata(inferred);
}

function parseVisibleTextLine(line = '') {
  const cleaned = cleanText(line);
  if (!cleaned) return null;
  const parts = cleaned.split(/\s*[·|]\s*/).map(cleanText).filter(Boolean);
  return {
    raw: cleaned,
    parts,
  };
}

function inferFromSnapshotCandidates(snapshot, url) {
  const roleCandidates = uniqTexts(snapshot.roleCandidates || []);
  const companyCandidates = uniqTexts(snapshot.companyCandidates || []);
  const locationCandidates = uniqTexts(snapshot.locationCandidates || []);
  const visibleLines = uniqTexts((snapshot.visibleText || '').split('\n').slice(0, 30));

  const meta = snapshot.meta || {};
  const htmlLike = inferFromTitleAndMeta({
    title: snapshot.title,
    h1: snapshot.h1,
    meta,
    url,
  });

  let role = roleCandidates[0] || htmlLike.role || '';
  let company = companyCandidates[0] || htmlLike.company || '';
  let location = locationCandidates[0] || htmlLike.location || '';

  if (!company || !location) {
    for (const line of visibleLines) {
      const parsed = parseVisibleTextLine(line);
      if (!parsed) continue;
      if (!company && parsed.parts.length >= 2 && !/apply/i.test(parsed.parts[0])) {
        company = parsed.parts[0];
        if (!location) location = parsed.parts.slice(1).join(' · ');
      }
      if (company && location) break;
    }
  }

  if (!role) {
    for (const line of visibleLines) {
      if (/apply|sign in|join now|share/i.test(line)) continue;
      if (line.length >= 6 && line.length <= 120) {
        role = line;
        break;
      }
    }
  }

  return sanitizeMetadata({ role, company, location, source: 'playwright-dom' });
}

export function extractJobMetadataFromSnapshot(snapshot, url) {
  const jsonLd = parseJobPostingMetadataFromNodes(Array.isArray(snapshot?.jsonLd) ? snapshot.jsonLd : []);
  const fromDom = inferFromSnapshotCandidates(snapshot || {}, url);
  return mergeMetadata(jsonLd, fromDom);
}

async function scrapeJobUrlWithPlaywright(url) {
  const browser = await launchChromiumWithRetry({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1800);
    const snapshot = await page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const textContent = (selector) => {
        const node = document.querySelector(selector);
        return node ? clean(node.textContent || node.innerText || '') : '';
      };
      const allTexts = (selectors) => selectors.map(textContent).filter(Boolean);
      const meta = {};
      document.querySelectorAll('meta[property], meta[name]').forEach((node) => {
        const key = node.getAttribute('property') || node.getAttribute('name');
        const value = node.getAttribute('content');
        if (key && value) meta[key.toLowerCase()] = clean(value);
      });
      const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map((node) => {
          try { return JSON.parse(node.textContent || 'null'); } catch { return null; }
        })
        .filter(Boolean);
      return {
        finalUrl: location.href,
        title: document.title || '',
        h1: textContent('h1'),
        meta,
        jsonLd,
        roleCandidates: allTexts([
          'h1',
          '[data-testid*="job-title"]',
          '[data-test-job-title]',
          '.top-card-layout__title',
          '.topcard__title',
          '.job-details-jobs-unified-top-card__job-title',
          '.jobsearch-JobInfoHeader-title',
        ]),
        companyCandidates: allTexts([
          '[data-testid*="company-name"]',
          '[data-test-company-name]',
          '.topcard__org-name-link',
          '.topcard__flavor a',
          '.job-details-jobs-unified-top-card__company-name',
          '.jobsearch-InlineCompanyRating div:first-child',
        ]),
        locationCandidates: allTexts([
          '[data-testid*="job-location"]',
          '[data-test-job-location]',
          '.topcard__flavor--bullet',
          '.job-details-jobs-unified-top-card__primary-description-container',
          '.jobsearch-JobInfoHeader-subtitle div',
        ]),
        visibleText: clean(document.body?.innerText || '').split(/(?<=[.!?])\s+/).slice(0, 12).join('\n'),
      };
    });
    return {
      ...extractJobMetadataFromSnapshot(snapshot, snapshot.finalUrl || url),
      finalUrl: snapshot.finalUrl || url,
      scrapedLive: true,
    };
  } finally {
    await browser.close();
  }
}

export async function enrichJobUrl(url) {
  let fetchResult = null;
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: FETCH_HEADERS,
    });
    const html = await response.text();
    fetchResult = {
      ...extractJobMetadataFromHtml(html, response.url || url),
      finalUrl: response.url || url,
      status: response.status,
      scrapedLive: false,
    };
    if (metadataSufficient(fetchResult)) return fetchResult;
  } catch {
    // Fall through to live scrape.
  }

  try {
    const live = await scrapeJobUrlWithPlaywright(fetchResult?.finalUrl || url);
    const merged = mergeMetadata(live, fetchResult || {});
    return {
      ...merged,
      finalUrl: live.finalUrl || fetchResult?.finalUrl || url,
      status: fetchResult?.status || 200,
      scrapedLive: true,
    };
  } catch (error) {
    if (fetchResult) return fetchResult;
    throw error;
  }
}
