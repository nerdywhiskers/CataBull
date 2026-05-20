/**
 * scan/providers/bamboohr.mjs — BambooHR careers list API
 *
 * BambooHR exposes its careers list at:
 *   https://{slug}.bamboohr.com/careers/list
 *
 * The page-style URL also returns JSON when fetched directly (BambooHR
 * uses the same endpoint for both views). Each opening has:
 *   { id, jobOpeningName, jobOpeningStatus, locationCity, locationState,
 *     departmentLabel, datePosted, ... }
 *
 * Job detail URL:
 *   https://{slug}.bamboohr.com/careers/{id}
 */

const BAMBOO_RE = /^https?:\/\/([^.]+)\.bamboohr\.com\b/i;
const FETCH_TIMEOUT_MS = 8000;

const HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; CareerBot/1.0)',
};

function bambooSlug(company) {
  const url = company.careers_url || '';
  const match = url.match(BAMBOO_RE);
  return match ? match[1] : null;
}

async function fetchListJson(slug) {
  const url = `https://${slug}.bamboohr.com/careers/list`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parsePosting(posting, slug) {
  const id = posting.id || posting.jobOpeningId || '';
  if (!id) return null;
  const title = String(posting.jobOpeningName || posting.title || '').trim();
  if (!title) return null;
  // Skip closed/draft postings — they sometimes linger in the response.
  const status = String(posting.jobOpeningStatus || '').toLowerCase();
  if (status && status !== 'open') return null;
  const locationParts = [
    posting.locationCity,
    posting.locationState,
    posting.locationCountry,
  ].map((s) => String(s || '').trim()).filter(Boolean);
  return {
    title,
    url: `https://${slug}.bamboohr.com/careers/${id}`,
    location: locationParts.join(', '),
    postedAt: String(posting.datePosted || '').slice(0, 10),
  };
}

export default {
  name: 'bamboohr',
  description: 'BambooHR careers list API',
  needsPlaywright: false,

  match(company) {
    return Boolean(bambooSlug(company));
  },

  matchUrl(href) {
    const m = String(href || '').match(BAMBOO_RE);
    return m ? { slug: m[1] } : null;
  },

  buildCareersUrl(slug) {
    return `https://${slug}.bamboohr.com/careers/list`;
  },

  async fetch(company) {
    const slug = bambooSlug(company);
    if (!slug) throw new Error('Not a BambooHR URL');
    const json = await fetchListJson(slug);
    const list = Array.isArray(json.result) ? json.result : [];
    const jobs = list
      .map((p) => parsePosting(p, slug))
      .filter(Boolean)
      .map((j) => ({ ...j, company: company.name }));
    return { jobs };
  },

  _internal: { bambooSlug, parsePosting, BAMBOO_RE },
};
