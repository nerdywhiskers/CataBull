#!/usr/bin/env node

/**
 * test-onboarding.mjs — Unit tests for onboarding route helpers
 *
 * Tests the JSON extraction and candidate sanitization used by
 * /onboarding/discover-companies (W2). Pure-logic tests; no agent
 * runs, no HTTP.
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

console.log('\nonboarding helpers (W2)');

const { extractCandidatesArray, sanitizeCandidates } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'routes', 'onboarding.mjs')).href
);

// ── 1. EXTRACT ──────────────────────────────────────────────────────

console.log('\n1. extractCandidatesArray');

assert(
  extractCandidatesArray('[{"name":"A","careers_url":"https://a.example/careers"}]').length === 1,
  'plain JSON array',
);

assert(
  extractCandidatesArray('Sure, here are the companies:\n```json\n[{"name":"B","careers_url":"https://b.example"}]\n```\n').length === 1,
  'fenced JSON array (json marker)',
);

assert(
  extractCandidatesArray('```\n[{"name":"C","careers_url":"https://c.example"}]\n```').length === 1,
  'fenced JSON array (no marker)',
);

assert(
  extractCandidatesArray('Some prose first.\n[{"name":"D","careers_url":"https://d.example"},{"name":"E","careers_url":"https://e.example"}]\nSome prose after.').length === 2,
  'JSON array embedded in prose',
);

assert(
  extractCandidatesArray('').length === 0,
  'empty string → []',
);

assert(
  extractCandidatesArray('not even close to JSON').length === 0,
  'non-JSON → []',
);

assert(
  extractCandidatesArray('{"name":"X"}').length === 0,
  'JSON object (not array) → []',
);

assert(
  extractCandidatesArray('[invalid json]').length === 0,
  'malformed array → []',
);

// ── 2. SANITIZE ─────────────────────────────────────────────────────

console.log('\n2. sanitizeCandidates');

const goodEntry = {
  name: 'TestCo',
  careers_url: 'https://testco.example/careers',
  industries: ['ai', 'gaming'],
  notes: 'Hires creative-tech folks',
};

assert(
  sanitizeCandidates([goodEntry]).length === 1,
  'well-formed entry passes',
);

assert(
  sanitizeCandidates([{ ...goodEntry, name: '' }]).length === 0,
  'missing name → dropped',
);

assert(
  sanitizeCandidates([{ ...goodEntry, careers_url: '' }]).length === 0,
  'missing URL → dropped',
);

assert(
  sanitizeCandidates([{ ...goodEntry, careers_url: 'testco.example' }]).length === 0,
  'URL without https:// → dropped',
);

assert(
  sanitizeCandidates([{ ...goodEntry, careers_url: 'ftp://testco.example/' }]).length === 0,
  'non-http(s) URL → dropped',
);

const dupes = [
  { ...goodEntry },
  { ...goodEntry, careers_url: 'https://testco.example/jobs' },
  { ...goodEntry, name: 'TESTCO' },  // case-insensitive dup
];
assert(
  sanitizeCandidates(dupes).length === 1,
  'case-insensitive dedup against same response',
);

const existing = new Set(['testco', 'preexisting']);
assert(
  sanitizeCandidates([{ ...goodEntry, name: 'TestCo' }], { existingNames: existing }).length === 0,
  'existingNames filter applies (case-insensitive)',
);

const many = Array.from({ length: 30 }, (_, i) => ({
  ...goodEntry,
  name: `Co${i}`,
  careers_url: `https://co${i}.example/careers`,
}));
assert(
  sanitizeCandidates(many, { target: 10 }).length === 10,
  'target cap is respected',
);

const sanitized = sanitizeCandidates([goodEntry]);
assert(sanitized[0].industries.length === 2, 'industries preserved');
assert(sanitized[0].industries.every((i) => i === i.toLowerCase()), 'industries lowercased');
assert(sanitized[0].enabled === true, 'enabled defaults true');
assert(typeof sanitized[0].notes === 'string', 'notes preserved as string');

const longNotes = { ...goodEntry, notes: 'x'.repeat(500) };
assert(
  sanitizeCandidates([longNotes])[0].notes.length === 200,
  'long notes truncated to 200 chars',
);

const malformed = [
  null,
  undefined,
  'a string',
  42,
  { ...goodEntry, name: '   ' },           // whitespace-only name
  { ...goodEntry, careers_url: '   ' },     // whitespace-only URL
];
assert(
  sanitizeCandidates(malformed).length === 0,
  'malformed entries all rejected',
);

// Industries can be wrong-typed — we just default to []. Should not crash.
const wrongIndustries = sanitizeCandidates([{ ...goodEntry, industries: 'not-array' }]);
assert(
  wrongIndustries.length === 1 && Array.isArray(wrongIndustries[0].industries) && wrongIndustries[0].industries.length === 0,
  'non-array industries defaults to [] (does not reject the entry)',
);

assert(
  sanitizeCandidates(null).length === 0,
  'non-array input → []',
);

// ── DONE ────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
