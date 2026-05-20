#!/usr/bin/env node

/**
 * test-score-blocks.mjs — Unit tests for the per-block score parser
 * (issue #28 part 2).
 *
 * Pure markdown-string tests against parseBlockScores and
 * computeWeightedScore in dashboard-web/lib/parsers.mjs. The parser
 * is the bridge between the agent's report output and the dashboard's
 * score-breakdown UI.
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

console.log('\nparseBlockScores / computeWeightedScore (issue #28)');

const { parseBlockScores, computeWeightedScore, SCORE_WEIGHTS, extractRationaleExcerpt } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web/lib/parsers.mjs')).href
);

// ── 1. Structured breakdown line (mandated format) ──────────────────

console.log('\n1. Structured "Score: X/5 — A:N · B:N · ..." line');

const structured = `# Report

**TL;DR** | Strong fit
Score: 3.9/5 — A:4.5 · B:5.0 · C:3.5 · D:4.0 · E:4.5

## Block A — Match con CV
Lots of detail here.
`;
const r1 = parseBlockScores(structured);
assert(r1?.A === 4.5, 'A=4.5');
assert(r1?.B === 5.0, 'B=5.0');
assert(r1?.C === 3.5, 'C=3.5');
assert(r1?.D === 4.0, 'D=4.0');
assert(r1?.E === 4.5, 'E=4.5');

// 4.5*0.3 + 5.0*0.25 + 3.5*0.2 + 4.0*0.15 − (5−4.5)*0.1
// = 1.35 + 1.25 + 0.7 + 0.6 − 0.05 = 3.85 → rounded to 3.9
const computed = computeWeightedScore(r1);
assert(computed === 3.9, `weighted formula correct (got ${computed}, expected 3.9)`);

// ── 2. Separator variations ─────────────────────────────────────────

console.log('\n2. Separator variations');

const variants = `Score: 3.9/5 - A:4.5, B:5.0 | C:3.5  D:4.0; E:4.5`;
const r2 = parseBlockScores(variants);
assert(r2?.A === 4.5, 'comma separator');
assert(r2?.B === 5.0, 'pipe separator');
assert(r2?.C === 3.5, 'whitespace separator');
assert(r2?.D === 4.0, 'D parsed regardless of separator');
assert(r2?.E === 4.5, 'E parsed regardless of separator');

// ── 3. Loose fallback (legacy reports) ──────────────────────────────

console.log('\n3. Loose fallback patterns');

const loose = `# Report

## A — Match con CV: 4.5/5
Some text.

## B — North Star: 5/5
More text.

## C — Comp: 3.5/5
Even more text.

## D — Cultural: 4/5
Yet more.

## E — Red flags: 4.5/5
Final block.
`;
const r3 = parseBlockScores(loose);
assert(r3?.A === 4.5, 'loose: A=4.5');
assert(r3?.B === 5.0, 'loose: B=5.0');
assert(r3?.C === 3.5, 'loose: C=3.5');
assert(r3?.D === 4.0, 'loose: D=4.0');
assert(r3?.E === 4.5, 'loose: E=4.5');

// ── 4. Nullish / unparseable input ──────────────────────────────────

console.log('\n4. Edge cases');

assert(parseBlockScores('') === null, 'empty string → null');
assert(parseBlockScores(null) === null, 'null input → null');
assert(parseBlockScores('No scores here') === null, 'no patterns → null');

// Partial structured line — only 3 blocks. Should fall through to loose
// scan, which won't find more, so we return what we got from tier 1.
const partial = `Score: 3.5/5 — A:4.5 · B:5.0 · C:3.5`;
const r4 = parseBlockScores(partial);
// Tier 1 requires ≥4 blocks; this falls through to tier 2 which doesn't
// match the structured format. With only 3 blocks tier-2 may still
// pick them up via loose patterns.
assert(r4 === null || (r4.A === 4.5 && r4.D === undefined), 'partial structured → either null or A-only');

// computeWeightedScore returns null when any of A-D is missing.
assert(computeWeightedScore({ A: 4.5, B: 5.0, C: 3.5 }) === null, 'computeWeightedScore returns null when D missing');
// Without E we treat penalty=0. A=B=C=D=4 → 4*0.9 = 3.6, no penalty, → 3.6
assert(computeWeightedScore({ A: 4, B: 4, C: 4, D: 4 }) === 3.6, 'no E → no penalty (3.6 not 4.0; weights sum to 0.9)');
// Perfect inputs: 5*0.9 = 4.5, no penalty → 4.5 (max attainable)
assert(computeWeightedScore({ A: 5, B: 5, C: 5, D: 5, E: 5 }) === 4.5, 'perfect inputs cap at 4.5/5 (intentional)');
// Perfect A-D, severe red flags (E=1): 4.5 - 0.4 = 4.1
assert(computeWeightedScore({ A: 5, B: 5, C: 5, D: 5, E: 1 }) === 4.1, 'severe red flags applied as penalty');
assert(computeWeightedScore(null) === null, 'null blocks → null');

// ── 5. Tier 1 wins over tier 2 if both are present ──────────────────

console.log('\n5. Tier-1 priority over tier-2');

const both = `
Score: 3.9/5 — A:4.5 · B:5.0 · C:3.5 · D:4.0 · E:4.5

## A — Match con CV: 1.0/5

This text has a "B 9.9/5" string but it should not override the structured line.
`;
const r5 = parseBlockScores(both);
assert(r5?.A === 4.5, 'A from structured line (4.5), not from loose ## A header (1.0)');

// ── 6. SCORE_WEIGHTS export ─────────────────────────────────────────

console.log('\n6. SCORE_WEIGHTS metadata');

assert(SCORE_WEIGHTS.A.weight === 0.30, 'A weight is 30%');
assert(SCORE_WEIGHTS.B.weight === 0.25, 'B weight is 25%');
assert(SCORE_WEIGHTS.C.weight === 0.20, 'C weight is 20%');
assert(SCORE_WEIGHTS.D.weight === 0.15, 'D weight is 15%');
assert(SCORE_WEIGHTS.E.weight === 0.10, 'E weight is 10% (penalty)');
assert(SCORE_WEIGHTS.E.isPenalty === true, 'E flagged as penalty');

// ── 7. Markdown-bolded Score line (the most common real-world shape) ──

console.log('\n7. **Score:** decoration tolerated');

const bolded = `# Acme · Senior PM

**URL:** https://example.com

**Score:** 4.2/5 — A:4.5 · B:5.0 · C:3.5 · D:4.0 · E:4.5
`;
const r7 = parseBlockScores(bolded);
assert(r7?.A === 4.5 && r7?.B === 5.0 && r7?.C === 3.5, 'parses all blocks despite **Score:** wrapper');

// ── 8. extractRationaleExcerpt ──────────────────────────────────────

console.log('\n8. extractRationaleExcerpt');

const full = `# Acme · Senior PM

**Score:** 4.2/5 — A:4.5 · B:5.0 · C:3.5 · D:4.0 · E:4.5

This role checks the major boxes. Strong product-led organization with a clear ladder to staff and comp band that overlaps with the user's target.

## A — Match con CV: 4.5/5
The CV maps directly...
`;
const ex = extractRationaleExcerpt(full);
assert(ex.includes('product-led'), 'pulls first paragraph after Score line');
assert(!ex.includes('CV maps'), 'stops before the next heading');
assert(ex.length <= 280, 'caps to ~280 chars');

const noScore = `# Random doc with no score header anywhere`;
assert(extractRationaleExcerpt(noScore) === '', 'returns empty when no score line found');

const longBody = `Score: 4.0/5\n\n${'word '.repeat(100)}`;
const exLong = extractRationaleExcerpt(longBody);
assert(exLong.endsWith('…'), 'truncates with ellipsis when over the cap');
assert(exLong.length <= 280, 'enforces the maxChars cap');

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
