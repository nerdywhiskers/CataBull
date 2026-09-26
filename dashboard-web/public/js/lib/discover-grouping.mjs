/**
 * lib/discover-grouping.mjs — Pure helpers for the Discover tab (PR 1.3).
 *
 * Filter + group + sort logic for pending postings, separated from the
 * view file so it's testable without a DOM. The view imports from here
 * and renders; tests exercise the helpers directly.
 */

export const DISCOVER_VIEW_MODES = Object.freeze(['cards', 'list']);
export const DISCOVER_SORT_MODES = Object.freeze(['relevance', 'date-desc', 'date-asc', 'location-asc', 'location-desc']);

/** Build the predicate used to filter pending postings on the Discover tab. */
export function buildDiscoverFilter({
  minScore = 0,
  exactScore = null,
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
    const score = Number(posting.relevance ?? 0);
    if (Number.isFinite(minScore) && score < minScore) return false;
    if (Number.isFinite(exactScore) && score.toFixed(1) !== Number(exactScore).toFixed(1)) return false;
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

export function sortDiscoverItems(items, mode = 'relevance') {
  const selectedMode = DISCOVER_SORT_MODES.includes(mode) ? mode : 'relevance';
  const decorated = [...(items || [])].map((item, index) => ({ item, index }));
  const compareMissingLast = (a, b, direction = 1) => {
    const aMissing = a == null || a === '' || Number.isNaN(a);
    const bMissing = b == null || b === '' || Number.isNaN(b);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    if (aMissing) return 0;
    return a < b ? -direction : a > b ? direction : 0;
  };
  decorated.sort((a, b) => {
    let result = 0;
    if (selectedMode === 'date-desc' || selectedMode === 'date-asc') {
      const aDate = Date.parse(a.item?.postedAt || '');
      const bDate = Date.parse(b.item?.postedAt || '');
      result = compareMissingLast(aDate, bDate, selectedMode === 'date-desc' ? -1 : 1);
    } else if (selectedMode === 'location-asc' || selectedMode === 'location-desc') {
      const aLocation = String(a.item?.location || '').trim().toLocaleLowerCase();
      const bLocation = String(b.item?.location || '').trim().toLocaleLowerCase();
      result = compareMissingLast(aLocation, bLocation, selectedMode === 'location-desc' ? -1 : 1);
    } else {
      result = (b.item?.relevance ?? 0) - (a.item?.relevance ?? 0);
    }
    return result || a.index - b.index;
  });
  return decorated.map(({ item }) => item);
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

export function areAllDiscoverItemsSelected(selectedUrls, items = []) {
  if (!items.length) return false;
  const selected = selectedUrls instanceof Set ? selectedUrls : new Set(selectedUrls || []);
  return items.every((item) => item?.url && selected.has(item.url));
}

export function setDiscoverSelectionForItems(selectedUrls, items = [], checked = false) {
  const next = selectedUrls instanceof Set ? new Set(selectedUrls) : new Set(selectedUrls || []);
  for (const item of items) {
    if (!item?.url) continue;
    if (checked) next.add(item.url);
    else next.delete(item.url);
  }
  return next;
}

export function selectionForDragRect(selectedUrls, cards = [], dragRect = {}) {
  const next = selectedUrls instanceof Set ? new Set(selectedUrls) : new Set(selectedUrls || []);
  const left = Math.min(Number(dragRect.left) || 0, Number(dragRect.right) || 0);
  const right = Math.max(Number(dragRect.left) || 0, Number(dragRect.right) || 0);
  const top = Math.min(Number(dragRect.top) || 0, Number(dragRect.bottom) || 0);
  const bottom = Math.max(Number(dragRect.top) || 0, Number(dragRect.bottom) || 0);
  for (const card of cards) {
    const rect = card?.rect;
    if (!card?.url || !rect) continue;
    const intersects = rect.left <= right && rect.right >= left && rect.top <= bottom && rect.bottom >= top;
    if (intersects) next.add(card.url);
  }
  return next;
}
