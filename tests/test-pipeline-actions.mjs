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

console.log('\nPipeline action mappings');

const { rowActionsForStatus, batchActionsForFilter, buildAiSuggestion } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'public', 'js', 'views', 'pipeline.mjs')).href
);

const skipRowActions = rowActionsForStatus('skip');
assert(skipRowActions.length === 1, 'skip rows expose one primary restore action');
assert(skipRowActions[0].status === 'Evaluated', 'skip row restore action moves back to Evaluated');
assert(skipRowActions[0].label === 'Restore', 'skip row restore action is labeled Restore');

const skipBatchActions = batchActionsForFilter('skip');
assert(skipBatchActions.length === 1, 'skip filter exposes one batch restore action');
assert(skipBatchActions[0].status === 'Evaluated', 'skip batch action restores selected rows to Evaluated');
assert(skipBatchActions[0].label === 'Restore', 'skip batch action is labeled Restore');

console.log('\nPipeline AI suggestions');

const noSuggestion = buildAiSuggestion([]);
assert(noSuggestion.targetNum === null, 'empty application list has no optimization target');
assert(noSuggestion.openScoreModal === false, 'empty application list does not open score modal');

const scoreBlockSuggestion = buildAiSuggestion([
  {
    num: 7,
    company: 'Acme',
    role: 'Product Designer',
    score: 3.2,
    statusNormalized: 'applied',
    scoreBlocks: { A: 4.1, B: 2.4, C: 3.9, D: 4.0, E: 4.8 },
  },
]);
assert(scoreBlockSuggestion.targetNum === 7, 'AI suggestion picks the lowest-scoring active application');
assert(scoreBlockSuggestion.targetFilter === 'applied', 'applied suggestion routes back to applied tab');
assert(scoreBlockSuggestion.body.includes('weakest on B (2.4/5)'), 'AI suggestion highlights the weakest score block');
assert(scoreBlockSuggestion.openScoreModal === true, 'AI suggestion opens score modal for actionable target');

const rationaleSuggestion = buildAiSuggestion([
  {
    num: 9,
    company: 'Beta',
    role: 'Design Lead',
    score: 3.6,
    statusNormalized: 'evaluated',
    rationaleExcerpt: 'Needs clearer leadership examples.',
  },
]);
assert(rationaleSuggestion.targetFilter === 'evaluated', 'evaluated suggestion routes back to evaluated tab');
assert(rationaleSuggestion.body.includes('Needs clearer leadership examples.'), 'AI suggestion falls back to rationale excerpt when block scores are missing');

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exitCode = 1;
else console.log('All passed ✓');
