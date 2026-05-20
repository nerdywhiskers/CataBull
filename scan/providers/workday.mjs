/**
 * scan/providers/workday.mjs — Workday "CXS" job-board API
 *
 * Tenant URLs look like:
 *   https://{tenant}.{shard}.myworkdayjobs.com/{site}
 *
 * The CXS jobs endpoint is:
 *   https://{tenant}.{shard}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 *
 * It accepts a POST with a JSON body. Returns a paginated list of
 * jobPostings; each posting carries an `externalPath` that resolves
 * relative to the site URL.
 *
 * This unblocks a long tail of enterprise employers (Adobe, Mastercard,
 * Salesforce, Microsoft sub-orgs, Pixar, etc.) that the webfetch
 * provider can't scrape because the careers page is a heavy SPA.
 *
 * Design notes:
 *  - We make a single request with a generous page size (50). The
 *    health/scan layer doesn't currently paginate further; we surface
 *    the first page and rely on title filtering downstream. If a tenant
 *    has 50+ matching roles per scan window we can extend later.
 *  - User-Agent is set to a realistic browser string. Workday's edge
 *    will 400 plain-fetch requests with no UA.
 */

const WORKDAY_RE = /^https?:\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com\/(?:wday\/cxs\/[^/]+\/)?([^/?#]+)/i;
// Adobe (and likely other tenants) reject limit > 20 with HTTP 400,
// even though the schema doesn't document a cap. 20 is the maximum
// that consistently works across tenants we've tested.
const PAGE_LIMIT = 20;
const FETCH_TIMEOUT_MS = 10_000;

// Counter-intuitively, several Workday tenants (Adobe in particular)
// 400 the request when User-Agent looks like a bot. Letting Node's
// fetch send its default (no UA) gets through cleanly. We do set
// Accept and Content-Type explicitly because the API insists on JSON
// being asked for.
const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
};

function parseConfig(company) {
  // Allow explicit override via provider_config.workday for tenants
  // whose careers_url doesn't follow the canonical pattern (rare).
  const explicit = company.provider_config?.workday;
  if (explicit && explicit.tenant && explicit.shard && explicit.site) {
    return {
      tenant: explicit.tenant,
      shard: explicit.shard,
      site: explicit.site,
    };
  }

  const url = company.careers_url || company.api || '';
  const match = url.match(WORKDAY_RE);
  if (!match) return null;
  return { tenant: match[1], shard: match[2], site: match[3] };
}

function buildJobsApiUrl({ tenant, shard, site }) {
  return `https://${tenant}.${shard}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
}

function buildSiteBase({ tenant, shard, site }) {
  return `https://${tenant}.${shard}.myworkdayjobs.com/${site}`;
}

async function postJobs(apiUrl, { searchText = '', limit = PAGE_LIMIT, offset = 0 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        appliedFacets: {},
        limit,
        offset,
        searchText,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parsePosting(posting, base) {
  const path = posting.externalPath || '';
  const url = path
    ? `${base}${path.startsWith('/') ? path : `/${path}`}`
    : '';
  const location = Array.isArray(posting.locationsText)
    ? posting.locationsText.join(', ')
    : (posting.locationsText || '');
  // Workday only gives "Posted Today" / "Posted N Days Ago" in postedOn.
  // We can't always reconstruct an exact ISO date, so we leave postedAt
  // blank when relative; the dedupe / scan-history layer doesn't depend
  // on it being filled.
  let postedAt = '';
  const m = String(posting.postedOn || '').match(/posted (\d+)\+?\s*days? ago/i);
  if (m) {
    const days = parseInt(m[1], 10);
    if (!Number.isNaN(days)) {
      const dt = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      postedAt = dt.toISOString().slice(0, 10);
    }
  } else if (/posted today/i.test(String(posting.postedOn || ''))) {
    postedAt = new Date().toISOString().slice(0, 10);
  }
  return {
    title: String(posting.title || ''),
    url,
    location,
    postedAt,
  };
}

export default {
  name: 'workday',
  description: 'Workday CXS jobs API (POST endpoint, paginated)',
  needsPlaywright: false,

  match(company) {
    return parseConfig(company) !== null;
  },

  // Used by the sniffer to detect Workday URLs in arbitrary HTML hrefs.
  // Returns { slug } combining tenant+site so dedupe inside sniff.mjs
  // treats different tenants/sites as different candidates (e.g. one
  // Workday page can link to multiple sub-tenants).
  matchUrl(href) {
    const url = String(href || '');
    const m = url.match(WORKDAY_RE);
    if (!m) return null;
    return {
      slug: `${m[1]}/${m[3]}`,
      tenant: m[1],
      shard: m[2],
      site: m[3],
    };
  },

  buildCareersUrl(slug) {
    // Workday slugs need shard info to be useful; we don't synthesize a
    // fake shard. Caller should reuse the original href instead. This
    // exists for parity with the simpler providers.
    return null;
  },

  // Workday's API isn't fetched via fetchJson (which uses GET) — it
  // needs a custom POST. We expose `fetch` so the scanner uses our
  // implementation instead of buildUrl + parse.
  //
  // Returns { jobs, meta? } — the same shape every fetch-based provider
  // uses, so scan.mjs can uniformly destructure regardless of which
  // ATS produced the result.
  async fetch(company) {
    const cfg = parseConfig(company);
    if (!cfg) throw new Error('Not a Workday URL');
    const apiUrl = buildJobsApiUrl(cfg);
    const base = buildSiteBase(cfg);
    const json = await postJobs(apiUrl, { limit: PAGE_LIMIT });
    const postings = Array.isArray(json.jobPostings) ? json.jobPostings : [];
    const jobs = postings
      .map((p) => parsePosting(p, base))
      .filter((j) => j.url && j.title)
      .map((j) => ({ ...j, company: company.name }));
    return { jobs };
  },

  // Exported for the URL-matching tests below.
  _internal: { parseConfig, buildJobsApiUrl, buildSiteBase, parsePosting, WORKDAY_RE },
};
