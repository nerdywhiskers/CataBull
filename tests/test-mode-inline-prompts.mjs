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
  getElementById: () => fakeNode(),
  createElement: fakeNode,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop,
  body: { appendChild: noop },
};
globalThis.window = { document: globalThis.document, addEventListener: noop, dispatchEvent: noop, innerWidth: 1440 };
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

console.log('\nMode inline prompts');

const { inlinePromptForMode } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'public', 'js', 'lib', 'modes.mjs')).href
);

const prompt = inlinePromptForMode('evaluate', {
  url: 'https://jobs.example/role',
  company: 'Acme',
  role: 'Staff AI PM',
});

assert(typeof prompt === 'string' && prompt.length > 0, 'evaluate inline prompt is exposed for testing');
assert(prompt.includes('batch/tracker-additions/'), 'evaluate inline prompt tells non-Claude agents where tracker additions must be written');
assert(prompt.includes('node merge-tracker.mjs'), 'evaluate inline prompt tells non-Claude agents to merge tracker additions after writing them');
assert(prompt.includes('Register the evaluation in the tracker'), 'evaluate inline prompt explicitly requires tracker registration');

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exitCode = 1;
else console.log('All passed ✓');
