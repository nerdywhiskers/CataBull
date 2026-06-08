#!/usr/bin/env node

/**
 * Unit tests for LLM contextual scoring helpers.
 */

const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
let failed = 0;
let total = 0;

function assert(cond, msg) {
  total++;
  if (cond) {
    passed++;
    if (VERBOSE) console.log(`  OK ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL ${msg}`);
  }
}

const {
  MAX_CONTEXTUAL_POSTINGS,
  buildContextualScoringPrompt,
  extractJsonObject,
  normalizeContextualScores,
} = await import('../lib/contextual-scoring.mjs');
const {
  applyContextualScoreResults,
  mergePendingContextualState,
  resetPendingToHeuristicScores,
} = await import('../dashboard-web/public/js/lib/pending-contextual-scoring.mjs');

console.log('\nlib/contextual-scoring.mjs');

const postings = [
  { url: 'https://jobs.example/a', company: 'Acme', role: 'Staff AI Prototyper', relevance: 3.5, relevanceRationale: 'Title keywords' },
  { url: 'https://jobs.example/b', company: 'Beta', role: 'Junior Sales Associate', relevance: 0.5 },
];

const prompt = buildContextualScoringPrompt({
  profile: {
    candidate: { title: 'Creative Technologist' },
    target_roles: {
      primary: ['Creative Technologist'],
      archetypes: [{ name: 'AI Prototyping Lead' }],
    },
    narrative: { superpowers: ['bridges art direction and engineering'] },
  },
  profileMarkdown: '# Archetypes\nAI Prototyping Lead',
  postings,
});

assert(prompt.includes('Return ONLY valid JSON'), 'prompt requests JSON-only output');
assert(prompt.includes('AI Prototyping Lead'), 'prompt includes archetype context');
assert(prompt.includes('Staff AI Prototyper'), 'prompt includes posting title');
assert(!prompt.includes('cv.md'), 'prompt stays profile/archetype scoped');

const fenced = extractJsonObject('```json\n{"scores":[{"id":"a","score":4.4}]}\n```');
assert(fenced.scores[0].score === 4.4, 'extracts fenced JSON');

const noisy = extractJsonObject('Here you go:\n{"scores":[{"id":"a","score":4.1}]}');
assert(noisy.scores[0].score === 4.1, 'extracts noisy JSON object');

const normalized = normalizeContextualScores({
  scores: [
    { id: 'https://jobs.example/a', score: 4.234, rationale: 'Strong archetype fit', signals: ['AI prototype ownership', 'senior scope'] },
    { id: 'https://jobs.example/b', score: 8, rationale: 'Bad clamp' },
    { id: 'unknown', score: 5, rationale: 'Should drop' },
    { id: 'https://jobs.example/a', score: 'nope', rationale: 'Should drop' },
  ],
}, postings);

assert(normalized.length === 2, 'normalizes only known postings with numeric scores');
assert(normalized[0].score === 4.2, 'rounds to one decimal');
assert(normalized[1].score === 5, 'clamps high scores');
assert(normalized[0].signals.length === 2, 'keeps short signal list');

const many = Array.from({ length: MAX_CONTEXTUAL_POSTINGS + 5 }, (_, i) => ({ url: `u${i}`, role: `Role ${i}` }));
const cappedPrompt = buildContextualScoringPrompt({ postings: many });
assert(cappedPrompt.includes(`"id": "u${MAX_CONTEXTUAL_POSTINGS - 1}"`), 'includes final capped posting');
assert(!cappedPrompt.includes(`"id": "u${MAX_CONTEXTUAL_POSTINGS}"`), 'drops postings beyond cap');

const merged = mergePendingContextualState(
  [{ url: 'https://jobs.example/a', relevance: 3.5, heuristicRelevance: 3.5 }],
  [{ url: 'https://jobs.example/a', relevance: 4.4, contextualScore: 4.4, contextualScoreSource: 'llm', contextualRationale: 'Strong fit', contextualSignals: ['scope'], heuristicRelevance: 3.5 }]
);
assert(merged[0].relevance === 4.4, 'merge preserves prior LLM score for same pending URL');
assert(merged[0].contextualScoreSource === 'llm', 'merge preserves LLM score source');

const applied = applyContextualScoreResults(
  [{ url: 'https://jobs.example/a', relevance: 3.5, heuristicRelevance: 3.5, contextualScoring: true }],
  [{ id: 'https://jobs.example/a', score: 4.6, rationale: 'High fit', signals: ['leadership'] }]
);
assert(applied[0].relevance === 4.6, 'applyContextualScoreResults replaces relevance with LLM score');
assert(applied[0].contextualScoring === false, 'applyContextualScoreResults clears loading state');

const reset = resetPendingToHeuristicScores([{ relevance: 4.6, heuristicRelevance: 3.5, contextualScore: 4.6, contextualScoreSource: 'llm' }]);
assert(reset[0].relevance === 3.5, 'resetPendingToHeuristicScores restores heuristic score');
assert(reset[0].contextualScoreSource === undefined, 'resetPendingToHeuristicScores clears LLM source');

console.log(`\n${'-'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed');
}
