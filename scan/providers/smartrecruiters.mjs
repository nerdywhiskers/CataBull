/**
 * scan/providers/smartrecruiters.mjs — SmartRecruiters public postings API
 *
 * Career pages usually look like:
 *   https://careers.smartrecruiters.com/{companySlug}
 *
 * Public API:
 *   https://api.smartrecruiters.com/v1/companies/{companySlug}/postings
 */

const SMART_RECRUITERS_RE = /^https?:\/\/careers\.smartrecruiters\.com\/([^/?#]+)/i;
const FETCH_TIMEOUT_MS = 10000;
const PAGE_LIMIT = 100;

function smartRecruitersSlug(company) {
  const url = company.careers_url || company.api || '';
  const match = String(url).match(SMART_RECRUITERS_RE);
  if (match) return match[1];

  const apiMatch = String(url).match(/api\.smartrecruiters\.com\/v1\/companies\/([^/?#]+)\/postings/i);
  return apiMatch ? apiMatch[1] : null;
}

function buildApiUrl(slug) {
  return `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${PAGE_LIMIT}`;
}

async function fetchPostings(slug) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(buildApiUrl(slug), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function postingUrl(posting, slug) {
  if (posting.applyUrl) return posting.applyUrl;
  if (posting.id) return `https://jobs.smartrecruiters.com/${slug}/${posting.id}`;
  if (posting.ref && !/api\.smartrecruiters\.com/i.test(posting.ref)) return posting.ref;
  return '';
}

function parseLocation(location) {
  if (!location) return '';
  if (location.fullLocation) return String(location.fullLocation);
  return [location.city, location.region, location.country].map((s) => String(s || '').trim()).filter(Boolean).join(', ');
}

export default {
  name: 'smartrecruiters',
  description: 'SmartRecruiters public postings API',
  needsPlaywright: false,

  match(company) {
    return Boolean(smartRecruitersSlug(company));
  },

  matchUrl(href) {
    const m = String(href || '').match(SMART_RECRUITERS_RE);
    return m ? { slug: m[1] } : null;
  },

  buildCareersUrl(slug) {
    return `https://careers.smartrecruiters.com/${slug}`;
  },

  async fetch(company) {
    const slug = smartRecruitersSlug(company);
    if (!slug) throw new Error('Not a SmartRecruiters URL');
    const json = await fetchPostings(slug);
    const jobs = this.parse(json, company.name, slug);
    return { jobs };
  },

  parse(json, companyName, slug = '') {
    const postings = Array.isArray(json.content) ? json.content : [];
    return postings
      .map((posting) => ({
        title: String(posting.name || '').trim(),
        url: postingUrl(posting, slug),
        company: companyName,
        location: parseLocation(posting.location),
        postedAt: String(posting.releasedDate || posting.createdOn || '').slice(0, 10),
      }))
      .filter((job) => job.title && job.url);
  },

  _internal: { smartRecruitersSlug, buildApiUrl, parseLocation, SMART_RECRUITERS_RE },
};
