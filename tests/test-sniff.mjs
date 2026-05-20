#!/usr/bin/env node

/**
 * test-sniff.mjs — Unit tests for scan/providers/sniff.mjs (W5)
 *
 * Pure HTML-parsing tests: feed in fixture HTML, verify the right ATS
 * candidates come out and the right primary is picked. No browser, no
 * network.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition, msg) {
  total++;
  if (condition) {
    passed++;
    if (VERBOSE) console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

console.log('\nscan/providers/sniff.mjs (W5)');

const { sniffAtsLinks, extractHrefs } = await import(
  pathToFileURL(join(ROOT, 'scan', 'providers', 'sniff.mjs')).href
);

// ── 1. extractHrefs ─────────────────────────────────────────────────

console.log('\n1. extractHrefs');

const simple = extractHrefs(
  '<a href="https://example.com/x">Click</a>',
  'https://base.example/',
);
assert(simple.length === 1, 'single anchor → 1 result');
assert(simple[0].href === 'https://example.com/x', 'href absolute and preserved');
assert(simple[0].text === 'Click', 'anchor text extracted');

const relative = extractHrefs(
  '<a href="/jobs">Open positions</a>',
  'https://example.com/careers',
);
assert(relative[0].href === 'https://example.com/jobs', 'relative href resolved against base');

const javascript = extractHrefs(
  '<a href="javascript:void(0)">Foo</a><a href="mailto:hr@x.com">Email</a><a href="#top">Top</a>',
  'https://x.com/',
);
assert(javascript.length === 0, 'javascript: / mailto: / # all dropped');

const malformed = extractHrefs('<a>no href</a><a href="">empty</a>', 'https://x.com/');
assert(malformed.length === 0, 'missing/empty hrefs dropped');

const nested = extractHrefs(
  '<a href="https://jobs.lever.co/x"><span>View <strong>jobs</strong></span></a>',
  'https://x.com/',
);
assert(nested[0].text === 'View jobs', 'nested tags stripped from anchor text');

const entities = extractHrefs(
  '<a href="https://x.com/?a=1&amp;b=2">A &amp; B</a>',
  'https://x.com/',
);
assert(entities[0].text === 'A & B', 'HTML entities decoded in text');
assert(entities[0].href.includes('&'), 'HTML entities decoded in href');

const tooMany = extractHrefs(
  Array.from({ length: 1500 }, (_, i) => `<a href="https://x.com/${i}">${i}</a>`).join(''),
  'https://x.com/',
);
assert(tooMany.length === 1000, 'MAX_ANCHORS cap enforced (1000)');

// ── 2. sniffAtsLinks — single-provider matches ──────────────────────

console.log('\n2. Single-provider detection');

const ghHtml = `
  <html><body>
    <h1>Anthropic Careers</h1>
    <a href="https://job-boards.greenhouse.io/anthropic">View open positions</a>
  </body></html>
`;
const ghResult = sniffAtsLinks(ghHtml, 'https://anthropic.com/careers', { companyName: 'Anthropic' });
assert(ghResult.matches.length === 1, 'one Greenhouse link → one match');
assert(ghResult.matches[0].provider === 'greenhouse', 'provider correctly identified as greenhouse');
assert(ghResult.matches[0].slug === 'anthropic', 'slug extracted from URL');
assert(ghResult.primary !== null, 'sole match becomes primary');
assert(ghResult.primary.provider === 'greenhouse', 'primary points at greenhouse');

const ashbyHtml = `<a href="https://jobs.ashbyhq.com/openai">Apply now</a>`;
const ashbyResult = sniffAtsLinks(ashbyHtml, 'https://openai.com/', { companyName: 'OpenAI' });
assert(ashbyResult.matches[0].provider === 'ashby', 'Ashby URL detected');
assert(ashbyResult.matches[0].slug === 'openai', 'Ashby slug extracted');

const leverHtml = `<a href="https://jobs.lever.co/cohere">View open jobs</a>`;
const leverResult = sniffAtsLinks(leverHtml, 'https://cohere.com/', { companyName: 'Cohere' });
assert(leverResult.matches[0].provider === 'lever', 'Lever URL detected');

const wdHtml = `<a href="https://adobe.wd5.myworkdayjobs.com/external_experienced">Search jobs</a>`;
const wdResult = sniffAtsLinks(wdHtml, 'https://www.adobe.com/careers', { companyName: 'Adobe' });
assert(wdResult.matches[0].provider === 'workday', 'Workday URL detected');
assert(wdResult.matches[0].tenant === 'adobe', 'Workday tenant extracted');
assert(wdResult.matches[0].shard === 'wd5', 'Workday shard extracted');
assert(wdResult.matches[0].site === 'external_experienced', 'Workday site extracted');

const bambooHtml = `<a href="https://example.bamboohr.com/careers/list">Open roles</a>`;
const bambooResult = sniffAtsLinks(bambooHtml, 'https://example.com/', { companyName: 'Example' });
assert(bambooResult.matches[0].provider === 'bamboohr', 'BambooHR URL detected');

const ttHtml = `<a href="https://acme.teamtailor.com/jobs">Careers</a>`;
const ttResult = sniffAtsLinks(ttHtml, 'https://acme.com/', { companyName: 'Acme' });
assert(ttResult.matches[0].provider === 'teamtailor', 'Teamtailor URL detected');

// ── 3. Multi-provider, ambiguity ────────────────────────────────────

console.log('\n3. Ambiguity handling');

const multiProvider = `
  <a href="https://job-boards.greenhouse.io/foo">Greenhouse foo</a>
  <a href="https://jobs.ashbyhq.com/bar">Ashby bar</a>
`;
const multiResult = sniffAtsLinks(multiProvider, 'https://x.com/', { companyName: 'Unknown' });
assert(multiResult.matches.length === 2, 'two providers → two matches');
assert(multiResult.primary === null, 'ambiguous match → primary=null (no name signal)');

// Tie-breaker: company name matches one of the slugs
const nameTieBreaker = sniffAtsLinks(multiProvider, 'https://x.com/', { companyName: 'foo' });
assert(nameTieBreaker.primary !== null, 'company name "foo" picks the foo slug');
assert(nameTieBreaker.primary.slug === 'foo', 'primary slug = foo');

// Tie-breaker: anchor text CTA boost
const ctaBoost = `
  <a href="https://job-boards.greenhouse.io/foo">cookie policy</a>
  <a href="https://jobs.ashbyhq.com/bar">View all open positions</a>
`;
const ctaResult = sniffAtsLinks(ctaBoost, 'https://x.com/', { companyName: 'unrelated' });
assert(ctaResult.primary?.slug === 'bar', 'CTA-style anchor wins ambiguous match');

// ── 4. Deduplication ────────────────────────────────────────────────

console.log('\n4. Deduplication');

const dupHtml = `
  <a href="https://job-boards.greenhouse.io/anthropic">View jobs</a>
  <a href="https://job-boards.greenhouse.io/anthropic">View jobs</a>
  <a href="https://job-boards.greenhouse.io/anthropic#top">View jobs</a>
`;
const dupResult = sniffAtsLinks(dupHtml, 'https://x.com/', { companyName: 'Anthropic' });
assert(dupResult.matches.length === 1, 'same (provider, slug) collapses across multiple anchors');
assert(dupResult.matches[0].occurrences >= 2, 'occurrences counter tallies all hits');

// ── 5. Self-reference filter ────────────────────────────────────────

console.log('\n5. Self-reference filter');

const selfRef = `
  <a href="https://www.example.com/careers">Careers (self)</a>
  <a href="https://job-boards.greenhouse.io/example">Real ATS</a>
`;
const selfResult = sniffAtsLinks(selfRef, 'https://www.example.com/careers', { companyName: 'Example' });
// example.com itself isn't an ATS host so it's already filtered. Add a direct
// same-URL self-ref to the test to be sure:
const exactSelf = `
  <a href="https://job-boards.greenhouse.io/example">Self (would loop)</a>
  <a href="https://job-boards.greenhouse.io/foo">Other</a>
`;
const exactSelfResult = sniffAtsLinks(
  exactSelf,
  'https://job-boards.greenhouse.io/example',
  { companyName: 'Example' },
);
assert(
  !exactSelfResult.matches.some((m) => m.url === 'https://job-boards.greenhouse.io/example'),
  'exact self-URL is dropped to prevent retry loops',
);

// ── 6. Empty / no-match input ───────────────────────────────────────

console.log('\n6. Empty inputs');

assert(sniffAtsLinks('', 'https://x.com/').matches.length === 0, 'empty HTML → empty matches');
assert(sniffAtsLinks('<p>no links here</p>', 'https://x.com/').matches.length === 0, 'no anchors → empty matches');
assert(
  sniffAtsLinks('<a href="https://wikipedia.org">Wikipedia</a>', 'https://x.com/').matches.length === 0,
  'non-ATS link → empty matches',
);

// ── 7. Workday tenant disambiguation ────────────────────────────────

console.log('\n7. Workday multi-tenant');

const wdMulti = `
  <a href="https://adobe.wd5.myworkdayjobs.com/external_experienced">Adobe (experienced)</a>
  <a href="https://adobe.wd5.myworkdayjobs.com/early_career">Adobe (early career)</a>
`;
const wdMultiResult = sniffAtsLinks(wdMulti, 'https://adobe.com/careers', { companyName: 'Adobe' });
assert(
  wdMultiResult.matches.length === 2,
  'different Workday sites under same tenant produce distinct matches',
);
assert(
  wdMultiResult.matches.every((m) => m.provider === 'workday'),
  'both matches are Workday',
);

// ── 8. Slug similarity scoring ──────────────────────────────────────

console.log('\n8. Slug similarity scoring');

const company = 'Anthropic Inc.';
const candidates = `
  <a href="https://job-boards.greenhouse.io/anthropic">A</a>
  <a href="https://jobs.ashbyhq.com/competitor">B</a>
`;
const scored = sniffAtsLinks(candidates, 'https://x.com/', { companyName: company });
const anthropicMatch = scored.matches.find((m) => m.slug === 'anthropic');
const competitorMatch = scored.matches.find((m) => m.slug === 'competitor');
assert(anthropicMatch?.score > competitorMatch?.score, 'matching-name slug scores higher');
assert(scored.primary?.slug === 'anthropic', 'primary picks the matching-name slug');

// ── 9. Suffix stripping (Inc/LLC/Ltd) ───────────────────────────────

console.log('\n9. Company suffix normalization');

const suffix = sniffAtsLinks(
  '<a href="https://jobs.ashbyhq.com/foo">F</a>',
  'https://x.com/',
  { companyName: 'Foo, Inc.' },
);
assert(suffix.matches[0].score >= 6, 'Inc suffix stripped before slug-match scoring');

// ── DONE ────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
