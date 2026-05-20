/**
 * lib/discover-grouping.mjs — Pure helpers for the Discover tab (PR 1.3).
 *
 * Filter + group + sort logic for pending postings, separated from the
 * view file so it's testable without a DOM. The view imports from here
 * and renders; tests exercise the helpers directly.
 */

/** Build the predicate used to filter pending postings on the Discover tab. */
export function buildDiscoverFilter({
  minScore = 0,
  industries = null,    // Set | null
  company = '',         // free text, case-insensitive substring
  search = '',          // free text, matches company OR role
  resolveIndustries = () => [],
} = {}) {
  const wantsIndustry = industries instanceof Set && industries.size > 0;
  const c = (company || '').toLowerCase();
  const q = (search || '').toLowerCase();

  return (posting) => {
    if (!posting) return false;
    if (Number.isFinite(minScore) && (posting.relevance ?? 0) < minScore) return false;
    if (wantsIndustry) {
      const inds = resolveIndustries(posting) || [];
      if (!inds.some((i) => industries.has(i))) return false;
    }
    if (c) {
      if (!String(posting.company || '').toLowerCase().includes(c)) return false;
    }
    if (q) {
      const hay = `${posting.company || ''} ${posting.role || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };
}

/**
 * Group pending postings by company.
 *
 * Returns: [{ company, items, bestScore, count }] sorted by bestScore desc,
 * then alphabetically by company. Items inside each group are sorted by
 * relevance desc.
 */
export function groupPostingsByCompany(items) {
  const groups = new Map();
  for (const item of items || []) {
    const key = item?.company || '(unknown)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const out = [...groups.entries()].map(([company, list]) => {
    const sorted = [...list].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
    return {
      company,
      items: sorted,
      bestScore: sorted.reduce((m, p) => Math.max(m, p.relevance ?? 0), 0),
      count: sorted.length,
    };
  });
  out.sort((a, b) => b.bestScore - a.bestScore || a.company.localeCompare(b.company));
  return out;
}

/** Flat sort by relevance desc — used when the user picks the "Flat" toggle. */
export function sortByRelevance(items) {
  return [...(items || [])].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
}

/** Collect the set of industries present in a portals.yml tracked_companies list. */
export function collectIndustries(trackedCompanies) {
  const set = new Set();
  for (const c of trackedCompanies || []) {
    if (!Array.isArray(c?.industries)) continue;
    for (const i of c.industries) {
      if (i) set.add(String(i));
    }
  }
  return [...set].sort();
}
