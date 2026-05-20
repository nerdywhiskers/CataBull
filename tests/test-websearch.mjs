#!/usr/bin/env node

/**
 * test-websearch.mjs — Unit tests for scan/websearch.mjs.
 *
 * No live network — every test injects a mock `fetchImpl`. The
 * scrape provider's HTML parser is exercised with a captured DDG
 * fixture so the test stays stable even if the live site changes.
 */

import { resolveProvider, searchWeb, parseDuckDuckGoHtml, pickProviderName, providerOrder, WebSearchError } from '../scan/websearch.mjs';

let passed = 0;
let failed = 0;
let total = 0;

function assert(cond, msg) {
  total++;
  if (cond) { passed++; }
  else { failed++; console.log(`  ❌ ${msg}`); }
}

function mockResponse({ ok = true, status = 200, json, text }) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => text,
  };
}

function mockFetch(handler) {
  return async (url, init) => handler(url, init);
}

console.log('\nscan/websearch.mjs');

// ── 1. resolveProvider ─────────────────────────────────────────────

console.log('\n1. resolveProvider');

assert(resolveProvider({ env: { CAREERBOT_WEBSEARCH: 'brave', BRAVE_SEARCH_API_KEY: 'x' } }).name === 'brave', 'brave selected from env');
assert(resolveProvider({ env: { CAREERBOT_WEBSEARCH: 'serper', SERPER_API_KEY: 'x' } }).name === 'serper', 'serper selected from env');
assert(resolveProvider({ env: { CAREERBOT_WEBSEARCH: 'scrape' } }).name === 'scrape', 'scrape selected from env');
assert(resolveProvider({ env: {} }).name === 'scrape', 'default = scrape when env empty');
assert(resolveProvider({ env: { BRAVE_SEARCH_API_KEY: 'x' } }).name === 'brave', 'brave auto-selected when key present');
assert(resolveProvider({ env: { SERPER_API_KEY: 'x' } }).name === 'serper', 'serper auto-selected when key present');
assert(resolveProvider({ env: { CAREERBOT_WEBSEARCH: 'scrape', BRAVE_SEARCH_API_KEY: 'x' } }).name === 'scrape', 'explicit scrape overrides auto-select');
assert(resolveProvider({ env: { CAREERBOT_WEBSEARCH: 'ddg' } }).name === 'scrape', 'ddg alias maps to scrape');
assert(pickProviderName(null, { BRAVE_SEARCH_API_KEY: 'x' }) === 'brave', 'pickProviderName prefers brave key');
assert(pickProviderName(null, { CAREERBOT_WEBSEARCH_ORDER: 'serper,brave,scrape', BRAVE_SEARCH_API_KEY: 'x', SERPER_API_KEY: 'y' }) === 'serper', 'provider order can prefer serper');
assert(pickProviderName(null, { CAREERBOT_WEBSEARCH_ORDER: 'brave,scrape', SERPER_API_KEY: 'y' }) === 'scrape', 'provider order can skip serper');
assert(providerOrder({ CAREERBOT_WEBSEARCH_ORDER: 'ddg,serper,serper,bogus' }).join(',') === 'scrape,serper', 'providerOrder normalizes aliases and dupes');

let threw = false;
try { resolveProvider({ env: { CAREERBOT_WEBSEARCH: 'bogus' } }); } catch (e) { threw = e instanceof WebSearchError; }
assert(threw, 'unknown provider throws WebSearchError');

// ── 2. Brave provider ──────────────────────────────────────────────

console.log('\n2. Brave provider');

const braveBody = {
  web: {
    results: [
      { url: 'https://example.com/a', title: 'Senior Engineer at Acme', description: 'A great role with <b>HTML</b>.' },
      { url: 'https://example.com/b', title: 'Lead Designer at Beta', description: 'Beta is hiring.' },
      { url: 'https://example.com/c', title: 'PM at Gamma', description: '' },
    ],
  },
};

let lastBraveAuth;
const braveFetch = mockFetch(async (url, init) => {
  lastBraveAuth = init.headers['X-Subscription-Token'];
  return mockResponse({ json: braveBody });
});

const braveProvider = resolveProvider({ env: { CAREERBOT_WEBSEARCH: 'brave', BRAVE_SEARCH_API_KEY: 'test-key-123' } });
const braveResults = await braveProvider.search('staff engineer remote', { fetchImpl: braveFetch });

assert(braveResults.length === 3, 'brave returned 3 results');
assert(braveResults[0].url === 'https://example.com/a', 'brave first url ok');
assert(braveResults[0].snippet === 'A great role with HTML.', 'brave snippet has HTML stripped');
assert(lastBraveAuth === 'test-key-123', 'brave used the API key header');

// No key → WebSearchError
const noKeyProvider = resolveProvider({ env: { CAREERBOT_WEBSEARCH: 'brave' } });
let noKeyErr = null;
try { await noKeyProvider.search('q', { fetchImpl: braveFetch }); } catch (e) { noKeyErr = e; }
assert(noKeyErr && noKeyErr.code === 'missing_key', 'brave missing key surfaces missing_key error');

// Non-2xx response → WebSearchError
const failProvider = resolveProvider({ env: { CAREERBOT_WEBSEARCH: 'brave', BRAVE_SEARCH_API_KEY: 'x' } });
let httpErr = null;
try {
  await failProvider.search('q', { fetchImpl: mockFetch(async () => mockResponse({ ok: false, status: 503 })) });
} catch (e) { httpErr = e; }
assert(httpErr && httpErr.code === 'http_error', 'brave http error surfaces http_error');

// maxResults caps result count
const capped = await braveProvider.search('q', { maxResults: 2, fetchImpl: braveFetch });
assert(capped.length === 2, 'brave maxResults caps results');

// ── 3. Serper provider ─────────────────────────────────────────────

console.log('\n3. Serper provider');

const serperBody = {
  organic: [
    { link: 'https://x.com/1', title: 'Backend Engineer at X', snippet: 'X is hiring.' },
    { link: 'https://y.com/2', title: 'Frontend Engineer at Y', snippet: 'Y is hiring.' },
  ],
};
let lastSerperBody;
const serperFetch = mockFetch(async (url, init) => {
  lastSerperBody = init.body;
  return mockResponse({ json: serperBody });
});

const serperProv = resolveProvider({ env: { CAREERBOT_WEBSEARCH: 'serper', SERPER_API_KEY: 'k' } });
const serperResults = await serperProv.search('engineer remote', { fetchImpl: serperFetch });

assert(serperResults.length === 2, 'serper returned 2 results');
assert(serperResults[0].url === 'https://x.com/1', 'serper first url ok');
const sentBody = JSON.parse(lastSerperBody);
assert(sentBody.q === 'engineer remote', 'serper sent query in body');
assert(typeof sentBody.num === 'number', 'serper sent num in body');

// ── 4. Scrape provider + parseDuckDuckGoHtml ───────────────────────

console.log('\n4. Scrape provider');

const ddgHtml = `
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.com%2Fjob1&rut=abc">Real Job 1 - Acme</a>
    <a class="result__snippet" href="...">Snippet for job 1.</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://direct.com/job2">Direct Job 2 - Beta</a>
    <a class="result__snippet" href="...">Snippet for job 2.</a>
  </div>
`;

const parsed = parseDuckDuckGoHtml(ddgHtml, 10);
assert(parsed.length === 2, 'parsed 2 results from DDG HTML');
assert(parsed[0].url === 'https://real.com/job1', 'DDG redirect unwrapped');
assert(parsed[1].url === 'https://direct.com/job2', 'direct DDG href preserved');
assert(parsed[0].title === 'Real Job 1 - Acme', 'first title parsed');
assert(parsed[0].snippet === 'Snippet for job 1.', 'first snippet parsed');

const scrapeFetch = mockFetch(async () => mockResponse({ text: ddgHtml }));
const scrapeProv = resolveProvider({ env: { CAREERBOT_WEBSEARCH: 'scrape' } });
const scrapeResults = await scrapeProv.search('q', { fetchImpl: scrapeFetch });
assert(scrapeResults.length === 2, 'scrape provider end-to-end returned 2');

let challengeErr = null;
try {
  await scrapeProv.search('q', {
    fetchImpl: mockFetch(async () => mockResponse({ status: 202, text: '<html></html>' })),
  });
} catch (e) { challengeErr = e; }
assert(challengeErr && challengeErr.code === 'challenge', 'DDG 202 challenge surfaces as WebSearchError');

// Malformed HTML → empty, not throw
const empty = parseDuckDuckGoHtml('<html><body>no results</body></html>');
assert(empty.length === 0, 'empty HTML returns empty array');

// ── 5. searchWeb public entrypoint ────────────────────────────────

console.log('\n5. searchWeb');

const stubProvider = {
  name: 'stub',
  search: async (q, opts) => [{ url: `https://stub.test/${encodeURIComponent(q)}`, title: q, snippet: 'stub' }],
};
const stubResults = await searchWeb('hello', { provider: stubProvider });
assert(stubResults.length === 1, 'searchWeb accepts injected provider object');
assert(stubResults[0].url === 'https://stub.test/hello', 'injected provider used');

// ── DONE ──────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
