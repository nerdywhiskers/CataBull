#!/usr/bin/env node

/**
 * test-level3.mjs — Unit tests for scan/level3.mjs.
 *
 * Every test injects mock `webSearch` and `livenessCheck` functions so
 * the suite has zero network/playwright dependencies.
 */

import { runLevel3, normalizeUrl, extractCompany, extractRole, isAggregatorPage } from '../scan/level3.mjs';
import { buildDeepScanQueries } from '../dashboard-web/routes/scan-deep.mjs';

let passed = 0;
let failed = 0;
let total = 0;

function assert(cond, msg) {
  total++;
  if (cond) { passed++; }
  else { failed++; console.log(`  ❌ ${msg}`); }
}

const TITLE_FILTER = {
  positive: ['Staff Engineer', 'Senior Engineer', 'Backend Engineer', 'Art Director'],
  negative: ['Junior', 'Intern'],
};

const SEARCH_QUERIES = [
  { name: 'LinkedIn', query: 'site:linkedin.com staff engineer', enabled: true },
  { name: 'Wellfound', query: 'site:wellfound.com art director', enabled: true },
  { name: 'Ladders (disabled)', query: 'site:theladders.com x', enabled: false },
];

const stubLive = async () => ({ result: 'active', reason: 'mock active' });
const stubExpired = async () => ({ result: 'expired', reason: 'mock expired' });
const stubUncertain = async () => ({ result: 'uncertain', reason: 'mock uncertain' });

console.log('\nscan/level3.mjs');

// ── 1. extractCompany ──────────────────────────────────────────────

console.log('\n1. extractCompany / extractRole');

assert(extractCompany({ title: 'Senior Engineer - Acme Inc - Remote', url: '' }) === 'Acme Inc', 'dash-separated company');
assert(extractCompany({ title: 'Senior Engineer at Acme', url: '' }) === 'Acme', 'at-separated company');
assert(extractCompany({ title: 'Senior Concept Artist at Teleporter • Istanbul • Remote (Work from Home) | Wellfound', url: '' }) === 'Teleporter', 'bullet/pipe suffix stripped from at-pattern');
assert(extractCompany({ title: 'Art Director at Evolving Web • Montreal • Remote | Wellfound', url: '' }) === 'Evolving Web', 'multi-word company before bullet kept');
assert(extractCompany({ title: 'No company info', url: 'https://www.acme.com/jobs/1' }) === 'acme', 'fallback to domain');
assert(extractCompany({ title: 'Some Job', url: 'https://linkedin.com/jobs/123' }) === 'Unknown', 'job-board domain → Unknown');
assert(extractCompany({ title: 'Some Job', url: 'not-a-url' }) === 'Unknown', 'unparseable url → Unknown');

assert(extractRole('Senior Engineer - Acme Inc - Remote') === 'Senior Engineer', 'role from dash-separated');
assert(extractRole('Senior Engineer at Acme') === 'Senior Engineer', 'role from at-separated');
assert(extractRole('Just A Title') === 'Just A Title', 'plain title preserved');

// ── 2. normalizeUrl ────────────────────────────────────────────────

console.log('\n2. normalizeUrl');

assert(
  normalizeUrl('https://x.com/job/1?utm_source=linkedin&id=42') === normalizeUrl('https://x.com/job/1?id=42'),
  'tracking params stripped from dedupe key',
);
assert(normalizeUrl('https://X.COM/Job/1/') === 'https://x.com/Job/1', 'host lowercased + trailing slash trimmed');
assert(normalizeUrl('') === '', 'empty input');
assert(normalizeUrl('not a url').includes('not a url') || normalizeUrl('not a url').length > 0, 'unparseable url falls through');

// ── 3. runLevel3 — happy path ──────────────────────────────────────

console.log('\n3. runLevel3 happy path');

const stubWebSearch = async (query) => {
  if (query.includes('linkedin')) {
    return [
      { url: 'https://linkedin.com/jobs/100', title: 'Staff Engineer at Acme', snippet: 'snippet' },
      { url: 'https://linkedin.com/jobs/101', title: 'Junior Engineer at Acme', snippet: 'junior' },
      { url: 'https://linkedin.com/jobs/102', title: 'Senior Engineer at Beta', snippet: 'beta' },
    ];
  }
  if (query.includes('wellfound')) {
    return [
      { url: 'https://wellfound.com/jobs/200', title: 'Art Director at Gamma', snippet: 'gamma' },
      { url: 'https://wellfound.com/jobs/100', title: 'Staff Engineer at Acme', snippet: 'dupe url' }, // dup with linkedin
    ];
  }
  return [];
};

const result = await runLevel3({
  searchQueries: SEARCH_QUERIES,
  titleFilter: TITLE_FILTER,
  webSearch: stubWebSearch,
  livenessCheck: stubLive,
});

assert(result.added.length === 3, 'three survivors (after title-filter + dedupe)');
const titles = result.added.map((a) => a.title).sort();
assert(titles.includes('Staff Engineer'), 'Staff Engineer kept');
assert(titles.includes('Senior Engineer'), 'Senior Engineer kept');
assert(titles.includes('Art Director'), 'Art Director kept');
assert(!titles.some((t) => /Junior/.test(t)), 'Junior filtered out');
assert(result.skipped.title >= 1, 'title-filter skip recorded');
assert(result.skipped.dup >= 1, 'dedupe skip recorded');

const sources = new Set(result.added.map((a) => a.source));
assert(sources.has('LinkedIn'), 'linkedin source tagged');
assert(sources.has('Wellfound'), 'wellfound source tagged');

// Disabled query did not run
assert(!result.perQuery.some((q) => q.name === 'Ladders (disabled)'), 'disabled query skipped');

// ── 4. runLevel3 — liveness drops expired ──────────────────────────

console.log('\n4. expired liveness drops candidate');

const expiredResult = await runLevel3({
  searchQueries: [{ name: 'LinkedIn', query: 'site:linkedin.com x', enabled: true }],
  titleFilter: TITLE_FILTER,
  webSearch: async () => [
    { url: 'https://linkedin.com/jobs/dead', title: 'Staff Engineer at X', snippet: '' },
  ],
  livenessCheck: stubExpired,
});

assert(expiredResult.added.length === 0, 'expired candidate dropped');
assert(expiredResult.skipped.expired === 1, 'expired count incremented');

const uncertainResult = await runLevel3({
  searchQueries: [{ name: 'Ladders', query: 'site:theladders.com x', enabled: true }],
  titleFilter: TITLE_FILTER,
  webSearch: async () => [
    { url: 'https://www.theladders.com/job/art-director-ncrcorporation-virtual-travel_81139223', title: 'Art Director at NCR', snippet: '' },
  ],
  livenessCheck: stubUncertain,
});
assert(uncertainResult.added.length === 0, 'uncertain candidate dropped when liveness checker is available');
assert(uncertainResult.skipped.unverified === 1, 'uncertain liveness count increments unverified');

// ── 5. runLevel3 — empty queries ───────────────────────────────────

console.log('\n5. no enabled queries');

const emptyResult = await runLevel3({
  searchQueries: [{ name: 'X', query: 'q', enabled: false }],
  titleFilter: TITLE_FILTER,
  webSearch: stubWebSearch,
  livenessCheck: stubLive,
});
assert(emptyResult.added.length === 0, 'no enabled queries → 0 added');
assert(emptyResult.errors.length === 0, 'no errors when nothing to run');

// ── 6. runLevel3 — seenUrls dedupe across runs ─────────────────────

console.log('\n6. seenUrls dedupes against history');

const preSeen = new Set();
preSeen.add(normalizeUrl('https://linkedin.com/jobs/100'));

const preSeenResult = await runLevel3({
  searchQueries: SEARCH_QUERIES,
  titleFilter: TITLE_FILTER,
  seenUrls: preSeen,
  webSearch: stubWebSearch,
  livenessCheck: stubLive,
});

const stillSeesJob100 = preSeenResult.added.some((a) => a.url === 'https://linkedin.com/jobs/100');
assert(!stillSeesJob100, 'pre-seen URL excluded');

// ── 7. runLevel3 — totalCap ────────────────────────────────────────

console.log('\n7. totalCap caps total added');

const cappedResult = await runLevel3({
  searchQueries: SEARCH_QUERIES,
  titleFilter: TITLE_FILTER,
  webSearch: stubWebSearch,
  livenessCheck: stubLive,
  totalCap: 1,
});
assert(cappedResult.added.length === 1, 'totalCap=1 caps to 1');

// ── 8. runLevel3 — WebSearch error is captured, not thrown ─────────

console.log('\n8. webSearch errors surface non-fatally');

let progressEvents = [];
const erroringSearch = async (q) => {
  if (q.includes('wellfound')) throw new Error('Brave 429');
  return [{ url: 'https://x.com/1', title: 'Staff Engineer at X', snippet: '' }];
};
const errResult = await runLevel3({
  searchQueries: SEARCH_QUERIES,
  titleFilter: TITLE_FILTER,
  webSearch: erroringSearch,
  livenessCheck: stubLive,
  onProgress: (p) => progressEvents.push(p),
});
assert(errResult.errors.length >= 1, 'one or more search errors recorded');
assert(errResult.errors.some((e) => e.stage === 'search'), 'error tagged with stage=search');
assert(errResult.added.length >= 1, 'other queries still added results');
assert(progressEvents.some((p) => p.stage === 'search:error'), 'progress emitted search:error');

// Per-company scan_query entries can carry a company hint so custom
// careers pages do not land in the pipeline as Unknown.
console.log('\n8b. per-company scan_query company hint');

const builtQueries = buildDeepScanQueries({
  search_queries: [{ name: 'Global', query: 'site:global.test art director' }],
  tracked_companies: [
    { name: 'Acme Studio', enabled: true, scan_query: 'site:acme.test/jobs art director' },
    { name: 'Disabled Studio', enabled: false, scan_query: 'site:disabled.test/jobs art director' },
  ],
});
assert(builtQueries.length === 2, 'Deep Scan query builder includes global plus enabled per-company scan_query');
assert(builtQueries.some((q) => q.companyName === 'Acme Studio'), 'per-company scan_query carries companyName');
assert(!builtQueries.some((q) => q.name.includes('Disabled Studio')), 'disabled company scan_query skipped');

const hintedResult = await runLevel3({
  searchQueries: [{ name: 'Acme scan_query', query: 'site:acme.test/jobs art director', enabled: true, companyName: 'Acme Studio' }],
  titleFilter: TITLE_FILTER,
  webSearch: async () => [
    { url: 'https://acme.test/jobs/1', title: 'Art Director', snippet: '' },
  ],
  livenessCheck: stubLive,
});
assert(hintedResult.added.length === 1, 'hinted query produced one survivor');
assert(hintedResult.added[0].company === 'Acme Studio', 'companyName hint used for result company');

// ── 9. isAggregatorPage ─────────────────────────────────────────────

console.log('\n9. aggregator detection');

// LinkedIn shapes
assert(!isAggregatorPage({ url: 'https://linkedin.com/jobs/view/4338397551', title: 'Art Director at X' }), 'LinkedIn individual posting kept');
assert(isAggregatorPage({ url: 'https://linkedin.com/jobs/remote-art-director-jobs', title: 'Remote Art Director Jobs' }), 'LinkedIn category page rejected');
assert(isAggregatorPage({ url: 'https://linkedin.com/jobs/search?keywords=art+director', title: 'Art Director jobs' }), 'LinkedIn search page rejected');

// Wellfound shapes
assert(!isAggregatorPage({ url: 'https://wellfound.com/jobs/3189609-video-game-concept-artist', title: 'Video Game Concept Artist at Acme' }), 'Wellfound individual posting kept');
assert(isAggregatorPage({ url: 'https://wellfound.com/role/r/art-director', title: 'Art Director Jobs' }), 'Wellfound role landing rejected');
assert(isAggregatorPage({ url: 'https://wellfound.com/role/l/art-director/new-york', title: 'Art Director Jobs in NY' }), 'Wellfound role+location rejected');
assert(isAggregatorPage({ url: 'https://wellfound.com/jobs', title: 'Wellfound jobs' }), 'Wellfound jobs index rejected');

// RemoteOK shapes
assert(!isAggregatorPage({ url: 'https://remoteok.com/remote-jobs/100', title: 'Senior Engineer at X' }), 'RemoteOK numeric posting kept');
assert(!isAggregatorPage({ url: 'https://remoteok.com/remote-jobs/remote-senior-concept-artist-contract-arenanet-1128870', title: 'Remote Senior Concept Artist at ArenaNet' }), 'RemoteOK slug+id posting kept');
assert(isAggregatorPage({ url: 'https://remoteok.com/remote-art-director-jobs', title: 'Remote Art Director Jobs' }), 'RemoteOK category rejected');
assert(isAggregatorPage({ url: 'https://remoteok.com/hire-remotely/digital-artist', title: 'Hire the 15 Best Remote Digital Artist Developers' }), 'RemoteOK /hire-remotely page rejected');
assert(isAggregatorPage({ url: 'https://remoteok.com/hire/illustrator', title: 'Hire the 348 Best Remote Illustrator Developers' }), 'RemoteOK /hire page rejected');

// Ladders shapes
assert(!isAggregatorPage({ url: 'https://www.theladders.com/job/senior-designer-art-director-a-b-studio-austin-tx_82109821', title: 'Senior Designer at X' }), 'Ladders /job/<slug>_<id> kept');
assert(!isAggregatorPage({ url: 'https://www.theladders.com/job-listing/-7037942725999343544/art-director.htm', title: 'Art Director' }), 'Ladders /job-listing/ kept');
assert(isAggregatorPage({ url: 'https://www.theladders.com/jobs/technical-art-director-jobs', title: 'Technical Art Director Jobs | Ladders' }), 'Ladders /jobs/<category> rejected');
assert(isAggregatorPage({ url: 'https://www.theladders.com/jobs/art-director-jobs,remote-work-from-home?page=3', title: 'Highest Paying Remote Art Director Jobs' }), 'Ladders /jobs/<category-with-comma> rejected');

// Title-shape rejection (URL is benign-looking)
assert(isAggregatorPage({ url: 'https://example.com/page', title: '95 Remote Art Director jobs in Los Angeles' }), 'count-prefixed title rejected');
assert(isAggregatorPage({ url: 'https://example.com/page', title: 'Browse remote engineering jobs' }), 'browse-prefixed title rejected');
assert(!isAggregatorPage({ url: 'https://example.com/page', title: 'Senior Art Director - Acme' }), 'normal posting title kept');

// ── 10. aggregator pages filtered before title-filter ─────────────

console.log('\n10. aggregator pages filtered by runLevel3');

const aggHits = [
  { url: 'https://linkedin.com/jobs/view/100', title: 'Staff Engineer at Acme', snippet: '' },
  { url: 'https://linkedin.com/jobs/remote-staff-engineer-jobs', title: 'Remote Staff Engineer Jobs', snippet: '' },
  { url: 'https://wellfound.com/role/r/staff-engineer', title: '95 Staff Engineer jobs in LA', snippet: '' },
];
const aggResult = await runLevel3({
  searchQueries: [{ name: 'LinkedIn', query: 'q', enabled: true }],
  titleFilter: TITLE_FILTER,
  webSearch: async () => aggHits,
  livenessCheck: stubLive,
});

assert(aggResult.added.length === 1, 'only the individual posting survived');
assert(aggResult.added[0].url === 'https://linkedin.com/jobs/view/100', 'individual posting kept');
assert(aggResult.skipped.aggregator === 2, 'two aggregator pages skipped');

// ── 11. progress events fire in expected order ──────────────────────

console.log('\n11. progress event ordering');

const events = [];
await runLevel3({
  searchQueries: [{ name: 'L', query: 'site:linkedin.com staff', enabled: true }],
  titleFilter: TITLE_FILTER,
  webSearch: async () => [{ url: 'https://l.com/1', title: 'Staff Engineer at X', snippet: '' }],
  livenessCheck: stubLive,
  onProgress: (p) => events.push(p.stage),
});

const startIdx = events.indexOf('start');
const searchStartIdx = events.indexOf('search:start');
const livenessStartIdx = events.indexOf('liveness:start');
const doneIdx = events.indexOf('done');

assert(startIdx >= 0 && searchStartIdx > startIdx, 'search:start after start');
assert(livenessStartIdx > searchStartIdx, 'liveness:start after search:start');
assert(doneIdx > livenessStartIdx, 'done after liveness:start');

// ── DONE ──────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
