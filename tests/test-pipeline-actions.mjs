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

const { PIPELINE_FILTERS, hasCanonicalRole, rowActionsForStatus, batchActionsForFilter, buildAiSuggestion, watchPendingTailorCompletion, positionOverflowDropdown, pendingNeedsContextualScore, pendingPassesScoreFilters, pendingTailorStatusLabel, renderPendingScoreButton, shouldWarnLowTailorScore, shouldEnableTailorArtifacts, shouldShowTailorArtifactLinks, pendingTailorDecision, areAllPendingItemsSelected, setPendingSelectionForItems, countApplicationsForTab, applicationDateColumnLabel, applicationDateValue } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'public', 'js', 'views', 'pipeline.mjs')).href
);
const { shouldAutoExpireLivenessResult } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'routes', 'actions.mjs')).href
);
const { api } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'public', 'js', 'api.mjs')).href
);
const { canonicalCompanyRoleKey: browserRoleKey } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'public', 'js', 'lib', 'role-identity.mjs')).href
);
const { canonicalCompanyRoleKey: serverRoleKey } = await import(
  pathToFileURL(join(ROOT, 'lib', 'role-identity.mjs')).href
);

const skipRowActions = rowActionsForStatus('skip');
assert(skipRowActions.length === 1, 'skip rows expose one primary restore action');
assert(skipRowActions[0].status === 'Tailored', 'skip row restore action moves back to Tailored');
assert(skipRowActions[0].label === 'Restore', 'skip row restore action is labeled Restore');

const skipBatchActions = batchActionsForFilter('skip');
assert(skipBatchActions.length === 1, 'skip filter exposes one batch restore action');
assert(skipBatchActions[0].status === 'Tailored', 'skip batch action restores selected rows to Tailored');
assert(skipBatchActions[0].label === 'Restore', 'skip batch action is labeled Restore');

const appliedRowActions = rowActionsForStatus('applied');
assert(appliedRowActions.some((action) => action.status === 'Rejected'), 'applied rows can still be marked Rejected');

const rejectedRowActions = rowActionsForStatus('rejected');
assert(rejectedRowActions.length === 0, 'rejected rows do not expose follow-up stage actions');

const rejectedBatchActions = batchActionsForFilter('rejected');
assert(rejectedBatchActions.length === 0, 'rejected filter has no batch stage actions');

const pipelineFilterKeys = PIPELINE_FILTERS.map((filter) => filter.key);
for (const canonicalState of ['tailored', 'applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'skip']) {
  assert(pipelineFilterKeys.includes(canonicalState), `pipeline exposes a tab for canonical state ${canonicalState}`);
}
assert(
  hasCanonicalRole([{ company: 'AMD', role: 'AI Creative Technologist' }], 'AMD, Inc.', 'AI Creative Technologist') === true,
  'pipeline duplicate warnings use canonical company and role identity'
);
for (const [company, role] of [
  ['AMD, Inc.', 'AI Creative Technologist'],
  ['Acme & Company', 'Designer / Art Director'],
  ['BMW Group', 'Visualizer'],
]) {
  assert(browserRoleKey(company, role) === serverRoleKey(company, role), `browser and server role identity agree for ${company} / ${role}`);
}

const tabCountFixtures = [
  { score: 4.5, statusNormalized: 'applied' },
  { score: 3.2, statusNormalized: 'rejected' },
  { score: 2.8, statusNormalized: 'skip' },
  { score: 4.1, statusNormalized: 'tailored' },
];
assert(
  countApplicationsForTab(tabCountFixtures, 'rejected') === 1,
  'rejected tab counts rejected application rows directly'
);
assert(
  countApplicationsForTab(tabCountFixtures, 'skip', { skippedCount: 2, expiredCount: 1 }) === 4,
  'skip tab counts only skip applications plus skipped and expired pipeline rows'
);
assert(applicationDateColumnLabel('applied') === 'Applied On', 'applied tab relabels the date column to Applied On');
assert(applicationDateColumnLabel('tailored') === 'Date', 'non-applied tabs keep the generic date label');
assert(
  applicationDateValue({ date: '2026-06-01', appliedAt: '2026-06-12' }, 'applied') === '2026-06-12',
  'applied tab prefers the first applied event date when present'
);
assert(
  applicationDateValue({ date: '2026-06-01' }, 'applied') === '2026-06-01',
  'applied tab falls back to tracker date when no applied event exists yet'
);

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
    statusNormalized: 'tailored',
    rationaleExcerpt: 'Needs clearer leadership examples.',
  },
]);
assert(rationaleSuggestion.targetFilter === 'tailored', 'tailored suggestion routes back to tailored tab');
assert(rationaleSuggestion.body.includes('Needs clearer leadership examples.'), 'AI suggestion falls back to rationale excerpt when block scores are missing');

console.log('\nOverflow dropdown placement');

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

console.log('\nPending liveness auto-expiry policy');

assert(
  shouldWarnLowTailorScore(2.9) === true,
  'tailor flow warns when score is below 3.0'
);
assert(
  shouldWarnLowTailorScore(3.0) === false,
  'tailor flow does not warn at the 3.0 threshold'
);
assert(
  shouldEnableTailorArtifacts({ statusNormalized: 'tailored', score: 3.1 }) === true,
  'tailored roles above 3.0 unlock tailor artifacts'
);
assert(
  shouldEnableTailorArtifacts({ statusNormalized: 'tailored', score: 3.0 }) === false,
  'tailored roles at exactly 3.0 stay below the tailor artifact threshold'
);
assert(
  shouldEnableTailorArtifacts({ statusNormalized: 'applied', score: 4.8 }) === false,
  'tailor artifacts stay scoped to tailored roles'
);
assert(
  shouldShowTailorArtifactLinks({ statusNormalized: 'tailored', score: 3.8, tailorBundle: { paths: { cv: 'output/tailor-bundles/x/cv.md' } } }) === true,
  'tailored roles above 3 show tailored artifact links when bundle files exist'
);
assert(
  shouldShowTailorArtifactLinks({ statusNormalized: 'tailored', score: 3.8, tailorBundle: null }) === false,
  'tailored artifact links stay hidden when no bundle exists'
);
assert(
  shouldShowTailorArtifactLinks({ statusNormalized: 'tailored', score: 2.8, tailorBundle: { paths: { cv: 'output/tailor-bundles/x/cv.md' } } }) === false,
  'tailored artifact links stay hidden below the >3 threshold even if files exist'
);
assert(
  shouldShowTailorArtifactLinks({ statusNormalized: 'tailored', score: 3.8, tailorBundle: { paths: { cvDoc: 'output/tailor-bundles/x/cv.doc' } } }) === true,
  'tailored artifact links show when only DOC exports are present above the score threshold'
);
const llmTailorDecision = pendingTailorDecision({
  url: 'https://jobs.example/llm',
  relevance: 2.7,
  contextualScore: 3.8,
  contextualScoreSource: 'llm',
});
assert(llmTailorDecision.score === 3.8, 'pending tailor prefers the LLM score when present');
assert(llmTailorDecision.scoreSource === 'llm', 'pending tailor decision marks LLM-backed scores');
assert(llmTailorDecision.shouldWarn === false, 'pending tailor does not warn when the LLM score clears the threshold');
assert(llmTailorDecision.shouldAutoSkip === false, 'pending tailor does not flag auto-skip when the LLM score clears the threshold');

const heuristicTailorDecision = pendingTailorDecision({
  url: 'https://jobs.example/heuristic',
  relevance: 2.6,
});
assert(heuristicTailorDecision.score === 2.6, 'pending tailor falls back to heuristic relevance when no LLM score exists');
assert(heuristicTailorDecision.scoreSource === 'heuristic', 'pending tailor decision labels heuristic fallback');
assert(heuristicTailorDecision.shouldWarn === true, 'pending tailor warns on low heuristic fallback scores');
assert(heuristicTailorDecision.shouldAutoSkip === true, 'pending tailor flags low heuristic scores for skip confirmation');

assert(
  pendingNeedsContextualScore({ url: 'https://jobs.example/a', contextualScoreSource: undefined }) === true,
  'pending roles without LLM score still need contextual scoring'
);
assert(
  pendingNeedsContextualScore({ url: 'https://jobs.example/a', contextualScoreSource: 'llm' }) === false,
  'pending roles with LLM score do not get auto-rescored on refresh'
);
assert(
  pendingNeedsContextualScore({ url: 'https://jobs.example/a', contextualScoreSource: 'llm' }, { force: true }) === true,
  'forced rescoring can override prior LLM score state'
);
assert(
  pendingPassesScoreFilters({ relevance: 3.4 }, { minScore: 3.5 }) === false,
  'pipeline min score filter hides pending roles below the slider threshold'
);
assert(
  pendingPassesScoreFilters({ relevance: 3.5 }, { minScore: 3.5 }) === true,
  'pipeline min score filter keeps roles at the slider threshold'
);
assert(
  pendingPassesScoreFilters({ relevance: 3.9 }, { topOnly: true, minScore: 2.5 }) === false,
  'top-match filter still requires a 4+ score'
);
assert(
  pendingPassesScoreFilters({ relevance: 4.1 }, { topOnly: true, minScore: 4 }) === true,
  'top-match and slider filters can both pass'
);

const partiallySelectedPending = new Set(['https://jobs.example/a', 'https://jobs.example/hidden']);
assert(
  areAllPendingItemsSelected(partiallySelectedPending, [
    { url: 'https://jobs.example/a' },
    { url: 'https://jobs.example/b' },
  ]) === false,
  'pending select-all stays unchecked when any filtered row is missing from selection'
);
assert(
  areAllPendingItemsSelected(new Set(['https://jobs.example/a', 'https://jobs.example/b']), [
    { url: 'https://jobs.example/a' },
    { url: 'https://jobs.example/b' },
  ]) === true,
  'pending select-all reflects selection across the full filtered set'
);
const selectedFilteredPending = setPendingSelectionForItems(
  partiallySelectedPending,
  [{ url: 'https://jobs.example/a' }, { url: 'https://jobs.example/b' }],
  true
);
assert(
  selectedFilteredPending.has('https://jobs.example/a')
    && selectedFilteredPending.has('https://jobs.example/b')
    && selectedFilteredPending.has('https://jobs.example/hidden')
    && selectedFilteredPending.size === 3,
  'pending select-all adds only filtered rows and preserves unrelated hidden selections'
);
const deselectedFilteredPending = setPendingSelectionForItems(
  selectedFilteredPending,
  [{ url: 'https://jobs.example/a' }, { url: 'https://jobs.example/b' }],
  false
);
assert(
  deselectedFilteredPending.has('https://jobs.example/hidden')
    && !deselectedFilteredPending.has('https://jobs.example/a')
    && !deselectedFilteredPending.has('https://jobs.example/b')
    && deselectedFilteredPending.size === 1,
  'clearing pending select-all removes only filtered rows instead of wiping all selections'
);

const loadingScoreButton = renderPendingScoreButton({ url: 'https://jobs.example/a', contextualScoring: true });
assert(loadingScoreButton.includes('score-ring-loading'), 'pending score button renders loading state while contextual scoring runs');
assert(
  pendingTailorStatusLabel('scoring') === 'Scoring match...',
  'pending tailor row labels LLM scoring progress'
);
assert(
  pendingTailorStatusLabel('tailoring') === 'Tailoring bundle...',
  'pending tailor row labels bundle generation progress'
);
assert(
  pendingTailorStatusLabel('evaluating') === 'Running full report...',
  'pending tailor row labels full evaluation progress'
);
assert(
  pendingTailorStatusLabel('') === '',
  'pending tailor row hides progress label when idle'
);

assert(
  shouldAutoExpireLivenessResult(
    { status: 'expired', detail: 'pattern matched: filled' },
    { postedAt: '2026-01-01' },
    new Date('2026-06-08T00:00:00Z')
  ) === true,
  'explicit expired results always auto-expire'
);
assert(
  shouldAutoExpireLivenessResult(
    { status: 'uncertain', detail: 'HTTP 403 · barrier: captcha' },
    { postedAt: '2026-04-01' },
    new Date('2026-06-08T00:00:00Z')
  ) === true,
  'old barrier-based uncertain results age out'
);
assert(
  shouldAutoExpireLivenessResult(
    { status: 'uncertain', detail: 'HTTP 403 · barrier: captcha' },
    { postedAt: '2026-05-25' },
    new Date('2026-06-08T00:00:00Z')
  ) === false,
  'fresh barrier-based uncertain results stay pending'
);
assert(
  shouldAutoExpireLivenessResult(
    { status: 'uncertain', detail: 'content present but no explicit closed signal found' },
    { postedAt: '2026-01-01' },
    new Date('2026-06-08T00:00:00Z')
  ) === false,
  'generic uncertain results do not auto-expire'
);

console.log('\nPending tailor watcher');

const originalGetApplications = api.getApplications;
let getApplicationsCalls = 0;
api.getApplications = async () => {
  getApplicationsCalls += 1;
  if (getApplicationsCalls === 1) {
    return { applications: [], pending: [{ url: 'https://jobs.example/p1', company: 'Gamma', role: 'Engineer' }], skipped: [], expired: [] };
  }
  return {
    applications: [{ num: 42, jobUrl: 'https://jobs.example/p1', company: 'Gamma', role: 'Engineer', statusNormalized: 'tailored' }],
    pending: [],
    skipped: [],
    expired: [],
  };
};
const watchResult = await watchPendingTailorCompletion(
  { url: 'https://jobs.example/p1', company: 'Gamma', role: 'Engineer' },
  { timeoutMs: 50, intervalMs: 0 }
);
assert(watchResult === true, 'pending tailor watcher resolves when tailored row appears');
assert(getApplicationsCalls === 2, 'pending tailor watcher polls until the tailored row exists');
api.getApplications = originalGetApplications;

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exitCode = 1;
else console.log('All passed ✓');
