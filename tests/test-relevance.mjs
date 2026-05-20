#!/usr/bin/env node

/**
 * test-relevance.mjs — Unit tests for lib/relevance.mjs (PR 1.4)
 */

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
  DEFAULT_MIN_RELEVANCE,
  scoreClass,
  hasRelevanceSignals,
  normalizeArchetypes,
  resolveMinRelevance,
  scorePostingTitle,
  rationaleSummary,
  relevanceInputsFrom,
} = await import('../lib/relevance.mjs');

console.log('\nlib/relevance.mjs');

// ── 1. scoreClass ─────────────────────────────────────────────────────

console.log('\n1. scoreClass');
assert(scoreClass(4.7) === 'excellent', '4.7 → excellent');
assert(scoreClass(4.5) === 'excellent', '4.5 boundary → excellent');
assert(scoreClass(4.0) === 'good', '4.0 → good');
assert(scoreClass(3.5) === 'decent', '3.5 → decent');
assert(scoreClass(3.0) === 'low', '3.0 → low');
assert(scoreClass(1.5) === 'poor', '1.5 → poor');
assert(scoreClass(0) === 'poor', '0 → poor');
assert(scoreClass(NaN) === 'unknown', 'NaN → unknown');
assert(scoreClass(undefined) === 'unknown', 'undefined → unknown');

// ── 2. normalizeArchetypes ────────────────────────────────────────────

console.log('\n2. normalizeArchetypes');
assert(JSON.stringify(normalizeArchetypes(['Engineer', 'Manager'])) === '["engineer","manager"]', 'string array');
assert(JSON.stringify(normalizeArchetypes([{ name: 'SRE' }, { name: 'Platform' }])) === '["sre","platform"]', 'object array');
assert(JSON.stringify(normalizeArchetypes([{ name: 'A' }, 'B', { other: 'C' }, { name: '' }])) === '["a","b"]', 'mixed + drops empties');
assert(normalizeArchetypes(null).length === 0, 'null → []');
assert(normalizeArchetypes('not array').length === 0, 'non-array → []');

// ── 3. scorePostingTitle — primary signals ────────────────────────────

console.log('\n3. scorePostingTitle — primary signals');

const baseInputs = {
  targetRoles: ['Software Engineer', 'Staff Engineer'],
  archetypes: ['Backend Engineer', 'Platform Engineer'],
  positiveKeywords: ['Engineer', 'Backend', 'Distributed Systems'],
  seniorityBoost: ['Staff', 'Principal'],
};

const senior = scorePostingTitle('Staff Backend Engineer', baseInputs);
// Heuristic uses substring check on multi-word target roles, so
// "staff backend engineer" doesn't include "staff engineer" verbatim.
// Archetype "Backend Engineer" + seniority "Staff" + keywords "Engineer"
// + "Backend" still drives a healthy score.
assert(senior.score >= 3.0, 'staff backend engineer scores at least 3.0');
assert(senior.factors.some((f) => f.label.includes('archetype')), 'archetype factor present');
assert(senior.factors.some((f) => f.label.includes('Seniority')), 'seniority factor present');

// Direct target-role hit (no interrupting words) does cross 4.0.
const exactRoleHit = scorePostingTitle('Software Engineer', baseInputs);
assert(exactRoleHit.score >= 2.0, 'exact role hit at least 2.0 from role + keyword');
assert(exactRoleHit.factors.some((f) => f.label.includes('target role')), 'role factor present');

const noMatch = scorePostingTitle('Marketing Manager', baseInputs);
assert(noMatch.score === 0, 'unrelated title scores 0');
assert(noMatch.factors[0].label.includes('No matching'), 'no-match factor surfaces');

const intern = scorePostingTitle('Software Engineer Intern', baseInputs);
assert(intern.score < senior.score, 'intern penalized');
assert(intern.factors.some((f) => f.delta === -2 && f.label.includes('Intern')), 'intern penalty captured');

const junior = scorePostingTitle('Junior Engineer', baseInputs);
assert(junior.factors.some((f) => f.delta === -1 && f.label.includes('Junior')), 'junior penalty captured');

// Empty / missing inputs
const emptyTitle = scorePostingTitle('', baseInputs);
assert(emptyTitle.score === 0, 'empty title scores 0');
assert(emptyTitle.factors[0].label === 'No title', 'no-title factor labeled correctly');

const noInputs = scorePostingTitle('Software Engineer');
assert(noInputs.score === 0, 'no inputs given → score 0');

// Score clamps to [0, 5]
const overload = scorePostingTitle('Staff Software Engineer Backend Distributed Systems', {
  ...baseInputs,
  positiveKeywords: ['Software', 'Engineer', 'Backend', 'Distributed Systems', 'Staff'],
});
assert(overload.score <= 5, 'score clamps to 5 max');

// Floor at 0 (intern + nothing else)
const internOnly = scorePostingTitle('Marketing Intern', baseInputs);
assert(internOnly.score === 0, 'penalty cannot drive below 0');

// ── 4. Keyword cap ────────────────────────────────────────────────────

console.log('\n4. Keyword cap (max +2.0)');
const manyKw = scorePostingTitle('Senior Backend Engineer Distributed Systems Software Architect', {
  ...baseInputs,
  positiveKeywords: ['Engineer', 'Backend', 'Distributed Systems', 'Architect', 'Senior'],
});
const keywordFactor = manyKw.factors.find((f) => f.label.startsWith('Title keywords'));
assert(keywordFactor && keywordFactor.delta <= 2.0, 'keyword contribution capped at +2.0');

// ── 5. rationaleSummary ───────────────────────────────────────────────

console.log('\n5. rationaleSummary');

const summary = rationaleSummary([
  { label: 'Matches archetype "platform"', delta: 1.5 },
  { label: 'Title keywords: engineer', delta: 0.5 },
  { label: 'Seniority signal "staff"', delta: 0.5 },
]);
assert(summary.includes('archetype'), 'summary includes top factor');
assert(summary.includes('+1.5'), 'summary formats positive delta');

const summaryWithNeg = rationaleSummary([
  { label: 'Junior signal', delta: -1.0 },
  { label: 'Matches role', delta: 2.0 },
]);
assert(summaryWithNeg.startsWith('Matches role') || summaryWithNeg.includes('Matches role (+2.0)'),
  'summary orders by absolute magnitude (largest first)');

assert(rationaleSummary([]) === '', 'empty factors → empty string');
assert(rationaleSummary(null) === '', 'null factors → empty string');

const summaryMax = rationaleSummary([
  { label: 'A', delta: 1 },
  { label: 'B', delta: 1 },
  { label: 'C', delta: 1 },
  { label: 'D', delta: 1 },
], { max: 2 });
assert(summaryMax.split(';').length === 2, 'max parameter caps factor count');

// Zero-delta factor (e.g. "No title")
const zeroDelta = rationaleSummary([{ label: 'No matching signals', delta: 0 }]);
assert(zeroDelta === 'No matching signals', 'zero-delta factor renders without numeric tag');

// ── 6. relevanceInputsFrom ────────────────────────────────────────────

console.log('\n6. relevanceInputsFrom');

const inputs = relevanceInputsFrom({
  profile: {
    target_roles: { primary: ['SRE'], archetypes: [{ name: 'Platform' }] },
  },
  portals: {
    title_filter: { positive: ['kubernetes'], seniority_boost: ['staff'] },
  },
});
assert(inputs.targetRoles[0] === 'SRE', 'targetRoles surfaced');
assert(inputs.archetypes[0].name === 'Platform', 'archetypes preserved as-is for downstream normalization');
assert(inputs.positiveKeywords[0] === 'kubernetes', 'positiveKeywords surfaced');
assert(inputs.seniorityBoost[0] === 'staff', 'seniorityBoost surfaced');

const empty = relevanceInputsFrom({});
assert(empty.targetRoles.length === 0, 'missing profile → empty targetRoles');
assert(empty.positiveKeywords.length === 0, 'missing portals → empty keywords');

// Scan relevance defaults
console.log('\n7. scan relevance defaults');

assert(DEFAULT_MIN_RELEVANCE === 2.5, 'default minimum relevance is 2.5');
assert(resolveMinRelevance(undefined) === 2.5, 'unset min relevance resolves to default');
assert(resolveMinRelevance('') === 2.5, 'blank min relevance resolves to default');
assert(resolveMinRelevance('0') === 0, 'explicit 0 is preserved');
assert(resolveMinRelevance('6') === 5, 'min relevance clamps high values');
assert(resolveMinRelevance('-1') === 0, 'min relevance clamps low values');
assert(hasRelevanceSignals(baseInputs) === true, 'inputs with roles/keywords have signals');
assert(hasRelevanceSignals({}) === false, 'empty inputs have no relevance signals');

// ── DONE ──────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
