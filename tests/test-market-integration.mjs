#!/usr/bin/env node

import { runLevel4 } from '../dashboard-web/routes/scan-deep.mjs';

let passed = 0;
let failed = 0;
let total = 0;

function assert(cond, msg) {
  total++;
  if (cond) passed++;
  else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

console.log('\nmarket integration');

const events = [];
const send = (_event, payload) => events.push(payload);
const providerMap = new Map([
  ['remotive', {
    name: 'remotive',
    async fetch() {
      return {
        available: true,
        jobs: [
          { url: 'https://jobs.test/1', title: 'Platform Engineer', company: 'Acme', location: 'Remote', postedAt: '2026-06-12', source: 'market:remotive' },
          { url: 'https://jobs.test/2', title: 'Sales Manager', company: 'Acme', location: 'Remote', postedAt: '2026-06-12', source: 'market:remotive' },
        ],
      };
    },
  }],
  ['remoteok', {
    name: 'remoteok',
    async fetch() {
      return {
        available: true,
        jobs: [
          { url: 'https://jobs.test/1', title: 'Platform Engineer', company: 'Acme', location: 'Remote', postedAt: '2026-06-12', source: 'market:remoteok' },
          { url: 'https://jobs.test/3', title: 'ML Engineer', company: 'Beta', location: 'Remote', postedAt: '2026-06-12', source: 'market:remoteok' },
        ],
      };
    },
  }],
]);

const result = await runLevel4({
  root: process.cwd(),
  portals: {
    title_filter: { positive: ['engineer'], negative: ['sales'] },
    market: { providers: ['jobspy', 'remotive', 'remoteok'], provider_limits: { remotive: 10, remoteok: 10 } },
  },
  remainingCap: 10,
  seenUrls: new Set(),
  seenCompanyRoles: new Set(),
  livenessCheck: async (url) => {
    if (url === 'https://jobs.test/3') return { result: 'expired', reason: 'closed' };
    return { result: 'active', reason: 'apply button visible' };
  },
  send,
  detectRunnerImpl: async () => ({ kind: 'none' }),
  runJobSpyImpl: async () => ({ available: false, jobs: [] }),
  getMarketProviderImpl: (name) => providerMap.get(name) || null,
  listMarketProvidersImpl: () => Array.from(providerMap.values()),
});

assert(result.available === true, 'runLevel4 succeeds when one provider skips');
assert(result.added.length === 1, 'runLevel4 keeps one live deduped title match');
assert(result.added[0].url === 'https://jobs.test/1', 'dedupe keeps first matching URL');
assert(result.added[0].source === 'market:remotive', 'source survives final pipeline shape');
assert(result.skipped.title === 1, 'title filter rejects non-matching roles');
assert(result.skipped.dup === 1, 'duplicate URLs collapse across providers');
assert(result.skipped.expired === 1, 'expired liveness results are dropped');
assert(events.some((payload) => payload.stage === 'l4:provider:skip' && payload.provider === 'jobspy'), 'jobspy skip event emitted without killing run');
assert(events.some((payload) => payload.stage === 'l4:provider:done' && payload.provider === 'remotive'), 'provider completion event emitted');

const blockedVariantResult = await runLevel4({
  root: process.cwd(),
  portals: {
    title_filter: { positive: ['engineer'], negative: [] },
    market: { providers: ['remotive'], provider_limits: { remotive: 10 } },
  },
  remainingCap: 10,
  seenUrls: new Set(),
  seenCompanyRoles: new Set(),
  blockedPostings: [{ url: 'https://old-board.test/jobs/1', company: 'Acme', role: 'Staff Platform Engineer' }],
  livenessCheck: async () => ({ result: 'active', reason: 'apply button visible' }),
  send,
  getMarketProviderImpl: () => ({
    name: 'remotive',
    async fetch() {
      return { jobs: [{ url: 'https://new-board.test/jobs/2', title: 'Senior Staff Platform Engineer', company: 'Acme', source: 'market:remotive' }] };
    },
  }),
  listMarketProvidersImpl: () => [{ name: 'remotive' }],
});
assert(blockedVariantResult.added.length === 0, 'Level 4 suppresses a deleted near-title variant from another provider');
assert(blockedVariantResult.skipped.dup === 1, 'Level 4 deleted near-title variant counts as duplicate');

console.log(`\nPassed: ${passed}/${total}`);
if (failed > 0) process.exit(1);
