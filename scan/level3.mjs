/**
 * scan/level3.mjs — Deep Scan Level 3 (WebSearch + liveness).
 *
 * Runs the same job-search-engine sweeps that modes/scan.md prose-spec'd
 * for the agent, but in-process so the dashboard can stream progress,
 * sidestep agent network sandboxing, and write to pipeline.md + history
 * with the same machinery the rest of scan.mjs uses.
 *
 * Pure module — no top-level side effects, no `process.argv` reads.
 * Inject `webSearch` and `livenessCheck` for tests.
 *
 * Spec: Level 3 node-helper design notes.
 */

import { buildTitleClassifier } from '../lib/title-filter.mjs';
import { searchWeb } from './websearch.mjs';

const LIVENESS_CONCURRENCY = 1;   // Playwright is single-threaded per browser
const SEARCH_CONCURRENCY = 3;     // Rate-limit-friendly across providers
const DEFAULT_PER_QUERY_MAX = 20;

// ── Aggregator detection ────────────────────────────────────────────
//
// Job-board WebSearch results are noisy: a query like
// `site:linkedin.com "Art Director" remote` returns a mix of
//   - individual postings:  linkedin.com/jobs/view/4338397551          (keep)
//   - category landing pages: linkedin.com/jobs/remote-art-director-jobs (reject)
//   - search-result pages:   wellfound.com/role/r/art-director         (reject)
//
// Both shapes pass a simple title keyword filter because the role name
// is in the page title either way. We reject aggregators via URL pattern
// + title-shape heuristics so the pipeline only collects discrete roles
// you can actually apply to.

const AGGREGATOR_URL_PATTERNS = [
  // LinkedIn category / search landing pages.
  // NOTE: Brave/Google can't index linkedin.com/jobs/view/<id> URLs (LinkedIn
  // blocks search engines), so `site:linkedin.com/jobs` queries only ever
  // return category pages. The LinkedIn search_queries entry in portals.yml
  // is essentially a no-op for Deep Scan — recommend disabling it.
  /linkedin\.com\/jobs\/(?:search|collections|browse)\b/i,
  /linkedin\.com\/jobs\/[\w-]+-jobs(?:\/|$|\?)/i,
  // Wellfound role / browse pages. Individual postings use /jobs/<id>-<slug>
  // or /company/<slug>/jobs/<id> and are picked up by POSTING_URL_PATTERNS.
  /wellfound\.com\/role\b/i,
  /wellfound\.com\/jobs(?:\/?$|\?)/i,
  /wellfound\.com\/discover\b/i,
  // RemoteOK aggregators. Critical: anchor `-jobs` to end-of-path or `?`
  // so we DON'T accidentally match real posting URLs like
  // `remoteok.com/remote-jobs/<slug>-<id>` (which contain "-jobs/" mid-path).
  /remoteok\.(?:com|io)\/(?:remote-)?[\w-]+-jobs(?:$|\?)/i,
  /remoteok\.(?:com|io)\/hire(?:-remotely)?\b/i,   // "Hire the N best …" talent-search pages
  /remoteok\.(?:com|io)\/?(?:\?.*)?$/i,
  // Ladders category / search pages. Individual postings live at /job/<slug>_<id>
  // and /job-listing/<id>; everything under /jobs/ is a category list.
  /theladders\.com\/jobs\/[\w,-]+/i,
  /theladders\.com\/(?:jobs|search|browse)(?:\/?$|\?)/i,
  // Generic search-engine result-page markers.
  /[?&](?:q|search|query|keywords)=/i,
];

const POSTING_URL_PATTERNS = [
  /linkedin\.com\/jobs\/view\/\d+/i,
  /wellfound\.com\/jobs\/\d+/i,
  /wellfound\.com\/company\/[^/]+\/jobs\/\d+/i,
  // RemoteOK individual posting: /remote-jobs/<slug-with-id>. The slug
  // always contains a trailing numeric id; we don't require it in the
  // pattern because some legacy URLs use a different layout.
  /remoteok\.(?:com|io)\/remote-jobs\/[\w-]+/i,
  /theladders\.com\/job-listing\b/i,
  /theladders\.com\/job\/[\w-]+_\d+\b/i,
];

// Title shapes we never want. "95 Remote Art Director jobs in LA" is the
// canonical example — these are always listing pages, never individual roles.
const AGGREGATOR_TITLE_PATTERNS = [
  /\b\d+\+?\s+[\w\s-]*\bjobs?\b/i,                // "12 art director jobs"
  /\bjobs?\s+in\s+\d+\s+countries\b/i,
  /\b(?:browse|find|search|explore|all)\s+(?:remote\s+)?[\w\s-]*\bjobs?\b/i,
];

export function isAggregatorPage({ url, title }) {
  const u = String(url || '');
  const t = String(title || '');
  if (POSTING_URL_PATTERNS.some((p) => p.test(u))) return false;
  if (AGGREGATOR_URL_PATTERNS.some((p) => p.test(u))) return true;
  if (AGGREGATOR_TITLE_PATTERNS.some((p) => p.test(t))) return true;
  return false;
}

/**
 * Tracking-param-stripping URL canonicalizer. Mirrors the helper in
 * scan.mjs so a hit that comes back through both Level 1-2 and Level 3
 * dedupes against the same string.
 */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'src', 'source', 'ref', 'referrer', 'fbclid', 'gclid', 'mc_cid', 'mc_eid',
]);

export function normalizeUrl(raw) {
  if (!raw) return '';
  const input = String(raw).trim();
  if (!input) return '';
  try {
    const u = new URL(input);
    u.hostname = u.hostname.toLowerCase();
    u.hash = '';
    const filtered = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()));
    filtered.sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    for (const [k, v] of filtered) u.searchParams.append(k, v);
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return input;
  }
}

/**
 * Best-effort company extraction from a search result. Used to populate
 * the `company` field on Level 3 postings, since search engines don't
 * structure their results the way ATS APIs do.
 *
 * Heuristics, in order:
 *   1. "Role - Company - location" / "Role at Company" patterns in the title
 *   2. The domain stripped of www. and TLD
 *
 * Returns 'Unknown' if neither yields a plausible company.
 */
export function extractCompany({ title, url }) {
  const t = String(title || '').trim();
  // Pattern: "Senior Engineer - Acme Inc - Remote"
  let m = t.match(/^(?<role>.+?)\s+[-–—]\s+(?<company>[^-–—]+?)\s+[-–—]\s+/);
  if (m?.groups?.company) return m.groups.company.trim();
  // Pattern: "Senior Engineer at Acme [• Location • Remote] [| Wellfound]"
  // The trailing suffix can use any of: dash variants, bullet, or pipe — all
  // common across job-board search-result titles. Without this, Wellfound
  // titles like "Senior Concept Artist at Teleporter • Istanbul • Remote |
  // Wellfound" dump the whole tail into the company field.
  m = t.match(/^(?<role>.+?)\s+at\s+(?<company>.+?)(?:\s+[-–—•|].*)?$/i);
  if (m?.groups?.company) return m.groups.company.trim();
  // Fallback: domain.
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    // For job-board hosts (linkedin.com/jobs, …), don't return the board
    // as the company — there's no signal there.
    const JOB_BOARDS = new Set([
      'linkedin.com', 'wellfound.com', 'angel.co', 'remoteok.com', 'remoteok.io',
      'indeed.com', 'glassdoor.com', 'theladders.com', 'monster.com',
      'job-boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com',
    ]);
    const rootHost = host.split('.').slice(-2).join('.');
    if (JOB_BOARDS.has(host) || JOB_BOARDS.has(rootHost)) return 'Unknown';
    return host.split('.')[0];
  } catch {
    return 'Unknown';
  }
}

/**
 * Try to extract a role title from the search hit. We use the search-result
 * title with the company/board suffix stripped if a delimiter is obvious.
 * Liveness check overwrites this with the real page title when available.
 */
export function extractRole(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  // "Role - Company - location" → keep "Role"
  let parts = t.split(/\s+[-–—]\s+/);
  if (parts.length > 1) return parts[0].trim();
  // "Role at Company" → keep "Role"
  const m = t.match(/^(.+?)\s+at\s+/i);
  if (m) return m[1].trim();
  return t;
}

/**
 * Run Level 3 across the configured search_queries entries.
 *
 * @param {object} args
 * @param {Array<{name, query, enabled?, companyName?}>} args.searchQueries
 * @param {object} args.titleFilter — portals.yml > title_filter shape
 * @param {Set<string>} args.seenUrls — normalized URLs to dedupe against
 * @param {Set<string>} args.seenCompanyRoles — `${company}::${role}` keys
 * @param {function} [args.onProgress] — ({stage, …}) => void
 * @param {function} [args.webSearch] — injectable for tests
 * @param {function} [args.livenessCheck] — injectable for tests; resolves to {result: 'active'|'expired'|'uncertain', reason}
 * @param {number} [args.perQueryMax] — cap per-query result count
 * @param {number} [args.totalCap] — cap total survivors across all queries
 * @returns {Promise<{added: Array, skipped: {title, dup, expired}, errors: Array, perQuery: Array}>}
 */
export async function runLevel3({
  searchQueries = [],
  titleFilter,
  seenUrls = new Set(),
  seenCompanyRoles = new Set(),
  onProgress = () => {},
  webSearch = searchWeb,
  livenessCheck,
  perQueryMax = DEFAULT_PER_QUERY_MAX,
  totalCap = 0,
} = {}) {
  const enabled = (searchQueries || []).filter((q) => q && q.enabled !== false && q.query);
  const classifyTitle = buildTitleClassifier(titleFilter);

  const added = [];
  const skipped = { title: 0, dup: 0, expired: 0, aggregator: 0 };
  const errors = [];
  const perQuery = [];

  if (enabled.length === 0) {
    onProgress({ stage: 'done', enabled_queries: 0 });
    return { added, skipped, errors, perQuery };
  }

  onProgress({ stage: 'start', enabled_queries: enabled.length });

  // We collect candidates from all queries first, then liveness-check the
  // dedup'd survivors in one pass. Liveness is the slowest step; doing it
  // up front per-query would multiply the wait by N for hits that show up
  // in multiple queries.
  const allCandidates = []; // { url, title, snippet, sourceQuery }
  const candidateUrls = new Set();

  // Search phase — limited concurrency to be nice to the provider.
  const searchTasks = enabled.map((q, i) => async () => {
    onProgress({ stage: 'search:start', queryIndex: i, total: enabled.length, queryName: q.name });
    try {
      const hits = await webSearch(q.query, { maxResults: perQueryMax });
      perQuery.push({ name: q.name, hits: hits.length });
      let kept = 0;
      for (const hit of hits) {
        // Reject aggregator / listing pages before the title-keyword check
        // — they almost always *pass* keyword filters (the role name is in
        // the page title) and produce noise like
        // "95 Remote Art Director jobs in LA" with company=Unknown.
        if (isAggregatorPage({ url: hit.url, title: hit.title })) {
          skipped.aggregator++;
          continue;
        }
        const role = extractRole(hit.title);
        const match = classifyTitle(role || hit.title);
        if (match.decision === 'skip') {
          skipped.title++;
          continue;
        }
        const normalized = normalizeUrl(hit.url);
        if (!normalized) continue;
        if (seenUrls.has(normalized) || candidateUrls.has(normalized)) {
          skipped.dup++;
          continue;
        }
        candidateUrls.add(normalized);
        allCandidates.push({
          url: hit.url,
          normalizedUrl: normalized,
          searchTitle: hit.title,
          searchSnippet: hit.snippet,
          sourceQuery: q.name,
          companyHint: q.companyName || q.company || '',
          matchTier: match.tier,
          matchReason: match.reason,
        });
        kept++;
      }
      onProgress({ stage: 'search:done', queryIndex: i, total: enabled.length, queryName: q.name, hits: hits.length, kept });
    } catch (err) {
      errors.push({ stage: 'search', queryName: q.name, error: err.message || String(err) });
      onProgress({ stage: 'search:error', queryIndex: i, queryName: q.name, error: err.message || String(err) });
    }
  });

  await runWithConcurrency(searchTasks, SEARCH_CONCURRENCY);

  if (allCandidates.length === 0) {
    onProgress({ stage: 'done', candidates: 0, added: 0 });
    return { added, skipped, errors, perQuery };
  }

  // Liveness phase — sequential by design (project rule: never parallel
  // Playwright). Skip entirely if no checker was injected.
  if (livenessCheck) {
    onProgress({ stage: 'liveness:start', total: allCandidates.length });
    for (let i = 0; i < allCandidates.length; i++) {
      if (totalCap && added.length >= totalCap) break;
      const cand = allCandidates[i];
      onProgress({ stage: 'liveness:check', index: i, total: allCandidates.length, url: cand.url });
      let result;
      try {
        result = await livenessCheck(cand.url);
      } catch (err) {
        errors.push({ stage: 'liveness', url: cand.url, error: err.message || String(err) });
        result = { result: 'uncertain', reason: 'liveness check threw' };
      }
      // "expired" is the only verdict we drop; "uncertain" is kept because
      // single-page apps often hide their apply button behind hydration we
      // can't reliably detect in 15 seconds.
      if (result?.result === 'expired') {
        skipped.expired++;
        onProgress({ stage: 'liveness:expired', index: i, url: cand.url, reason: result.reason });
        continue;
      }

      const company = cand.companyHint || extractCompany({ title: cand.searchTitle, url: cand.url });
      const role = extractRole(cand.searchTitle);
      const companyRoleKey = `${company.toLowerCase()}::${role.toLowerCase()}`;
      if (seenCompanyRoles.has(companyRoleKey)) {
        skipped.dup++;
        continue;
      }
      seenCompanyRoles.add(companyRoleKey);
      seenUrls.add(cand.normalizedUrl);

      added.push({
        url: cand.url,
        title: role || cand.searchTitle,
        company,
        location: '',
        postedAt: '',
        source: cand.sourceQuery,
        searchSnippet: cand.searchSnippet,
        matchTier: cand.matchTier,
        matchReason: cand.matchReason,
      });
    }
    onProgress({ stage: 'liveness:done', kept: added.length });
  } else {
    // No liveness checker → still emit added items, just without verification.
    // Useful for unit tests and `--no-liveness` runs.
    for (const cand of allCandidates) {
      if (totalCap && added.length >= totalCap) break;
      const company = cand.companyHint || extractCompany({ title: cand.searchTitle, url: cand.url });
      const role = extractRole(cand.searchTitle);
      const companyRoleKey = `${company.toLowerCase()}::${role.toLowerCase()}`;
      if (seenCompanyRoles.has(companyRoleKey)) {
        skipped.dup++;
        continue;
      }
      seenCompanyRoles.add(companyRoleKey);
      seenUrls.add(cand.normalizedUrl);

      added.push({
        url: cand.url,
        title: role || cand.searchTitle,
        company,
        location: '',
        postedAt: '',
        source: cand.sourceQuery,
        searchSnippet: cand.searchSnippet,
        matchTier: cand.matchTier,
        matchReason: cand.matchReason,
      });
    }
  }

  onProgress({ stage: 'done', candidates: allCandidates.length, added: added.length });
  return { added, skipped, errors, perQuery };
}

async function runWithConcurrency(tasks, limit) {
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) {
      const idx = i++;
      await tasks[idx]();
    }
  };
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
}
