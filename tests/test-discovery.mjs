#!/usr/bin/env node

/**
 * test-discovery.mjs — Unit tests for lib/discovery.mjs and
 * lib/title-filter.mjs (PR 1.1).
 *
 * All dependencies (verifier, health checker) are stubbed in-process.
 * No real network or agent calls.
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
  buildTitleFilter,
  buildKeywordPattern,
} = await import('../lib/title-filter.mjs');

const {
  categorizeRoleFit,
  verifyCompanyUrlPrompt,
  discoverCompany,
  discoverCompanies,
  buildProvenanceNote,
  ROLE_FIT_MIN_JOB_SAMPLE,
} = await import('../lib/discovery.mjs');

// ── 1. TITLE FILTER (extracted from scan.mjs) ─────────────────────────

console.log('\n1. lib/title-filter.mjs');

assert(buildKeywordPattern('') === null, 'empty keyword returns null');
assert(buildKeywordPattern('   ') === null, 'whitespace-only returns null');
assert(buildKeywordPattern('Engineer').test('Senior Engineer'), 'matches plain word');
assert(!buildKeywordPattern('Engineer').test('Engineering'), 'word boundary stops Engineering');
assert(buildKeywordPattern('.NET').test('.NET Developer'), '.NET still matches despite leading dot');
assert(buildKeywordPattern('C++').test('C++ Engineer'), 'C++ matches');
assert(buildKeywordPattern('münchen').test('Munich München office'), 'unicode case-insensitive');

const filter = buildTitleFilter({
  positive: ['Engineer', 'Developer'],
  negative: ['Junior', 'Intern', 'Senior'],
});
assert(filter('Senior Engineer') === false, 'negative excludes match');
assert(filter('Lead Engineer') === true, 'positive only passes');
assert(filter('Marketing Manager') === false, 'no positive match fails');
assert(filter('') === false, 'empty title fails');
assert(filter(null) === false, 'null title fails');

const noPositiveFilter = buildTitleFilter({
  positive: [],
  negative: ['Junior'],
});
assert(noPositiveFilter('Anything') === true, 'empty positives means always-pass except negatives');
assert(noPositiveFilter('Junior Anything') === false, 'negative still excludes');

// ── 2. categorizeRoleFit ──────────────────────────────────────────────

console.log('\n2. categorizeRoleFit');

const englishOnly = buildTitleFilter({ positive: ['Engineer'], negative: [] });

assert(
  categorizeRoleFit([], englishOnly).fit === 'empty',
  'empty job list → empty'
);
assert(
  categorizeRoleFit([{ title: 'Senior Engineer' }], englishOnly).fit === 'matches',
  '1 match (single job sample) → matches'
);

const sampleNoMatch = Array.from({ length: 6 }, (_, i) => ({ title: `Designer ${i}` }));
assert(
  categorizeRoleFit(sampleNoMatch, englishOnly).fit === 'no_current_matches',
  '0 matches but 6 jobs → no_current_matches'
);
const justBelowSample = Array.from({ length: 4 }, (_, i) => ({ title: `Designer ${i}` }));
assert(
  categorizeRoleFit(justBelowSample, englishOnly).fit === 'empty',
  '0 matches and only 4 jobs → empty (insufficient sample)'
);
assert(
  ROLE_FIT_MIN_JOB_SAMPLE === 5,
  'sample threshold matches W7 spec (≥5)'
);

const meta = categorizeRoleFit(
  [
    { title: 'Software Engineer' },
    { title: 'Design Lead' },
    { title: 'Senior Engineer' },
  ],
  englishOnly
);
assert(meta.matchCount === 2, 'matchCount counted accurately');
assert(meta.totalSampled === 3, 'totalSampled tracks input length');

// ── 3. verifyCompanyUrlPrompt shape ───────────────────────────────────

console.log('\n3. verifyCompanyUrlPrompt');

const prompt = verifyCompanyUrlPrompt('Anthropic');
assert(prompt.includes('Anthropic'), 'prompt mentions company');
assert(prompt.includes('WebSearch'), 'prompt instructs WebSearch');
assert(prompt.toLowerCase().includes('greenhouse'), 'prompt lists ATS hosts');
assert(prompt.includes('careers_url'), 'prompt declares JSON shape');
assert(prompt.includes('null'), 'prompt explicitly allows null');

// ── 4. discoverCompany — happy path ───────────────────────────────────

console.log('\n4. discoverCompany — happy path');

const stubVerify = async (name) => ({
  careers_url: `https://job-boards.greenhouse.io/${name.toLowerCase()}`,
  provider: 'greenhouse',
  confidence: 'high',
  notes: `${name}'s ATS confirmed`,
});

const stubHealthHealthy = async (company) => ({
  name: company.name,
  status: 'healthy',
  provider: 'greenhouse',
  probedUrl: company.careers_url,
  jobCount: 12,
  sampleJobs: [
    { title: 'Senior Engineer' },
    { title: 'Staff Engineer' },
    { title: 'Director of Marketing' },
  ],
  checkedAt: new Date().toISOString(),
});

const happy = await discoverCompany(
  { name: 'Acme', industries: ['ai'] },
  {
    verify: stubVerify,
    checkCompany: stubHealthHealthy,
    titleFilter: { positive: ['Engineer'], negative: [] },
  }
);
assert(happy.status === 'enabled', 'happy path → enabled');
assert(happy.careers_url === 'https://job-boards.greenhouse.io/acme', 'careers_url passed through');
assert(happy.role_fit === 'matches', 'role fit = matches');
assert(happy.role_fit_meta.matchCount === 2, 'matchCount across sample');
assert(happy.sample_jobs.length === 3, 'sample_jobs preserved');
assert(happy.provider === 'greenhouse', 'provider passed through');

// ── 5. discoverCompany — disabled paths ───────────────────────────────

console.log('\n5. discoverCompany — disabled paths');

// no URL
const noUrl = await discoverCompany(
  { name: 'NoBrand' },
  {
    verify: async () => null,
    checkCompany: stubHealthHealthy,
    titleFilter: { positive: ['Engineer'], negative: [] },
  }
);
assert(noUrl.status === 'disabled_no_url', 'verify returns null → disabled_no_url');
assert(noUrl.careers_url == null, 'no careers_url leaked through');

// health fail
const healthFail = await discoverCompany(
  { name: 'Broken' },
  {
    verify: stubVerify,
    checkCompany: async () => ({ name: 'Broken', status: 'not_found', error: 'HTTP 404' }),
    titleFilter: { positive: ['Engineer'], negative: [] },
  }
);
assert(healthFail.status === 'disabled_health', 'health fail → disabled_health');
assert(healthFail.health.status === 'not_found', 'underlying health record preserved');

// no current matches
const noFitSample = Array.from({ length: 8 }, (_, i) => ({ title: `Designer ${i}` }));
const noFit = await discoverCompany(
  { name: 'DesignCo' },
  {
    verify: stubVerify,
    checkCompany: async (c) => ({ name: c.name, status: 'healthy', sampleJobs: noFitSample }),
    titleFilter: { positive: ['Engineer'], negative: [] },
  }
);
assert(noFit.status === 'disabled_no_fit', '0 matches in 8 sampled → disabled_no_fit');
assert(noFit.role_fit === 'no_current_matches', 'role_fit = no_current_matches');

// empty sample
const empty = await discoverCompany(
  { name: 'Quiet' },
  {
    verify: stubVerify,
    checkCompany: async (c) => ({ name: c.name, status: 'healthy', sampleJobs: [] }),
    titleFilter: { positive: ['Engineer'], negative: [] },
  }
);
assert(empty.status === 'disabled_empty', '0 jobs → disabled_empty');

// missing name
const noName = await discoverCompany({ name: '' });
assert(noName.status === 'error', 'empty name → error');

// verifier throws
const throwing = await discoverCompany(
  { name: 'Bad' },
  {
    verify: async () => { throw new Error('boom'); },
    checkCompany: stubHealthHealthy,
  }
);
assert(throwing.status === 'error', 'verifier throw caught');
assert(throwing.error.includes('boom'), 'error message preserved');

// ── 6. discoverCompanies — concurrency + progress ─────────────────────

console.log('\n6. discoverCompanies orchestration');

let inFlight = 0;
let maxInFlight = 0;
const slowVerify = async (name) => {
  inFlight++;
  if (inFlight > maxInFlight) maxInFlight = inFlight;
  await new Promise((r) => setTimeout(r, 30));
  inFlight--;
  return {
    careers_url: `https://job-boards.greenhouse.io/${name.toLowerCase()}`,
    provider: 'greenhouse',
    confidence: 'high',
  };
};

const candidates = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n) => ({ name: n }));
const progressEvents = [];

const results = await discoverCompanies(candidates, {
  concurrency: 3,
  onProgress: (p) => progressEvents.push(p),
  verify: slowVerify,
  checkCompany: stubHealthHealthy,
  titleFilter: { positive: ['Engineer'], negative: [] },
});

assert(results.length === 7, 'one result per candidate');
assert(results.every((r) => r.status === 'enabled'), 'all enabled with stubbed health');
assert(maxInFlight <= 3, 'concurrency cap respected (saw at most 3 in flight)');
assert(progressEvents.length === 7, 'progress fires once per candidate');
assert(progressEvents[6].done === 7 && progressEvents[6].total === 7, 'final event has full count');

// Order preserved
const ordered = results.map((r) => r.name);
assert(JSON.stringify(ordered) === JSON.stringify(['A', 'B', 'C', 'D', 'E', 'F', 'G']),
  'results preserve input order despite parallel dispatch');

// ── 7. buildProvenanceNote ────────────────────────────────────────────

console.log('\n7. buildProvenanceNote');

const note = buildProvenanceNote(happy, { date: '2026-05-06' });
assert(note.includes('2026-05-06'), 'note includes date');
assert(note.includes('high confidence'), 'confidence surfaced');
assert(note.includes('2 of 3'), 'role-fit ratio surfaced');

const noteDisabled = buildProvenanceNote(noFit, { date: '2026-05-06' });
assert(noteDisabled.includes('disabled: no_fit'), 'disabled status note');

assert(buildProvenanceNote(null) === '', 'null result → empty note');

// ── DONE ──────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
