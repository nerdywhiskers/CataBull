#!/usr/bin/env node

import { classifyLiveness } from '../lib/liveness-core.mjs';

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

console.log('\nLiveness core');

const linkedInClosed = classifyLiveness({
  status: 200,
  finalUrl: 'https://www.linkedin.com/jobs/view/123',
  bodyText: 'Short shell',
  titleText: 'LinkedIn Job Posting: No longer accepting applications',
  applyControls: ['Apply'],
});
assert(linkedInClosed.result === 'expired', 'LinkedIn closed title beats visible apply control');

const activeWithApply = classifyLiveness({
  status: 200,
  finalUrl: 'https://company.com/jobs/123',
  bodyText: 'Full job description '.repeat(30),
  titleText: 'Senior Engineer',
  applyControls: ['Apply now'],
});
assert(activeWithApply.result === 'active', 'visible apply control marks posting active');

const listingRedirect = classifyLiveness({
  status: 200,
  finalUrl: 'https://company.com/jobs',
  bodyText: 'Search for jobs page is loaded',
  titleText: 'Jobs',
  applyControls: [],
});
assert(listingRedirect.result === 'expired', 'listing/search pages count as expired');

const uncertainServerError = classifyLiveness({
  status: 503,
  finalUrl: 'https://company.com/jobs/123',
  bodyText: '',
  titleText: '',
  applyControls: [],
});
assert(uncertainServerError.result === 'uncertain', '5xx remains uncertain');

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exitCode = 1;
