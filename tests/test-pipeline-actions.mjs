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

console.log('\nOverflow dropdown placement');

const { positionOverflowDropdown } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'public', 'js', 'views', 'pipeline.mjs')).href
);

const downDropdown = { style: {}, dataset: {}, getBoundingClientRect: () => ({ width: 160, height: 120 }) };
const downTrigger = { getBoundingClientRect: () => ({ top: 120, bottom: 148, right: 520 }) };
const downPlacement = positionOverflowDropdown(downTrigger, downDropdown, { innerWidth: 800, innerHeight: 900 });
assert(downPlacement === 'down', 'overflow dropdown opens downward when there is room below');
assert(downDropdown.style.top === '152px', 'downward overflow dropdown sits just below the trigger');
assert(downDropdown.style.left === '360px', 'overflow dropdown stays aligned to the trigger edge');

const upDropdown = { style: {}, dataset: {}, getBoundingClientRect: () => ({ width: 180, height: 140 }) };
const upTrigger = { getBoundingClientRect: () => ({ top: 760, bottom: 788, right: 700 }) };
const upPlacement = positionOverflowDropdown(upTrigger, upDropdown, { innerWidth: 900, innerHeight: 820 });
assert(upPlacement === 'up', 'overflow dropdown opens upward near the bottom of the viewport');
assert(upDropdown.style.top === '616px', 'upward overflow dropdown sits above the trigger');
assert(upDropdown.dataset.placement === 'up', 'overflow dropdown records upward placement for styling');

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exitCode = 1;
else console.log('All passed ✓');
