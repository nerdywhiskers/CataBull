#!/usr/bin/env node

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

const noop = () => {};
const fakeNode = () => ({
  style: {},
  className: '',
  textContent: '',
  appendChild: noop,
  remove: noop,
  addEventListener: noop,
  querySelector: () => null,
  querySelectorAll: () => [],
});

globalThis.document = {
  getElementById: () => ({ appendChild: noop }),
  createElement: fakeNode,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop,
  body: { style: {} },
};
globalThis.window = { document: globalThis.document, addEventListener: noop, dispatchEvent: noop };
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

console.log('\nPending tailor watcher');

const { watchPendingTailorCompletion } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'public', 'js', 'views', 'pipeline.mjs')).href
);
const { api } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'public', 'js', 'api.mjs')).href
);

const originalGetApplications = api.getApplications;
let getApplicationsCalls = 0;
api.getApplications = async () => {
  getApplicationsCalls += 1;
  if (getApplicationsCalls === 1) {
    return { applications: [], pending: [{ url: 'https://jobs.example/p1', company: 'Gamma', role: 'Engineer' }], skipped: [], expired: [] };
  }
  return {
    applications: [{ num: 42, jobUrl: 'https://jobs.example/p1', company: 'Gamma', role: 'Engineer', statusNormalized: 'evaluated' }],
    pending: [],
    skipped: [],
    expired: [],
  };
};
const watchResult = await watchPendingTailorCompletion(
  { url: 'https://jobs.example/p1', company: 'Gamma', role: 'Engineer' },
  { timeoutMs: 50, intervalMs: 0 }
);
assert(watchResult === true, 'pending tailor watcher resolves when evaluated row appears');
assert(getApplicationsCalls === 2, 'pending tailor watcher polls until the evaluated row exists');
api.getApplications = originalGetApplications;

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exitCode = 1;
else console.log('All passed ✓');
