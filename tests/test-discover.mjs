#!/usr/bin/env node

/**
 * test-discover.mjs — Unit tests for the Discover tab's pure helpers
 * (PR 1.3). All logic that doesn't touch the DOM lives in
 * dashboard-web/public/js/lib/discover-grouping.mjs and is exercised
 * here.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
let failed = 0;
let total = 0;

function assert(cond, msg) {
  total++;
  if (cond) {
    passed++;
    if (VERBOSE) console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

const {
  buildDiscoverFilter,
  groupPostingsByCompany,
  sortByRelevance,
  collectIndustries,
} = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'public', 'js', 'lib', 'discover-grouping.mjs')).href
);

console.log('\nDiscover tab helpers (PR 1.3)');

// Fixtures
const postings = [
  { url: 'a', company: 'Anthropic', role: 'Staff Engineer',     relevance: 4.5, postedAt: '2026-05-01' },
  { url: 'b', company: 'Anthropic', role: 'Senior PM',           relevance: 3.2, postedAt: '2026-05-02' },
  { url: 'c', company: 'Cohere',    role: 'Founding Engineer',   relevance: 4.0, postedAt: '2026-05-03' },
  { url: 'd', company: 'Stripe',    role: 'Designer',            relevance: 1.5, postedAt: '2026-05-04' },
  { url: 'e', company: 'Cohere',    role: 'Research Engineer',   relevance: 4.8, postedAt: '2026-05-05' },
  { url: 'f', company: 'Vinted',    role: 'Backend Engineer',    relevance: 3.0, postedAt: '2026-05-06' },
];

const portalsTracked = [
  { name: 'Anthropic', industries: ['ai', 'developer_tools'] },
  { name: 'Cohere',    industries: ['ai'] },
  { name: 'Stripe',    industries: ['fintech'] },
  { name: 'Vinted',    industries: ['ecommerce'] },
];

function industryResolver(p) {
  const c = portalsTracked.find((c) => c.name === p.company);
  return Array.isArray(c?.industries) ? c.industries : [];
}

// ── 1. buildDiscoverFilter ────────────────────────────────────────────

console.log('\n1. buildDiscoverFilter');

// No filters → everything passes
const allPass = buildDiscoverFilter({});
assert(postings.every(allPass), 'no filters → all pass');

// minScore floor
const min4 = buildDiscoverFilter({ minScore: 4 });
assert(postings.filter(min4).length === 3, 'minScore 4 keeps 3 of 6 postings');
assert(!min4(postings.find((p) => p.relevance === 3.2)), 'min 4 drops 3.2');

// Industry filter — single
const aiOnly = buildDiscoverFilter({
  industries: new Set(['ai']),
  resolveIndustries: industryResolver,
});
const aiPass = postings.filter(aiOnly);
assert(aiPass.length === 4, 'ai-only filter keeps Anthropic + Cohere postings (4)');
assert(aiPass.every((p) => p.company === 'Anthropic' || p.company === 'Cohere'), 'industry filter respects portals lookup');

// Industry filter — multiple (OR semantics)
const aiOrFintech = buildDiscoverFilter({
  industries: new Set(['ai', 'fintech']),
  resolveIndustries: industryResolver,
});
assert(postings.filter(aiOrFintech).length === 5, 'ai OR fintech → 5 (Anthropic 2 + Cohere 2 + Stripe 1)');

// Company free-text
const filtAnt = buildDiscoverFilter({ company: 'anthropic' });
assert(postings.filter(filtAnt).length === 2, 'company text filter case-insensitive');

// Search query (matches company OR role)
const filtEng = buildDiscoverFilter({ search: 'engineer' });
const engRoles = postings.filter(filtEng);
assert(engRoles.length === 4, 'search "engineer" matches 4 roles');
assert(engRoles.every((p) => /engineer/i.test(p.role)), 'all matched have engineer in role');

// Combined filters compose with AND
const combined = buildDiscoverFilter({
  minScore: 4,
  industries: new Set(['ai']),
  resolveIndustries: industryResolver,
});
const combinedPass = postings.filter(combined);
assert(combinedPass.length === 3, '≥4 score AND ai industry → 3');

// Edge cases
assert(allPass(null) === false, 'null posting → filtered out');
assert(allPass(undefined) === false, 'undefined posting → filtered out');
const noRelevance = { url: 'x', company: 'X', role: 'Y' };
assert(min4(noRelevance) === false, 'missing relevance treated as 0');

// resolveIndustries returning null doesn't crash
const safeResolver = buildDiscoverFilter({
  industries: new Set(['ai']),
  resolveIndustries: () => null,
});
assert(safeResolver(postings[0]) === false, 'null resolveIndustries → no industry match');

// ── 2. groupPostingsByCompany ─────────────────────────────────────────

console.log('\n2. groupPostingsByCompany');

const groups = groupPostingsByCompany(postings);
assert(groups.length === 4, 'groups by company name (4 unique)');

const cohere = groups.find((g) => g.company === 'Cohere');
assert(cohere.count === 2, 'Cohere has 2 postings');
assert(cohere.bestScore === 4.8, 'Cohere bestScore = 4.8');
assert(cohere.items[0].relevance === 4.8, 'items sorted by relevance desc');
assert(cohere.items[1].relevance === 4.0, 'second item lower');

// Top group by bestScore
assert(groups[0].company === 'Cohere', 'Cohere first (4.8 best)');
assert(groups[1].company === 'Anthropic', 'Anthropic second (4.5 best)');
assert(groups[2].company === 'Vinted', 'Vinted third (3.0 best)');
assert(groups[3].company === 'Stripe', 'Stripe last (1.5 best)');

// Empty input
assert(groupPostingsByCompany([]).length === 0, 'empty input → []');
assert(groupPostingsByCompany(null).length === 0, 'null input → []');

// Postings without company name → '(unknown)' bucket
const withMissing = [{ url: 'z', role: 'Mystery', relevance: 5.0 }];
const u = groupPostingsByCompany(withMissing);
assert(u.length === 1 && u[0].company === '(unknown)', 'missing company name lands in unknown bucket');

// Tie-breaking on equal best scores — alphabetical
const tied = [
  { company: 'Beta', role: 'X', relevance: 4 },
  { company: 'Alpha', role: 'Y', relevance: 4 },
];
const tiedGroups = groupPostingsByCompany(tied);
assert(tiedGroups[0].company === 'Alpha', 'tie broken alphabetically (Alpha before Beta)');

// ── 3. sortByRelevance ────────────────────────────────────────────────

console.log('\n3. sortByRelevance');

const flat = sortByRelevance(postings);
assert(flat[0].relevance === 4.8, 'top = 4.8');
assert(flat[flat.length - 1].relevance === 1.5, 'bottom = 1.5');
assert(flat.length === postings.length, 'length preserved');

// Doesn't mutate input
const original = postings.map((p) => p.relevance).join(',');
sortByRelevance(postings);
assert(postings.map((p) => p.relevance).join(',') === original, 'sort does not mutate input');

assert(sortByRelevance([]).length === 0, 'empty input ok');
assert(sortByRelevance(null).length === 0, 'null input ok');

// ── 4. collectIndustries ──────────────────────────────────────────────

console.log('\n4. collectIndustries');

const inds = collectIndustries(portalsTracked);
assert(inds.length === 4, '4 unique industries');
assert(inds.includes('ai'), 'ai present');
assert(inds.includes('fintech'), 'fintech present');
assert(inds[0] === 'ai', 'returned sorted alphabetically');

const dup = collectIndustries([
  { name: 'A', industries: ['ai', 'gaming'] },
  { name: 'B', industries: ['ai', 'fintech'] },
  { name: 'C', industries: null },        // wrong type — skip
  { name: 'D' },                          // missing — skip
]);
assert(dup.length === 3, 'dedups across companies; null/missing tolerated');
assert(dup.includes('gaming'), 'gaming surfaced');
assert(dup.includes('ai'), 'ai surfaced');
assert(dup.includes('fintech'), 'fintech surfaced');

assert(collectIndustries([]).length === 0, 'empty input → []');
assert(collectIndustries(null).length === 0, 'null input → []');

// ── DONE ──────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
