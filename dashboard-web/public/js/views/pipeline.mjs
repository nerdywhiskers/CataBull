import { api } from '../api.mjs';
import { deepProgressFromEvent, pendingRefreshProgressFromState, quickProgressFromEvent, renderScanProgress } from '../components/scan-progress.mjs';
import { toast } from '../components/toast.mjs';
import { confirmModal } from '../components/confirm.mjs';
import { openScoreModal } from '../components/score-modal.mjs';
import { runModePrompt } from '../lib/modes.mjs';
import { preserveFocus } from '../lib/focus.mjs';
import { INDUSTRIES } from '../lib/industries.mjs';
import { DEFAULT_PENDING_REFRESH_INTERVAL_MS, getPendingRefreshState, runPendingRefresh, subscribePendingRefresh } from '../lib/pending-refresh.mjs';
import {
  applyContextualScoreResults,
  contextualScoringEnabled,
  mergePendingContextualState,
} from '../lib/pending-contextual-scoring.mjs';

let apps = [];
let pending = [];
let skipped = [];
let expired = [];
let portalsData = null;         // tracked_companies, for industry lookup on pending filter
let selected = new Set();       // pending URLs
let selectedApps = new Set();   // application nums
let showTopMatchOnly = false;
let minPendingScore = 0;
let currentFilter = 'pending';
let sortCol = 'score';
let sortDir = 'desc';
let expandedRow = null;
let searchQuery = '';           // pipeline text search
let scanProgress = { visible: false };
let activeContainer = null;
let scanRunStatePoller = null;
let pendingRefreshPoller = null;
let lastObservedScanFinishedAt = '';
let pendingRefreshState = getPendingRefreshState();
let contextualScoringRun = 0;
let contextualScoringActive = false;
let contextualScoringError = '';

async function loadData() {
  try {
    const [data, portalsResp] = await Promise.all([
      api.getApplications(),
      api.getPortals().catch(() => null),
    ]);
    apps = data.applications || [];
    const nextPending = data.pending || [];
    pending = mergePendingContextualState(nextPending, pending);
    skipped = data.skipped || [];
    expired = data.expired || [];
    portalsData = portalsResp?.portals || null;
  } catch {
    apps = [];
    pending = [];
    skipped = [];
    expired = [];
    portalsData = null;
  }
}

function progressFromRunState(state) {
  if (!state?.active || !state.progress) return { visible: false };
  if (state.mode === 'deep') {
    return deepProgressFromEvent(state.progress)
      || quickProgressFromEvent(state.progress, { mode: 'Deep Scan · Quick phase' })
      || { visible: true, tone: 'running', eyebrow: 'Deep Scan', title: 'Scan running…', detail: '', meta: '' };
  }
  return quickProgressFromEvent(state.progress)
    || { visible: true, tone: 'running', eyebrow: 'Quick Scan', title: 'Scan running…', detail: '', meta: '' };
}

async function refreshData(container) {
  await loadData();
  if (container === activeContainer) update(container);
}

async function refreshPendingPostings(container, { force = false, source = 'auto' } = {}) {
  const manual = source === 'manual';
  if (manual) toast('Refreshing — verifying pending postings…');
  try {
    const result = await runPendingRefresh({
      pendingCount: pending.length,
      force,
      source,
      checkLivenessAll: () => api.checkLivenessAll(),
      reload: loadData,
      rerender: async () => {
        if (container === activeContainer) update(container);
      },
    });
    if (manual) {
      if (result?.error) toast(`Liveness check failed: ${result.error}`, 'error');
      else if (result?.checked) toast(`Checked ${result.checked} jobs — ${result.expired} expired`);
      else if (container === activeContainer) update(container);
    } else if (result?.error) {
      toast(`Auto-refresh failed: ${result.error}`, 'error');
    } else if (result?.expired) {
      toast(`Auto-refresh expired ${result.expired} posting${result.expired === 1 ? '' : 's'}`);
    }
    return result;
  } catch (err) {
    const message = manual ? `Liveness check failed: ${err.message}` : `Auto-refresh failed: ${err.message}`;
    toast(message, 'error');
    throw err;
  }
}

async function syncScanRunState(container, { refreshOnFinish = false } = {}) {
  const state = await api.getScanRunState().catch(() => null);
  if (!state || container !== activeContainer) return;

  if (state.active) {
    const next = progressFromRunState(state);
    const changed = JSON.stringify(next) !== JSON.stringify(scanProgress);
    setScanProgress(next);
    if (changed) update(container);
    else updateScanProgressSlot(container);
    return;
  }

  const finishedAt = state?.lastResult?.finishedAt || '';
  const justFinished = Boolean(finishedAt) && finishedAt !== lastObservedScanFinishedAt;
  if (finishedAt) lastObservedScanFinishedAt = finishedAt;
  const wasVisible = Boolean(scanProgress?.visible);
  if (wasVisible) setScanProgress({ visible: false });
  if (justFinished && refreshOnFinish) {
    await refreshData(container);
    return;
  }
  if (wasVisible) update(container);
}

function ensureLiveRefresh(container) {
  activeContainer = container;
  if (!scanRunStatePoller) {
    scanRunStatePoller = setInterval(() => {
      if (!activeContainer?.isConnected || !activeContainer.classList.contains('active')) return;
      syncScanRunState(activeContainer, { refreshOnFinish: true }).catch(() => {});
    }, 3000);
  }
  if (!pendingRefreshPoller) {
    pendingRefreshPoller = setInterval(() => {
      if (!activeContainer?.isConnected || !activeContainer.classList.contains('active')) return;
      refreshPendingPostings(activeContainer, { source: 'auto' }).catch(() => {});
    }, DEFAULT_PENDING_REFRESH_INTERVAL_MS);
  }
  if (!window.__catabullPipelineRefreshBound) {
    window.__catabullPipelineRefreshBound = true;
    subscribePendingRefresh((state) => {
      pendingRefreshState = state;
      if (!activeContainer?.isConnected || !activeContainer.classList.contains('active')) return;
      update(activeContainer);
    });
    window.addEventListener('catabull:data-maybe-changed', () => {
      if (!activeContainer?.isConnected || !activeContainer.classList.contains('active')) return;
      refreshData(activeContainer).catch(() => {});
      refreshPendingPostings(activeContainer, { source: 'auto' }).catch(() => {});
    });
  }
}

// ── Pending-list filter popover (industry / location / posted-date) ───
//
// Filters only the Pending tab — Evaluated/Applied/etc. already have their
// own status-based tabs. Persisted to localStorage so a fresh page load
// keeps the user's last filter set.
const PENDING_FILTER_KEY = 'catabull-pipeline-pending-filter';
const DATE_RANGE_OPTIONS = [
  { value: 'any',  label: 'Any time' },
  { value: '24h',  label: 'Last 24 hours' },
  { value: '7d',   label: 'Last 7 days' },
  { value: '30d',  label: 'Last 30 days' },
];

function loadPendingFilters() {
  try {
    const raw = localStorage.getItem(PENDING_FILTER_KEY);
    if (!raw) return { industries: new Set(), location: '', dateRange: 'any' };
    const parsed = JSON.parse(raw);
    return {
      industries: new Set(Array.isArray(parsed.industries) ? parsed.industries : []),
      location: typeof parsed.location === 'string' ? parsed.location : '',
      dateRange: DATE_RANGE_OPTIONS.some((o) => o.value === parsed.dateRange) ? parsed.dateRange : 'any',
    };
  } catch {
    return { industries: new Set(), location: '', dateRange: 'any' };
  }
}

function savePendingFilters() {
  try {
    localStorage.setItem(PENDING_FILTER_KEY, JSON.stringify({
      industries: [...pendingFilter.industries],
      location: pendingFilter.location,
      dateRange: pendingFilter.dateRange,
    }));
  } catch { /* localStorage can be disabled */ }
}

let pendingFilter = loadPendingFilters();
let filterPopoverOpen = false;
// Set true for one render pass when we want the popover's open animation
// to NOT replay — used by the location input handler so each keystroke
// doesn't trigger the 140ms fade-in (which reads as a flash).
let suppressPopoverAnim = false;
let pageSize = (() => {         // persisted per-page selection (5/10/25/50/100)
  const saved = parseInt(localStorage.getItem('catabull-pipeline-pagesize') || '10', 10);
  return [5, 10, 25, 50, 100].includes(saved) ? saved : 10;
})();
let currentPage = 1;            // 1-indexed; reset whenever filter/search changes

// Undo — last 5 reversible actions
const UNDO_HISTORY = [];
const UNDO_TIMEOUT = 5000;

function pushUndo(action) {
  UNDO_HISTORY.push({ ...action, timestamp: Date.now() });
  if (UNDO_HISTORY.length > 5) UNDO_HISTORY.shift();
  showUndoToast(action);
}

function showUndoToast(action) {
  const item = action.item || action.company || 'Item';
  const label = action.label || action.status || 'action';
  toast(`${item} ${label}`, {
    action: {
      label: 'Undo',
      onClick: () => {
        const idx = UNDO_HISTORY.findIndex(u => u.timestamp === action.timestamp);
        if (idx === -1) return;
        UNDO_HISTORY.splice(idx, 1);
        action.undo();
        toast('Undone');
      },
    },
  });
}

function scoreClass(score) {
  if (score >= 4.5) return 'excellent';
  if (score >= 4.0) return 'good';
  if (score >= 3.5) return 'decent';
  if (score >= 3.0) return 'low';
  return 'poor';
}

function setScanProgress(progress) {
  scanProgress = progress || { visible: false };
}

function updateScanProgressSlot(container) {
  const slot = container.querySelector('.scan-progress-slot');
  if (slot) slot.innerHTML = renderScanProgress(scanProgress);
}

function matchesSearch(item) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return (item.company || '').toLowerCase().includes(q)
    || (item.role || '').toLowerCase().includes(q)
    || (item.status || '').toLowerCase().includes(q);
}

// Look up a pending company's industries from portals.yml. Returns an
// empty array if the company isn't tracked (Deep Scan can surface roles
// from companies that aren't yet in tracked_companies).
function pendingIndustries(item) {
  if (!portalsData?.tracked_companies) return [];
  const lower = String(item.company || '').trim().toLowerCase();
  const entry = portalsData.tracked_companies.find((c) => String(c.name || '').toLowerCase() === lower);
  return Array.isArray(entry?.industries) ? entry.industries : [];
}

// Apply the popover filter to a pending row. Industries are AND-with-search
// (must match at least one selected industry); location is a case-
// insensitive substring; dateRange is a relative cutoff against postedAt.
function matchesPendingFilter(item) {
  // Industries: empty selection = no industry constraint.
  if (pendingFilter.industries.size > 0) {
    const inds = pendingIndustries(item);
    if (inds.length === 0) return false;
    let hit = false;
    for (const i of inds) {
      if (pendingFilter.industries.has(i)) { hit = true; break; }
    }
    if (!hit) return false;
  }

  // Location: substring match on the pipeline.md `loc:` field. Items
  // without a location field never match a non-empty location filter —
  // by design, so the user can filter out the legacy unlocated rows.
  // We trim the raw input *here* (at match time) rather than when storing
  // pendingFilter.location, so that trailing spaces the user is mid-typing
  // don't get erased by a re-render and break further input.
  const wantedLocation = pendingFilter.location.trim();
  if (wantedLocation) {
    const want = wantedLocation.toLowerCase();
    const have = String(item.location || '').toLowerCase();
    if (!have || !have.includes(want)) return false;
  }

  // Posted-date: relative cutoff. Items without postedAt never pass a
  // non-"any" filter. ISO dates compare lexicographically.
  if (pendingFilter.dateRange && pendingFilter.dateRange !== 'any') {
    if (!item.postedAt) return false;
    const now = new Date();
    const days = pendingFilter.dateRange === '24h' ? 1 : pendingFilter.dateRange === '7d' ? 7 : 30;
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
    if (item.postedAt < cutoff) return false;
  }

  return true;
}

function activeFilterCount() {
  let n = 0;
  if (pendingFilter.industries.size > 0) n++;
  if (pendingFilter.location) n++;
  if (pendingFilter.dateRange && pendingFilter.dateRange !== 'any') n++;
  return n;
}

function filtered() {
  return apps.filter(a => {
    if (currentFilter === 'all') return true;
    if (currentFilter === 'top') return a.score >= 4.0 && a.statusNormalized !== 'skip';
    if (a.statusNormalized !== currentFilter) return false;
    return matchesSearch(a);
  });
}

function sorted(list) {
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    let cmp = 0;
    switch (sortCol) {
      case 'score': cmp = a.score - b.score; break;
      case 'date': cmp = a.date.localeCompare(b.date); break;
      case 'company': cmp = a.company.localeCompare(b.company); break;
      case 'status': cmp = statusPri(a.statusNormalized) - statusPri(b.statusNormalized); break;
      default: cmp = a.score - b.score;
    }
    return cmp * dir;
  });
}

function statusPri(s) {
  const p = { interview: 0, offer: 1, responded: 2, applied: 3, evaluated: 4, skip: 5, rejected: 6, discarded: 7 };
  return p[s] ?? 8;
}

// Two-letter logo for the company-cell badge. Picks the leading letters of
// the first one or two words so "HelloFresh" → "He", "Acme Corp" → "AC".
function companyInitials(name) {
  if (!name) return '…';
  const words = String(name).trim().split(/\s+/).slice(0, 2);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Circular score ring used in the table's Match column. Stroke length tracks
// score / 5; tone class drives the fill color.
function renderScoreRing(score, tone, title = '') {
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const ratio = Math.max(0, Math.min(1, (Number(score) || 0) / 5));
  const offset = circumference * (1 - ratio);
  const t = title ? ` title="${esc(title)}"` : '';
  return `
    <span class="score-ring tone-${tone}"${t}>
      <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
        <circle class="ring-track" cx="24" cy="24" r="${radius}" fill="none" stroke-width="4" />
        <circle class="ring-fill"  cx="24" cy="24" r="${radius}" fill="none" stroke-width="4"
                stroke-linecap="round"
                stroke-dasharray="${circumference.toFixed(2)}"
                stroke-dashoffset="${offset.toFixed(2)}" />
      </svg>
      <span class="score-ring-value">${(Number(score) || 0).toFixed(1)}</span>
    </span>
  `;
}

function renderScoreLoading(title = 'Evaluating contextual match...') {
  return `
    <span class="score-ring score-ring-loading" title="${esc(title)}">
      <span class="spinner"></span>
    </span>
  `;
}

export function pendingNeedsContextualScore(item, { force = false } = {}) {
  return Boolean(item?.url && (force || item.contextualScoreSource !== 'llm'));
}

export function pendingPassesScoreFilters(item, { topOnly = false, minScore = 0 } = {}) {
  const score = Number(item?.relevance ?? 0);
  return (!topOnly || score >= 4) && score >= minScore;
}

export function renderPendingScoreButton(item) {
  if (item?.contextualScoring) {
    return `<button type="button" class="score-trigger score-trigger-loading" data-score-kind="pending" data-score-url="${esc(item.url || '')}" title="Evaluating contextual match...">${renderScoreLoading()}</button>`;
  }
  if (item?.relevance == null) return '';
  const tone = relevanceClass(item.relevance ?? 0);
  const title = item.contextualScoreSource === 'llm'
    ? (item.contextualRationale || 'LLM contextual match score')
    : (item.relevanceRationale || 'Click for match details');
  return `<button type="button" class="score-trigger" data-score-kind="pending" data-score-url="${esc(item.url || '')}" title="${esc(title)}">${renderScoreRing(item.relevance, tone, '')}</button>`;
}

function wrapTable(tableMarkup, className = 'table-scroll') {
  return `<div class="${className}">${tableMarkup}</div>`;
}

const SUGGESTION_BLOCK_META = {
  A: 'Tighten the CV bullets so they mirror the must-have experience in the job description.',
  B: 'Rewrite the positioning so the role clearly connects to your long-term direction, not just a generic fit.',
  C: 'Clarify comp expectations or target roles where the band better matches your range.',
  D: 'Adjust the narrative to explain why this team, product, or environment is a strong fit for you.',
  E: 'Address the red flags directly before spending more time on this role.',
};

function weakestScoreBlock(blocks = {}) {
  let weakest = null;
  for (const key of ['A', 'B', 'C', 'D', 'E']) {
    if (!Number.isFinite(blocks?.[key])) continue;
    if (!weakest || blocks[key] < weakest.value) weakest = { key, value: blocks[key] };
  }
  return weakest;
}

export function buildAiSuggestion(targetApps = []) {
  const candidates = targetApps
    .filter(a => ['applied', 'evaluated'].includes(a.statusNormalized) && a.score > 0)
    .sort((a, b) => a.score - b.score);
  const target = candidates[0] || null;
  if (!target) {
    return {
      body: 'No active applications to optimize yet — evaluate a top match and apply to start getting tailored suggestions.',
      ctaLabel: 'Optimize Now',
      targetNum: null,
      targetFilter: null,
      openScoreModal: false,
    };
  }

  const weakest = weakestScoreBlock(target.scoreBlocks);
  let body = '';
  if (weakest) {
    body = `${esc(target.company)} · ${esc(target.role)} is weakest on ${weakest.key} (${weakest.value.toFixed(1)}/5). ${SUGGESTION_BLOCK_META[weakest.key]}`;
  } else if (target.rationaleExcerpt) {
    body = `${esc(target.company)} · ${esc(target.role)} needs work: ${esc(target.rationaleExcerpt)}`;
  } else {
    body = `${esc(target.company)} · ${esc(target.role)} is your weakest active application at ${target.score.toFixed(1)}/5. Open the score breakdown and tighten the weakest part before you apply again.`;
  }

  return {
    body,
    ctaLabel: 'Open Score Breakdown',
    targetNum: target.num,
    targetFilter: target.statusNormalized === 'evaluated' ? 'evaluated' : 'applied',
    openScoreModal: true,
  };
}

// Renders the three-up insight row at the bottom of the Pipeline page —
// Match Insight, AI Suggestion, and the Add Entry CTA. Content adapts to
// whatever slice the pipeline is showing.
function renderInsightCards() {
  const topApplied = apps.filter(a => a.statusNormalized === 'applied');
  const topRoleWord = (() => {
    if (!topApplied.length) return null;
    const counts = new Map();
    for (const a of topApplied) {
      const word = (a.role || '').split(/\s+/).find(w => w.length > 4);
      if (word) counts.set(word, (counts.get(word) || 0) + 1);
    }
    let best = null;
    for (const [word, n] of counts) if (!best || n > best.n) best = { word, n };
    return best?.word || null;
  })();

  const matchInsightBody = topRoleWord
    ? `Roles matching <strong>"${esc(topRoleWord)}"</strong> are seeing the strongest engagement in your pipeline this week.`
    : `Apply to a few more roles to unlock pattern insights about which titles convert best for you.`;

  const aiSuggestion = buildAiSuggestion(apps);
  const aiSuggestionBody = aiSuggestion.body;

  return `
    <section class="pipeline-insights">
      <article class="insight-card tone-mauve">
        <div>
          <span class="insight-card-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2a5 5 0 0 0-3 9v3h6v-3a5 5 0 0 0-3-9z"/><path d="M8 18h4"/><path d="M9 16h2"/></svg>
          </span>
          <h3 class="insight-card-title">Match Insight</h3>
          <p class="insight-card-body">${matchInsightBody}</p>
        </div>
        <a class="insight-card-cta" href="#/analytics">View Analytics</a>
      </article>

      <article class="insight-card tone-indigo">
        <div>
          <span class="insight-card-icon">
            <svg width="22" height="20" viewBox="0 0 22 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="16" height="13" rx="3"/><circle cx="8" cy="9.5" r="1.2" fill="currentColor"/><circle cx="14" cy="9.5" r="1.2" fill="currentColor"/><path d="M11 1v2"/></svg>
          </span>
          <h3 class="insight-card-title">AI Suggestion</h3>
          <p class="insight-card-body">${aiSuggestionBody}</p>
        </div>
        <button class="insight-card-cta" id="insight-optimize-btn" type="button">${esc(aiSuggestion.ctaLabel)}</button>
      </article>

      <button class="insight-card is-empty insight-card-button" id="add-entry-btn" type="button">
        <span class="insight-card-icon">
          <svg width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="15" cy="15" r="12"/><line x1="15" y1="9" x2="15" y2="21"/><line x1="9" y1="15" x2="21" y2="15"/></svg>
        </span>
        <h3 class="insight-card-title">Add Entry</h3>
        <p class="insight-card-sub">Manually add a job to track</p>
      </button>
    </section>
  `;
}

function tabCount(key) {
  if (key === 'pending') return pending.length;
  if (key === 'all') return apps.length;
  if (key === 'top') return apps.filter(a => a.score >= 4.0 && a.statusNormalized !== 'skip').length;
  if (key === 'skip') return apps.filter(a => a.statusNormalized === 'skip' || a.statusNormalized === 'rejected').length + skipped.length + expired.length;
  return apps.filter(a => a.statusNormalized === key).length;
}

const FILTERS = [
  { key: 'pending', label: 'Pending' },
  { key: 'all', label: 'All' },
  { key: 'evaluated', label: 'Evaluated' },
  { key: 'applied', label: 'Applied' },
  { key: 'interview', label: 'Interview' },
  { key: 'top', label: 'Top \u22654' },
  { key: 'skip', label: 'Skip' },
];

function renderFilters() {
  return `<div class="filter-tabs">${FILTERS.map(f =>
    `<button class="filter-tab${currentFilter === f.key ? ' active' : ''}" data-filter="${f.key}">${f.label}<span class="count">${tabCount(f.key)}</span></button>`
  ).join('')}</div>`;
}

function relevanceClass(score) {
  if (score >= 4) return 'excellent';
  if (score >= 3) return 'good';
  if (score >= 2) return 'decent';
  if (score >= 1) return 'low';
  return 'poor';
}

export function shouldWarnLowTailorScore(score) {
  return Number.isFinite(score) && score < 3;
}

export function shouldEnableTailorArtifacts(item) {
  return item?.statusNormalized === 'evaluated' && Number(item?.score) > 3;
}

export function shouldShowTailorArtifactLinks(item) {
  return shouldEnableTailorArtifacts(item) && Boolean(
    item?.tailorBundle?.paths?.cv
    || item?.tailorBundle?.paths?.coverLetter
    || item?.tailorBundle?.paths?.qa
    || item?.tailorBundle?.paths?.cvPdf
    || item?.tailorBundle?.paths?.coverLetterPdf
  );
}

export function pendingTailorDecision(item) {
  const llmScore = Number(item?.contextualScore);
  const heuristicScore = Number(item?.relevance);
  const hasLlm = item?.contextualScoreSource === 'llm' && Number.isFinite(llmScore);
  const score = hasLlm ? llmScore : heuristicScore;
  return {
    score,
    scoreSource: hasLlm ? 'llm' : 'heuristic',
    shouldWarn: shouldWarnLowTailorScore(score),
  };
}

// Tooltip for evaluated applications — shows the per-block A–E breakdown
// (parsed from the report) so the user can see how the global score was
// derived without opening the report. Returns '' when blocks weren't
// parseable so callers fall back to a generic tooltip.
function scoreBlocksTooltip(blocks) {
  if (!blocks || typeof blocks !== 'object') return '';
  const labels = { A: 'Match', B: 'North Star', C: 'Comp', D: 'Cultural', E: 'Red flags' };
  const parts = [];
  for (const k of ['A', 'B', 'C', 'D', 'E']) {
    if (Number.isFinite(blocks[k])) parts.push(`${labels[k]}: ${blocks[k]}/5`);
  }
  return parts.length ? parts.join(' · ') : '';
}

function renderFilterButton() {
  const n = activeFilterCount();
  const badge = n > 0 ? `<span class="pipeline-filter-badge">${n}</span>` : '';
  return `
    <button class="btn-icon pipeline-filter-btn${n > 0 ? ' is-active' : ''}${filterPopoverOpen ? ' is-open' : ''}" id="pipeline-filter-btn" type="button" aria-label="Filter pending jobs" aria-expanded="${filterPopoverOpen ? 'true' : 'false'}" title="Filter by industry, location, posted date">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1.5 2h11l-4 5v5l-3-1.5V7l-4-5z"/>
      </svg>
      ${badge}
    </button>
  `;
}

function renderFilterPopover() {
  const industries = INDUSTRIES.map((i) => {
    const active = pendingFilter.industries.has(i.id);
    return `<button class="pipeline-filter-chip${active ? ' is-active' : ''}" data-industry="${esc(i.id)}" type="button" title="${esc(i.description || '')}">${esc(i.label)}</button>`;
  }).join('');

  const dateOptions = DATE_RANGE_OPTIONS.map((o) =>
    `<option value="${o.value}"${o.value === pendingFilter.dateRange ? ' selected' : ''}>${o.label}</option>`
  ).join('');

  return `
    <div class="pipeline-filter-popover${suppressPopoverAnim ? ' no-anim' : ''}" role="dialog" aria-label="Filter pending jobs">
      <div class="pipeline-filter-section">
        <div class="pipeline-filter-section-head">
          <span class="pipeline-filter-section-title">Industry</span>
          ${pendingFilter.industries.size > 0 ? `<button class="pipeline-filter-clear" type="button" data-clear="industries">Clear (${pendingFilter.industries.size})</button>` : ''}
        </div>
        <div class="pipeline-filter-chips">${industries}</div>
      </div>
      <div class="pipeline-filter-section">
        <div class="pipeline-filter-section-head">
          <span class="pipeline-filter-section-title">Location</span>
          ${pendingFilter.location ? '<button class="pipeline-filter-clear" type="button" data-clear="location">Clear</button>' : ''}
        </div>
        <input type="text" class="form-input pipeline-filter-location" id="pipeline-filter-location-input" placeholder="e.g. Remote, Berlin, US" value="${esc(pendingFilter.location)}" />
        <p class="pipeline-filter-hint">Substring match. Jobs without a location won't appear when this is set.</p>
      </div>
      <div class="pipeline-filter-section">
        <div class="pipeline-filter-section-head">
          <span class="pipeline-filter-section-title">Posted</span>
          ${pendingFilter.dateRange !== 'any' ? '<button class="pipeline-filter-clear" type="button" data-clear="date">Clear</button>' : ''}
        </div>
        <select class="form-select pipeline-filter-date" id="pipeline-filter-date-select">${dateOptions}</select>
        <p class="pipeline-filter-hint">Jobs without a posted date won't appear when a window is set.</p>
      </div>
      <div class="pipeline-filter-footer">
        <button class="btn btn-ghost btn-sm" type="button" id="pipeline-filter-reset">Reset all</button>
        <button class="btn btn-sm btn-primary" type="button" id="pipeline-filter-close">Done</button>
      </div>
    </div>
  `;
}

// Wires the filter button + popover. Idempotent — safe to call from
// update(); listeners only fire when their elements are present.
function bindFilterPopover(container) {
  const btn = container.querySelector('#pipeline-filter-btn');
  if (btn) {
    btn.onclick = (e) => {
      e.stopPropagation();
      filterPopoverOpen = !filterPopoverOpen;
      update(container);
    };
  }

  if (!filterPopoverOpen) return;

  // Click-outside-to-close. Captured at document level; removed when the
  // popover is dismissed or when this listener fires.
  const onDocClick = (e) => {
    if (e.target.closest('.pipeline-filter-popover')) return;
    if (e.target.closest('#pipeline-filter-btn')) return;
    filterPopoverOpen = false;
    document.removeEventListener('click', onDocClick, true);
    update(container);
  };
  document.addEventListener('click', onDocClick, true);

  // Industry chip toggle. Multi-select.
  container.querySelectorAll('.pipeline-filter-chip').forEach((chip) => {
    chip.onclick = (e) => {
      e.stopPropagation();
      const id = chip.dataset.industry;
      if (pendingFilter.industries.has(id)) pendingFilter.industries.delete(id);
      else pendingFilter.industries.add(id);
      savePendingFilters();
      currentPage = 1;
      update(container);
    };
  });

  // Location input — apply on input with a short debounce so typing
  // doesn't thrash the table. Store the *raw* (untrimmed) value so a
  // trailing space the user just typed survives the re-render; the
  // filter match function trims at compare time.
  const locInput = container.querySelector('#pipeline-filter-location-input');
  if (locInput) {
    let debounceTimer;
    locInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      const val = e.target.value;
      debounceTimer = setTimeout(() => {
        pendingFilter.location = val;
        savePendingFilters();
        currentPage = 1;
        // Suppress the popover's fade-in animation for this single
        // re-render — otherwise it replays on every keystroke and reads
        // as a flash. Reset immediately after; the next user-initiated
        // open of the popover gets the animation again.
        suppressPopoverAnim = true;
        preserveFocus(container, () => update(container));
        suppressPopoverAnim = false;
      }, 220);
    });
  }

  // Posted-date select.
  const dateSelect = container.querySelector('#pipeline-filter-date-select');
  if (dateSelect) {
    dateSelect.onchange = () => {
      pendingFilter.dateRange = dateSelect.value;
      savePendingFilters();
      currentPage = 1;
      update(container);
    };
  }

  // Per-section clear buttons.
  container.querySelectorAll('.pipeline-filter-clear').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const which = b.dataset.clear;
      if (which === 'industries') pendingFilter.industries = new Set();
      else if (which === 'location') pendingFilter.location = '';
      else if (which === 'date') pendingFilter.dateRange = 'any';
      savePendingFilters();
      currentPage = 1;
      update(container);
    };
  });

  // Reset all.
  const resetBtn = container.querySelector('#pipeline-filter-reset');
  if (resetBtn) {
    resetBtn.onclick = (e) => {
      e.stopPropagation();
      pendingFilter = { industries: new Set(), location: '', dateRange: 'any' };
      savePendingFilters();
      currentPage = 1;
      update(container);
    };
  }

  // Close button.
  const closeBtn = container.querySelector('#pipeline-filter-close');
  if (closeBtn) {
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      filterPopoverOpen = false;
      document.removeEventListener('click', onDocClick, true);
      update(container);
    };
  }
}

export async function watchPendingTailorCompletion(item, { timeoutMs = 300_000, intervalMs = 2500 } = {}) {
  if (!item?.url) return false;
  const startedAt = Date.now();
  const normalizedCompany = String(item.company || '').trim().toLowerCase();
  const normalizedRole = String(item.role || '').trim().toLowerCase();

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const data = await api.getApplications().catch(() => null);
    if (!data) continue;
    const found = (data.applications || []).find((app) => (
      app.jobUrl === item.url
      || (
        String(app.company || '').trim().toLowerCase() === normalizedCompany
        && String(app.role || '').trim().toLowerCase() === normalizedRole
      )
    ));
    if (!found) continue;
    apps = data.applications || [];
    pending = data.pending || [];
    skipped = data.skipped || [];
    expired = data.expired || [];
    currentFilter = 'evaluated';
    expandedRow = found.num;
    if (activeContainer) update(activeContainer);
    toast(`${found.company} moved to Evaluated`);
    return true;
  }

  return false;
}

async function openPendingEditModal(item) {
  if (!item) return;
  const result = await confirmModal({
    title: 'Edit pending role',
    confirmText: 'Save changes',
    body: `
      <div class="form-group"><label class="form-label">Company</label><input class="form-input" data-return="company" type="text" value="${esc(item.company || '')}" autocomplete="off" autofocus></div>
      <div class="form-group"><label class="form-label">Role</label><input class="form-input" data-return="role" type="text" value="${esc(item.role || '')}" autocomplete="off"></div>
      <div class="form-group"><label class="form-label">Posted date</label><input class="form-input" data-return="postedAt" type="date" value="${esc(item.postedAt || '')}" autocomplete="off"></div>
      <div class="form-group"><label class="form-label">Location</label><input class="form-input" data-return="location" type="text" value="${esc(item.location || '')}" autocomplete="off" placeholder="Remote / Los Angeles / Hybrid"></div>
    `,
  });
  if (!result?.data) return;
  const company = String(result.data.company || '').trim();
  const role = String(result.data.role || '').trim();
  const postedAt = String(result.data.postedAt || '').trim();
  const location = String(result.data.location || '').trim();
  if (!company || !role) {
    toast('Company and role are required.', 'error');
    return;
  }
  try {
    await api.updatePending({ url: item.url, company, role, postedAt, location });
    toast('Pending role updated');
    await refreshData(activeContainer);
  } catch (err) {
    toast(`Failed to update pending role: ${err.message}`, 'error');
  }
}

async function startContextualScoring(container, { force = false, urls = null } = {}) {
  if ((!contextualScoringEnabled() && !force) || contextualScoringActive || pending.length === 0) return;
  const requestedUrls = Array.isArray(urls)
    ? new Set(urls.map((url) => String(url || '').trim()).filter(Boolean))
    : null;
  const targetUrls = pending
    .filter((item) => (!requestedUrls || requestedUrls.has(item.url)) && pendingNeedsContextualScore(item, { force }))
    .map((item) => item.url);
  if (!targetUrls.length) return;

  const runId = ++contextualScoringRun;
  contextualScoringActive = true;
  contextualScoringError = '';
  pending = pending.map((item) => targetUrls.includes(item.url) ? { ...item, contextualScoring: true } : item);
  if (container === activeContainer) update(container);

  try {
    const result = await api.getContextualScores(targetUrls);
    if (runId !== contextualScoringRun) return;
    pending = applyContextualScoreResults(pending, result.scores || []);
  } catch (err) {
    if (runId !== contextualScoringRun) return;
    contextualScoringError = err.message || String(err);
    pending = pending.map((item) => targetUrls.includes(item.url) ? { ...item, contextualScoring: false } : item);
    toast(`Contextual scoring unavailable: ${contextualScoringError}`, 'error');
  } finally {
    if (runId === contextualScoringRun) {
      contextualScoringActive = false;
      if (container === activeContainer) update(container);
    }
  }
}

function renderPending(pageItems = null) {
  if (!pending.length) return `<div class="empty-state"><h3>No pending jobs</h3><p>Run a scan to discover new roles, or paste a job description in the chat.</p></div>`;

  const baseFiltered = pending.filter(p => pendingPassesScoreFilters(p, {
    topOnly: showTopMatchOnly,
    minScore: minPendingScore,
  }));
  const fullFiltered = baseFiltered.filter(p => matchesSearch(p)).filter(matchesPendingFilter);
  const filtered = pageItems ?? fullFiltered;

  const allSelected = filtered.length > 0 && filtered.every(p => selected.has(p.url));
  const anySelected = selected.size > 0;

  if (!filtered.length) {
    return `<div class="empty-state"><h3>No top matches</h3><p>Uncheck the filter to see all ${pending.length} pending jobs.</p></div>`;
  }

  const batchBar = anySelected ? `
    <div class="pipeline-batchbar">
      <span class="pipeline-batchbar-count">${selected.size} selected</span>
      <button class="btn btn-sm btn-outline" id="batch-skip-btn">Skip</button>
      <button class="btn btn-sm btn-secondary" id="batch-tailor-btn">Tailor</button>
      <button class="btn btn-sm btn-soft" id="batch-apply-btn">Mark Applied</button>
      <button class="btn btn-sm btn-outline btn-danger" id="batch-delete-btn" title="Permanently delete selected pending jobs">Delete</button>
      <button class="btn btn-ghost btn-sm" id="batch-clear-btn" style="margin-left:auto">Clear</button>
    </div>
  ` : '';

  const rows = filtered.map(p => {
    const tone = relevanceClass(p.relevance ?? 0);
    return `
    <tr data-url="${esc(p.url)}" data-company="${esc(p.company)}" data-role="${esc(p.role)}" data-posted-at="${esc(p.postedAt || '')}" data-location="${esc(p.location || '')}">
      <td class="col-check"><input type="checkbox" class="pending-check" data-url="${esc(p.url)}" ${selected.has(p.url) ? 'checked' : ''}></td>
      <td class="col-company">
        <span class="cell-company">
          <span class="cell-company-logo">${esc(companyInitials(p.company))}</span>
          <span>${esc(p.company)}</span>
        </span>
      </td>
      <td><span class="cell-role">${esc(p.role)}</span></td>
      <td><span class="cell-date">${p.postedAt || ''}</span></td>
      <td class="col-score">${renderPendingScoreButton(p)}</td>
      <td class="col-actions">
        <span class="cell-actions">
          <a href="${esc(p.url)}" target="_blank" class="btn btn-ghost btn-sm" title="Open posting">&#x2197;</a>
          <button class="btn btn-sm btn-outline pending-skip-btn" data-url="${esc(p.url)}" title="Skip this role">Skip</button>
          <button class="btn btn-sm btn-secondary pending-tailor-btn" data-url="${esc(p.url)}" data-company="${esc(p.company)}" data-role="${esc(p.role)}" title="Score this role and draft a tailored CV when it is a strong fit">Tailor</button>
          <button class="btn btn-sm btn-soft pending-apply-btn" data-url="${esc(p.url)}" data-company="${esc(p.company)}" data-role="${esc(p.role)}" title="Mark as Applied">Applied</button>
          ${overflowMenu([
            { label: 'Edit role', onClick: () => openPendingEditModal(p) },
            { label: 'Deep Research', onClick: () => runModePrompt('deep', { company: p.company, role: p.role, url: p.url }) },
            { label: 'Outreach',      onClick: () => runModePrompt('outreach', { company: p.company, role: p.role, url: p.url }) },
          ])}
        </span>
      </td>
    </tr>
  `;
  }).join('');

  return `
    ${batchBar}
    ${wrapTable(`<table class="data-table pipeline-table pending-table">
      <thead><tr>
        <th class="col-check"><input type="checkbox" id="select-all" ${allSelected ? 'checked' : ''}></th>
        <th>Company</th>
        <th>Role</th>
        <th>Posted Date</th>
        <th class="col-score">Match</th>
        <th class="col-actions">Actions</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`, 'table-scroll table-scroll-pipeline')}
  `;
}

function groupByDate(items) {
  const groups = {};
  for (const item of items) {
    const key = item.date || 'Unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  // Sort dates descending (newest first)
  return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));
}

function renderCollapsibleGroup(label, items, style = '') {
  return `
    <details class="skip-group" ${style}>
      <summary class="skip-group-summary">
        <span>${label}</span>
        <span class="skip-group-count">${items.length}</span>
      </summary>
      ${wrapTable(`<table class="data-table data-table-compact pipeline-table skip-table">
        <tbody>${items.map(s => `
          <tr class="is-muted">
            <td class="col-company">
              <span class="cell-company">
                <span class="cell-company-logo">${esc(companyInitials(s.company))}</span>
                <span>${esc(s.company)}</span>
              </span>
            </td>
            <td><span class="cell-role"${s.status === 'EXPIRED' ? ' style="text-decoration:line-through"' : ''}>${esc(s.role)}</span></td>
            <td class="col-actions">
              <span class="cell-actions">
                <a href="${esc(s.url)}" target="_blank" class="btn btn-ghost btn-sm" title="Open posting">&#x2197;</a>
                ${s.status !== 'EXPIRED' ? `<button class="btn btn-sm btn-outline unskip-btn" data-url="${esc(s.url)}" title="Restore to pending">Restore</button>` : ''}
              </span>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`, 'table-scroll table-scroll-compact')}
    </details>`;
}

function renderSkipped() {
  const rejected = rejectedApps();
  const allItems = [
    ...skipped.map(s => ({ ...s, type: 'skipped' })),
    ...expired.map(e => ({ ...e, type: 'expired', status: 'EXPIRED' })),
  ];
  if (!allItems.length && !rejected.length) return '';

  const dated = groupByDate(allItems);

  let html = '<div class="skip-section">';
  html += `<header class="skip-section-head">
    <h3>Skipped &amp; Expired</h3>
    <span>${allItems.length} total</span>
  </header>`;

  dated.forEach(([date, items], i) => {
    const expiredCount = items.filter(it => it.status === 'EXPIRED').length;
    const label = date === 'Unknown' ? 'Undated'
      : `${date}${expiredCount > 0 ? ` \u00B7 ${expiredCount} expired` : ''}`;
    html += renderCollapsibleGroup(label, items, i === 0 ? 'open' : '');
  });

  if (rejected.length) {
    html += `
      <details class="skip-group skip-group-rejected" style="margin-top:16px">
        <summary class="skip-group-summary is-danger">
          <span>Rejected</span>
          <span class="skip-group-count">${rejected.length}</span>
        </summary>
        ${wrapTable(`<table class="data-table data-table-compact pipeline-table skip-table">
          <tbody>${rejected.map(r => `
            <tr class="is-muted">
              <td><span class="cell-date">${r.date}</span></td>
              <td class="col-company">
                <span class="cell-company">
                  <span class="cell-company-logo">${esc(companyInitials(r.company))}</span>
                  <span>${esc(r.company)}</span>
                </span>
              </td>
              <td><span class="cell-role">${esc(r.role)}</span></td>
              <td class="col-score">${r.score > 0
                ? `<button type="button" class="score-trigger" data-score-kind="evaluated" data-score-num="${r.num}" title="${esc(scoreBlocksTooltip(r.scoreBlocks) || 'Score at rejection')}">${renderScoreRing(r.score, scoreClass(r.score), '')}</button>`
                : ''}</td>
              <td class="col-actions">
                <span class="cell-actions">
                  ${r.jobUrl ? `<a href="${esc(r.jobUrl)}" target="_blank" class="btn btn-ghost btn-sm">&#x2197;</a>` : ''}
                </span>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>`, 'table-scroll table-scroll-compact')}
      </details>`;
  }

  html += '</div>';
  return html;
}

function renderTable(items) {
  if (!items.length && currentFilter === 'skip') {
    if (skipped.length || expired.length || rejectedApps().length) return renderSkipped();
    return `<div class="empty-state"><h3>No skipped jobs</h3></div>`;
  }
  if (!items.length) return `<div class="empty-state"><h3>No applications yet</h3><p>Evaluate a job to get started.</p></div>`;

  const batchActions = batchActionsForFilter(currentFilter);
  const showCheckboxes = batchActions.length > 0;
  const anyAppSelected = selectedApps.size > 0;
  const allAppsSelected = showCheckboxes && items.length > 0 && items.every(a => selectedApps.has(a.num));

  const arrow = (col) => sortCol === col ? `<span class="sort-arrow">${sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>` : '';
  const thClass = (col) => sortCol === col ? 'sorted' : '';

  // Batch action bar for evaluated/applied tabs
  const appBatchBar = (showCheckboxes && anyAppSelected) ? `
    <div class="pipeline-batchbar">
      <span class="pipeline-batchbar-count">${selectedApps.size} selected</span>
      ${batchActions.map(action => `
        <button class="btn btn-sm btn-${action.tone} app-batch-btn" data-status="${esc(action.status)}">${esc(action.label)}</button>
      `).join('')}
      <button class="btn btn-ghost btn-sm" id="app-batch-clear" style="margin-left:auto">Clear</button>
    </div>
  ` : '';

  let rows = '';
  for (const a of items) {
    const statusActions = rowActionsForStatus(a.statusNormalized);
    const tone = scoreClass(a.score);

    rows += `<tr data-num="${a.num}" data-url="${esc(a.jobUrl || '')}" data-company="${esc(a.company)}" data-role="${esc(a.role)}" class="${expandedRow === a.num ? 'expanded' : ''}">
      ${showCheckboxes ? `<td class="col-check"><input type="checkbox" class="app-check" data-num="${a.num}" ${selectedApps.has(a.num) ? 'checked' : ''}></td>` : ''}
      <td class="col-num">${a.num}</td>
      <td><span class="cell-date">${a.date}</span></td>
      <td class="col-company">
        <span class="cell-company">
          <span class="cell-company-logo">${esc(companyInitials(a.company))}</span>
          <span>${esc(a.company)}</span>
        </span>
      </td>
      <td><span class="cell-role">${esc(a.role)}</span></td>
      <td class="col-score">${a.score > 0
        ? `<button type="button" class="score-trigger" data-score-kind="evaluated" data-score-num="${a.num}" title="${esc(scoreBlocksTooltip(a.scoreBlocks) || 'Click for match details')}">${renderScoreRing(a.score, tone, '')}</button>`
        : ''}</td>
      <td class="col-status"><span class="badge badge-status ${a.statusNormalized}">${esc(a.statusNormalized)}</span></td>
      <td class="col-actions">
        <span class="cell-actions">
          ${a.jobUrl ? `<a href="${esc(a.jobUrl)}" target="_blank" class="btn btn-ghost btn-sm" title="Open job posting">&#x2197;</a>` : ''}
          ${statusActions.map(action => `
            <button class="btn btn-sm btn-${action.tone} app-status-btn" data-num="${a.num}" data-status="${esc(action.status)}" title="${esc(action.title)}">${esc(action.label)}</button>
          `).join('')}
          ${shouldEnableTailorArtifacts(a) ? `
            <button class="btn btn-sm btn-outline app-pdf-btn" data-url="${esc(a.jobUrl || '')}" data-company="${esc(a.company)}" data-role="${esc(a.role)}">PDF</button>
          ` : ''}
          ${shouldShowTailorArtifactLinks(a) ? `
            ${a.tailorBundle?.paths?.cv ? `<a href="${esc(api.tailorFileUrl(a.tailorBundle.paths.cv))}" target="_blank" class="btn btn-sm btn-outline" title="Download tailored CV markdown">CV</a>` : ''}
            ${a.tailorBundle?.paths?.cvPdf ? `<a href="${esc(api.tailorFileUrl(a.tailorBundle.paths.cvPdf))}" target="_blank" class="btn btn-sm btn-outline" title="Download tailored CV PDF">CV PDF</a>` : ''}
            ${a.tailorBundle?.paths?.coverLetter ? `<a href="${esc(api.tailorFileUrl(a.tailorBundle.paths.coverLetter))}" target="_blank" class="btn btn-sm btn-outline" title="Download tailored cover letter markdown">Cover</a>` : ''}
            ${a.tailorBundle?.paths?.coverLetterPdf ? `<a href="${esc(api.tailorFileUrl(a.tailorBundle.paths.coverLetterPdf))}" target="_blank" class="btn btn-sm btn-outline" title="Download tailored cover letter PDF">Cover PDF</a>` : ''}
          ` : ''}
          ${a.reportPath ? `<button class="btn btn-ghost btn-sm view-report-btn" data-report="${esc(a.reportPath)}" title="View report">&#x1F4C4;</button>` : ''}
          ${overflowMenu([
            { label: 'Outreach',       onClick: () => runModePrompt('outreach', { company: a.company, role: a.role, url: a.jobUrl || '' }) },
            ...(shouldEnableTailorArtifacts(a)
              ? [{ label: 'Apply Mode',     onClick: () => runModePrompt('apply', { company: a.company, role: a.role, url: a.jobUrl || '' }) }]
              : []),
            ...(shouldShowTailorArtifactLinks(a) && a.tailorBundle?.paths?.qa
              ? [{ label: 'Application Q&A', onClick: () => window.open(api.tailorFileUrl(a.tailorBundle.paths.qa), '_blank', 'noopener') }]
              : []),
            ...(a.statusNormalized === 'applied' || a.statusNormalized === 'interview'
              ? [{ label: 'Prep Interview', onClick: () => runModePrompt('interview-prep', { company: a.company, role: a.role, url: a.jobUrl || '' }) }]
              : []),
          ])}
        </span>
      </td>
    </tr>`;

    if (expandedRow === a.num && a.enrichment) {
      const e = a.enrichment;
      const colSpan = showCheckboxes ? 8 : 7;
      rows += `<tr class="expanded"><td colspan="${colSpan}"><div class="row-detail">
        <div><dt>Archetype</dt><dd>${esc(e.archetype || '\u2014')}</dd></div>
        <div><dt>TL;DR</dt><dd>${esc(e.tldr || '\u2014')}</dd></div>
        <div><dt>Remote</dt><dd>${esc(e.remote || '\u2014')}</dd></div>
        <div><dt>Comp</dt><dd>${esc(e.comp || '\u2014')}</dd></div>
        <div><dt>Notes</dt><dd>${esc(a.notes || '\u2014')}</dd></div>
        ${renderScoreBreakdown(a)}
      </div></td></tr>`;
    }
  }

  let html = `${appBatchBar}${wrapTable(`<table class="data-table pipeline-table applications-table">
    <thead><tr>
      ${showCheckboxes ? `<th class="col-check"><input type="checkbox" id="select-all-apps" ${allAppsSelected ? 'checked' : ''}></th>` : ''}
      <th class="col-num">#</th>
      <th class="${thClass('date')}" data-sort="date">Date${arrow('date')}</th>
      <th class="${thClass('company')}" data-sort="company">Company${arrow('company')}</th>
      <th>Role</th>
      <th class="col-score ${thClass('score')}" data-sort="score">Match${arrow('score')}</th>
      <th class="${thClass('status')}" data-sort="status">Status${arrow('status')}</th>
      <th class="col-actions">Actions</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`, 'table-scroll table-scroll-pipeline')}`;

  if (currentFilter === 'skip') html += renderSkipped();

  return html;
}

export function rowActionsForStatus(status) {
  if (status === 'evaluated') {
    return [
      { status: 'Applied', label: 'Applied', tone: 'soft', title: 'Mark as Applied' },
      { status: 'SKIP', label: 'Skip', tone: 'outline', title: 'Move to Skip' },
    ];
  }
  if (status === 'skip') {
    return [
      { status: 'Evaluated', label: 'Restore', tone: 'soft', title: 'Move back to Evaluated' },
    ];
  }
  if (status === 'applied' || status === 'responded') {
    return [
      { status: 'Interview', label: 'Interviewed', tone: 'soft', title: 'Move to Interview' },
      { status: 'Rejected', label: 'Rejected', tone: 'outline', title: 'Move to Rejected' },
    ];
  }
  if (status === 'interview') {
    return [
      { status: 'Offer', label: 'Offer', tone: 'soft', title: 'Move to Offer' },
      { status: 'Rejected', label: 'Rejected', tone: 'outline', title: 'Move to Rejected' },
    ];
  }
  return [];
}

export function batchActionsForFilter(filter) {
  if (filter === 'evaluated') {
    return [
      { status: 'Applied', label: 'Applied', tone: 'soft' },
      { status: 'SKIP', label: 'Skip', tone: 'outline' },
    ];
  }
  if (filter === 'skip') {
    return [
      { status: 'Evaluated', label: 'Restore', tone: 'soft' },
    ];
  }
  if (filter === 'applied' || filter === 'responded') {
    return [
      { status: 'Interview', label: 'Interviewed', tone: 'soft' },
      { status: 'Rejected', label: 'Rejected', tone: 'outline' },
    ];
  }
  if (filter === 'interview') {
    return [
      { status: 'Offer', label: 'Offer', tone: 'soft' },
      { status: 'Rejected', label: 'Rejected', tone: 'outline' },
    ];
  }
  return [];
}

function rejectedApps() {
  return apps.filter(a => a.statusNormalized === 'rejected');
}

function isAlreadyEvaluated(company, role) {
  const c = company.toLowerCase();
  const r = role.toLowerCase();
  return apps.some(a => a.company.toLowerCase() === c && a.role.toLowerCase() === r);
}

function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// Per-block score breakdown for the expanded application row (issue #28).
// Surfaces sub-scores parsed by dashboard-web/lib/parsers.mjs out of the
// report markdown, alongside the pinned weights from modes/_shared.md so
// the user can audit how the global score was derived. Returns empty
// markup when the report didn't contain a parseable breakdown.
const SCORE_BLOCKS = [
  { letter: 'A', label: 'Match con CV', weight: 0.30 },
  { letter: 'B', label: 'North Star',   weight: 0.25 },
  { letter: 'C', label: 'Comp',         weight: 0.20 },
  { letter: 'D', label: 'Cultural',     weight: 0.15 },
  { letter: 'E', label: 'Red flags',    weight: 0.10, isPenalty: true },
];

function renderScoreBreakdown(app) {
  const blocks = app.scoreBlocks;
  if (!blocks || Object.keys(blocks).length === 0) return '';

  const cells = SCORE_BLOCKS.map(({ letter, label, weight, isPenalty }) => {
    const value = blocks[letter];
    if (value === undefined) return '';
    const pct = Math.round(weight * 100);
    const weightLabel = isPenalty ? `−${pct}% penalty` : `${pct}%`;
    return `
      <div class="score-block" title="${esc(label)} (${weightLabel} weight)">
        <span class="score-block-letter">${letter}</span>
        <span class="score-block-label">${esc(label)}</span>
        <span class="score-block-value">${value.toFixed(1)}</span>
      </div>
    `;
  }).filter(Boolean).join('');

  if (!cells) return '';

  const computed = (typeof app.scoreComputed === 'number') ? app.scoreComputed : null;
  const computedDelta = computed != null && Math.abs(computed - app.score) > 0.05
    ? `<span class="score-block-delta" title="Reported score in tracker disagrees with the formula on the report's per-block scores. Likely a stale tracker entry — re-run the report.">tracker shows ${app.score.toFixed(1)}</span>`
    : '';
  const summary = computed != null
    ? `${computed.toFixed(1)}/5 ${computedDelta}`
    : `${app.score?.toFixed(1) || '—'}/5`;

  return `
    <div class="score-breakdown" style="grid-column:1/-1">
      <dt>Score breakdown <span class="score-breakdown-formula" title="Pinned weights — see modes/_shared.md">A·30% + B·25% + C·20% + D·15% − (5−E)·10%</span></dt>
      <dd>
        <div class="score-block-grid">${cells}</div>
        <div class="score-block-summary">= ${summary}</div>
      </dd>
    </div>
  `;
}

// Overflow menu for action buttons. Items are real objects with onClick
// callbacks; we keep them in a registry keyed by a generated id so the
// rendered button can look up its handler without going through string
// eval. (The previous data-handler / new Function approach silently
// dropped clicks AND would have been blocked by the dashboard's CSP.)
let overflowSeq = 0;
const overflowRegistry = new Map();

function overflowMenu(items, triggerClass = '') {
  const id = `om${++overflowSeq}`;
  overflowRegistry.set(id, items);

  const btns = items.map((item, i) => `
    <button class="overflow-item ${item.class || ''}" data-overflow-idx="${i}"
      ${item.disabled ? 'disabled style="opacity:0.4;pointer-events:none"' : ''}>
      ${item.icon || ''} ${item.label}
    </button>
  `).join('');

  return `
    <div class="overflow-menu" data-menu-open="false" data-overflow-id="${id}">
      <button class="btn btn-ghost btn-sm overflow-trigger ${triggerClass}" title="More actions">\u22EE</button>
      <div class="overflow-dropdown" data-overflow-owner="${id}">
        ${btns}
      </div>
    </div>
  `;
}

export function positionOverflowDropdown(trigger, dropdown, viewport = window) {
  if (!trigger || !dropdown) return 'down';
  const padding = 8;
  const gap = 4;
  if (document.body?.appendChild && dropdown.parentElement !== document.body) document.body.appendChild(dropdown);
  dropdown.style.position = 'fixed';
  dropdown.style.visibility = 'hidden';
  dropdown.style.display = 'block';

  const triggerRect = trigger.getBoundingClientRect();
  const dropdownRect = dropdown.getBoundingClientRect();
  const openUp = triggerRect.bottom + dropdownRect.height > (viewport.innerHeight - padding)
    && triggerRect.top - dropdownRect.height >= padding;
  const top = openUp
    ? Math.max(padding, triggerRect.top - dropdownRect.height - gap)
    : Math.min(viewport.innerHeight - dropdownRect.height - padding, triggerRect.bottom + gap);
  const left = Math.min(
    viewport.innerWidth - dropdownRect.width - padding,
    Math.max(padding, triggerRect.right - dropdownRect.width)
  );

  dropdown.style.top = `${top}px`;
  dropdown.style.left = `${left}px`;
  dropdown.style.right = 'auto';
  dropdown.style.visibility = 'visible';
  dropdown.dataset.placement = openUp ? 'up' : 'down';
  return dropdown.dataset.placement;
}

function hideOverflowDropdown(menu) {
  if (!menu) return;
  menu.dataset.menuOpen = 'false';
  const id = menu.dataset.overflowId;
  const dropdown = menu.querySelector('.overflow-dropdown')
    || document.querySelector(`.overflow-dropdown[data-overflow-owner="${id}"]`);
  if (!dropdown) return;
  dropdown.style.display = 'none';
  dropdown.style.position = '';
  dropdown.style.top = '';
  dropdown.style.left = '';
  dropdown.style.right = '';
  dropdown.style.visibility = '';
  delete dropdown.dataset.placement;
}

function closeOverflowMenus(exceptMenu = null) {
  document.querySelectorAll('.overflow-menu').forEach((menu) => {
    if (menu === exceptMenu) return;
    hideOverflowDropdown(menu);
  });
}

function removeDetachedOverflowDropdowns() {
  document.querySelectorAll('.overflow-dropdown[data-overflow-owner]').forEach((dropdown) => {
    const owner = dropdown.dataset.overflowOwner;
    if (dropdown.parentElement === document.body || !document.querySelector(`.overflow-menu[data-overflow-id="${owner}"]`)) {
      dropdown.remove();
    }
  });
}

function attachOverflowListeners(container) {
  container.querySelectorAll('.overflow-menu').forEach(menu => {
    const trigger = menu.querySelector('.overflow-trigger');
    const dropdown = menu.querySelector('.overflow-dropdown');
    const id = menu.dataset.overflowId;
    const items = overflowRegistry.get(id) || [];

    trigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = menu.dataset.menuOpen === 'true';
      closeOverflowMenus(menu);
      if (!isOpen) {
        menu.dataset.menuOpen = 'true';
        positionOverflowDropdown(trigger, dropdown);
      } else {
        hideOverflowDropdown(menu);
      }
    });

    dropdown?.querySelectorAll('.overflow-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(item.dataset.overflowIdx, 10);
        const cfg = items[idx];
        if (cfg?.onClick) {
          try { cfg.onClick(e); } catch (err) { console.error('overflow click failed', err); }
        }
        hideOverflowDropdown(menu);
      });
    });
  });

  // Close menus on outside click
  document.addEventListener('click', () => {
    closeOverflowMenus();
  });
}

export async function render(container) {
  ensureLiveRefresh(container);
  container.innerHTML = `
    <div class="pipeline-shell">
      <header class="pipeline-header">
        <div>
          <h1 class="section-title">Pipeline</h1>
          <p class="section-sub">Manage your active opportunities and AI-driven match insights.</p>
        </div>
        <div class="pipeline-header-stats">
          <div class="skeleton" style="width:142px;height:50px;border-radius:var(--radius-md)"></div>
          <div class="skeleton" style="width:118px;height:50px;border-radius:var(--radius-md)"></div>
        </div>
      </header>
      <div class="glass-card">
        <div class="skeleton" style="height:28px;border-radius:9999px;margin-bottom:12px"></div>
        <div class="skeleton" style="height:38px;border-radius:var(--radius-md)"></div>
      </div>
      <div class="pipeline-table-shell">
        <div class="skeleton" style="height:48px"></div>
        <div class="skeleton" style="height:80px;margin:1px 0"></div>
        <div class="skeleton" style="height:80px"></div>
      </div>
    </div>
  `;

  await loadData();
  await syncScanRunState(container, { refreshOnFinish: false });

  update(container);
  refreshPendingPostings(container, { source: 'load' }).catch(() => {});
}

function update(container) {
  closeOverflowMenus();
  removeDetachedOverflowDropdowns();
  const isPending = currentFilter === 'pending';
  // Build the full filtered + sorted list, then slice into the active page.
  // Pending uses a different data source (renderPending pulls from `pending`
  // directly), so it manages its own pagination below.
  const fullItems = isPending ? [] : sorted(filtered());
  const fullPending = isPending
    ? pending
        .filter(p => pendingPassesScoreFilters(p, {
          topOnly: showTopMatchOnly,
          minScore: minPendingScore,
        }))
        .filter(matchesSearch)
        .filter(matchesPendingFilter)
    : [];
  const totalRows = isPending ? fullPending.length : fullItems.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
  if (currentPage > pageCount) currentPage = pageCount;
  const sliceStart = (currentPage - 1) * pageSize;
  const sliceEnd = Math.min(sliceStart + pageSize, totalRows);
  const items = isPending ? [] : fullItems.slice(sliceStart, sliceEnd);
  const pendingPage = isPending ? fullPending.slice(sliceStart, sliceEnd) : [];
  const activeOffers = apps.filter(a =>
    ['evaluated', 'applied', 'responded', 'interview', 'offer'].includes(a.statusNormalized)
  ).length;
  const pendingCount = pending.length;
  const totalCount = apps.length + pending.length;

  const scanBanner = renderScanProgress(scanProgress);
  const pendingRefreshBanner = renderScanProgress(pendingRefreshProgressFromState(pendingRefreshState));

  const showRange = totalRows === 0
    ? '0 of 0'
    : `${sliceStart + 1}–${sliceEnd} of ${totalRows}`;
  const pageOptions = [5, 10, 25, 50, 100]
    .map(n => `<option value="${n}"${n === pageSize ? ' selected' : ''}>${n}</option>`)
    .join('');

  const tableInner = `
    <div class="pipeline-table-shell">
      ${isPending ? renderPending(pendingPage) : renderTable(items)}
      <div class="pipeline-table-footer">
        <div class="pipeline-pagesize">
          <label for="pipeline-pagesize">Per page</label>
          <select id="pipeline-pagesize" class="pagesize-select">${pageOptions}</select>
        </div>
        <span class="pipeline-table-range">Showing ${showRange} results</span>
        <span class="pagination">
          <button class="btn-icon is-sm" type="button" id="page-prev" ${currentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">
            <svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 1.5L1.5 6L6 10.5"/></svg>
          </button>
          <span class="pagination-status">Page ${currentPage} / ${pageCount}</span>
          <button class="btn-icon is-sm" type="button" id="page-next" ${currentPage >= pageCount ? 'disabled' : ''} aria-label="Next page">
            <svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 1.5L6.5 6L2 10.5"/></svg>
          </button>
        </span>
      </div>
    </div>
  `;

  container.innerHTML = `
    <div class="pipeline-shell">
      <header class="section-header no-mb">
        <div>
          <h1 class="section-title">Pipeline</h1>
          <p class="section-sub">Manage your active opportunities and AI-driven match insights.</p>
        </div>
        <div class="section-header-actions">
          <div class="stat-pill is-accent">
            <span class="stat-pill-label">Active offers</span>
            <span class="stat-pill-value">${activeOffers}</span>
          </div>
          <div class="stat-pill">
            <span class="stat-pill-label">Pending</span>
            <span class="stat-pill-value">${pendingCount}</span>
          </div>
        </div>
      </header>

      <div class="scan-progress-slot">${scanBanner}</div>
      <div class="scan-progress-slot">${pendingRefreshBanner}</div>

      <section class="pipeline-toolbar${filterPopoverOpen ? ' has-popover' : ''}">
        <div class="pipeline-toolbar-row">
          ${renderFilters()}
          <div class="pipeline-toolbar-end">
            <label class="search-input">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="6" cy="6" r="4.5"/><line x1="9.5" y1="9.5" x2="13" y2="13"/></svg>
              <input type="text" id="pipeline-search" placeholder="Search company or role..." value="${esc(searchQuery)}">
            </label>
            ${renderFilterButton()}
          </div>
        </div>
        ${filterPopoverOpen ? renderFilterPopover() : ''}
        <div class="pipeline-toolbar-divider">
          <label class="toggle-row">
            <input type="checkbox" id="top-match-toggle" ${showTopMatchOnly ? 'checked' : ''}>
            <span>Top matches only (4+)</span>
          </label>
          ${isPending ? `
            <label class="discover-score-slider pipeline-score-slider">
              <span>Min score: <strong id="pipeline-min-label">${minPendingScore.toFixed(1)}</strong></span>
              <input type="range" min="0" max="5" step="0.5" value="${minPendingScore}" id="pipeline-min-input" />
            </label>
          ` : ''}
          <div style="display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap">
            ${isPending ? `<button class="btn btn-sm btn-outline" id="pending-rescore-btn" type="button"${contextualScoringActive ? ' disabled' : ''}>Rescore LLM</button>` : ''}
            <button class="btn btn-sm btn-primary" id="add-job-btn" type="button">Add Job</button>
            <button class="btn-icon" id="refresh-btn" title="${isPending && pending.length > 0 ? 'Refresh + verify each pending posting is still live' : 'Refresh'}"${scanProgress?.visible || pendingRefreshState?.active ? ' disabled' : ''}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 6a4.5 4.5 0 1 1-1.3-3.18"/><polyline points="11.5 1 11.5 4 8.5 4"/></svg>
            </button>
          </div>
        </div>
      </section>

      ${tableInner}

      ${renderInsightCards()}

      <span hidden>${totalCount}</span>
    </div>
  `;


  // Filter tab clicks
  container.querySelectorAll('.filter-tab').forEach(btn => {
    btn.onclick = () => {
      currentFilter = btn.dataset.filter;
      selectedApps.clear();
      currentPage = 1;
      update(container);
    };
  });

  // Page-size dropdown + prev/next pagination
  const pageSizeSel = container.querySelector('#pipeline-pagesize');
  if (pageSizeSel) {
    pageSizeSel.onchange = () => {
      const next = parseInt(pageSizeSel.value, 10);
      if ([5, 10, 25, 50, 100].includes(next)) {
        pageSize = next;
        currentPage = 1;
        try { localStorage.setItem('catabull-pipeline-pagesize', String(next)); } catch {}
        update(container);
      }
    };
  }
  container.querySelector('#page-prev')?.addEventListener('click', () => {
    if (currentPage > 1) { currentPage -= 1; update(container); }
  });
  container.querySelector('#page-next')?.addEventListener('click', () => {
    currentPage += 1; update(container);
  });

  // Sort clicks
  container.querySelectorAll('[data-sort]').forEach(th => {
    th.onclick = () => {
      if (sortCol === th.dataset.sort) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortCol = th.dataset.sort; sortDir = 'desc'; }
      update(container);
    };
  });

  // Row expand
  container.querySelectorAll('tr[data-num]').forEach(tr => {
    tr.onclick = (e) => {
      if (e.target.closest('a,button,select,input,label,textarea')) return;
      const num = parseInt(tr.dataset.num);
      expandedRow = expandedRow === num ? null : num;
      update(container);
    };
  });

  // Single status button (stage-specific row actions)
  container.querySelectorAll('.app-status-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const num = btn.dataset.num;
      const status = btn.dataset.status;
      const app = apps.find(a => String(a.num) === num);
      const previousStatus = app?.status || 'Evaluated';
      try {
        await api.updateApplication(num, status);
        pushUndo({
          label: `marked as ${status}`,
          item: app ? `${app.company} - ${app.role}` : `#${num}`,
          undo: async () => {
            await api.updateApplication(num, previousStatus);
            render(container);
          },
        });
        toast(`Marked as ${status}`);
        selectedApps.delete(parseInt(num));
        render(container);
      } catch { toast('Failed to update', 'error'); }
    };
  });

  // App checkboxes
  const selectAllApps = container.querySelector('#select-all-apps');
  if (selectAllApps) {
    selectAllApps.onchange = () => {
      if (selectAllApps.checked) items.forEach(a => selectedApps.add(a.num));
      else selectedApps.clear();
      update(container);
    };
  }
  container.querySelectorAll('.app-check').forEach(cb => {
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = (e) => {
      e.stopPropagation();
      const num = parseInt(cb.dataset.num);
      if (cb.checked) selectedApps.add(num);
      else selectedApps.delete(num);
      update(container);
    };
  });

  // App batch actions
  container.querySelectorAll('.app-batch-btn').forEach(btn => {
    btn.onclick = async () => {
      const nums = [...selectedApps];
      const status = btn.dataset.status;
      for (const num of nums) {
        try { await api.updateApplication(num, status); } catch {}
      }
      selectedApps.clear();
      toast(`${nums.length} job${nums.length !== 1 ? 's' : ''} marked as ${status}`);
      render(container);
    };
  });
  container.querySelector('#app-batch-clear')?.addEventListener('click', () => {
    selectedApps.clear();
    update(container);
  });

  // View report
  container.querySelectorAll('.view-report-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      window.location.hash = '#/analytics';
    };
  });

  // Score-rationale modal — opens when a row's score ring is clicked.
  // Two flavors: evaluated apps look up by num, pending look up by url.
  container.querySelectorAll('.score-trigger').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const kind = btn.dataset.scoreKind;
      if (kind === 'pending') {
        const item = pending.find(p => p.url === btn.dataset.scoreUrl);
        if (item) openScoreModal(item, { kind: 'pending' });
      } else {
        const num = parseInt(btn.dataset.scoreNum, 10);
        const item = apps.find(a => a.num === num);
        if (item) openScoreModal(item, { kind: 'evaluated' });
      }
    };
  });

  // Top match filter toggle
  container.querySelector('#top-match-toggle')?.addEventListener('change', (e) => {
    showTopMatchOnly = e.target.checked;
    selected.clear();
    currentPage = 1;
    update(container);
  });

  container.querySelector('#pipeline-min-input')?.addEventListener('input', (e) => {
    minPendingScore = Number.parseFloat(e.target.value);
    const label = container.querySelector('#pipeline-min-label');
    if (label) label.textContent = minPendingScore.toFixed(1);
  });
  container.querySelector('#pipeline-min-input')?.addEventListener('change', (e) => {
    minPendingScore = Number.parseFloat(e.target.value);
    selected.clear();
    currentPage = 1;
    update(container);
  });

  container.querySelector('#pending-rescore-btn')?.addEventListener('click', async () => {
    try {
      await startContextualScoring(container, { force: true });
    } catch {}
  });

  // Checkboxes
  const selectAll = container.querySelector('#select-all');
  if (selectAll) {
    selectAll.onchange = () => {
      if (selectAll.checked) pending.forEach(p => selected.add(p.url));
      else selected.clear();
      update(container);
    };
  }
  container.querySelectorAll('.pending-check').forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) selected.add(cb.dataset.url);
      else selected.delete(cb.dataset.url);
      update(container);
    };
  });

  // Batch actions
  container.querySelector('#batch-skip-btn')?.addEventListener('click', async () => {
    const urls = [...selected];
    for (const url of urls) { try { await api.skipPending(url); } catch {} }
    selected.clear();
    toast(`Skipped ${urls.length} job${urls.length !== 1 ? 's' : ''}`);
    render(container);
  });
  container.querySelector('#batch-apply-btn')?.addEventListener('click', async () => {
    const items = pending.filter(p => selected.has(p.url));
    for (const item of items) { try { await api.applyPending(item.url, item.company, item.role); } catch {} }
    selected.clear();
    toast(`Marked ${items.length} job${items.length !== 1 ? 's' : ''} as Applied`);
    render(container);
  });
  container.querySelector('#batch-tailor-btn')?.addEventListener('click', async () => {
    const items = pending.filter(p => selected.has(p.url));
    const count = items.length;
    const urls = items.map(p => p.url);
    const dupes = items.filter(p => isAlreadyEvaluated(p.company, p.role));

    const dupeWarning = dupes.length > 0 ? `
      <p style="font-size:13px;color:var(--yellow);margin-bottom:12px">\u26A0 ${dupes.length} of these offer${dupes.length !== 1 ? 's have' : ' has'} already been tailored: ${dupes.map(d => `<strong>${esc(d.company)}</strong>`).join(', ')}</p>
    ` : '';

    const ok = await confirmModal({
      title: `Tailor ${count} Job${count !== 1 ? 's' : ''}?`,
      body: `
        <p style="font-size:14px;color:var(--subtext);margin-bottom:12px">This will score each role and draft a tailored CV when the fit is strong. Depending on the number of jobs, this could:</p>
        <ul style="font-size:13px;color:var(--text);margin:0 0 12px 20px;line-height:1.8">
          <li>Use significant API credits (each tailoring pass is a full agent session)</li>
          <li>Take several minutes per job</li>
          <li>Total estimated time: <strong>${count * 2}\u2013${count * 5} minutes</strong></li>
        </ul>
        ${dupeWarning}
        <p style="font-size:13px;color:var(--subtext)">This will start batch mode in the terminal with the selected URLs attached.</p>
      `,
    });
    if (!ok) return;
    await runModePrompt('batch', { text: urls.join('\n') });
  });

  container.querySelector('#batch-delete-btn')?.addEventListener('click', async () => {
    const urls = [...selected];
    if (!urls.length) return;
    const ok = await confirmModal({
      title: `Delete ${urls.length} pending job${urls.length !== 1 ? 's' : ''}?`,
      body: `<p style="font-size:14px;color:var(--subtext);margin-bottom:8px">This permanently removes the selected entr${urls.length !== 1 ? 'ies' : 'y'} from your pending pipeline.</p><p style="font-size:13px;color:var(--subtext0)">This cannot be undone. Use <strong>Skip</strong> instead if you might want to revisit later.</p>`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await api.deletePending(urls);
      selected.clear();
      toast(`Deleted ${result.removed} pending job${result.removed !== 1 ? 's' : ''}`);
      render(container);
    } catch (err) {
      toast(`Failed to delete: ${err.message}`, 'error');
    }
  });

  container.querySelector('#batch-clear-btn')?.addEventListener('click', () => {
    selected.clear();
    update(container);
  });

  container.querySelectorAll('.pending-deep-btn').forEach(btn => {
    btn.onclick = () => runModePrompt('deep', {
      company: btn.dataset.company,
      role: btn.dataset.role,
      url: btn.dataset.url,
    });
  });

  // Outreach (works for both pending and evaluated items)
  container.querySelectorAll('.pending-outreach-btn').forEach(btn => {
    btn.onclick = () => runModePrompt('outreach', {
      company: btn.dataset.company,
      role: btn.dataset.role,
      url: btn.dataset.url,
    });
  });

  // Single: Skip
  container.querySelectorAll('.pending-skip-btn').forEach(btn => {
    btn.onclick = async () => {
      const url = btn.dataset.url;
      const company = btn.dataset.company;
      try {
        await api.skipPending(url);
        selected.delete(url);
        pushUndo({
          label: 'skipped',
          item: company,
          undo: async () => {
            try { await api.unskipPending(url); } catch {}
            render(container);
          },
        });
        render(container);
      } catch { toast('Failed to skip', 'error'); }
    };
  });

  // Single: Tailor (replaces the old Evaluate flow). Same backing mode for
  // now; tailoring also drafts a CV downstream when the score is strong.
  container.querySelectorAll('.pending-tailor-btn').forEach(btn => {
    btn.onclick = async () => {
      const pendingItem = {
        url: btn.dataset.url,
        company: btn.dataset.company,
        role: btn.dataset.role,
      };
      const scorePendingItem = async () => {
        const current = pending.find((item) => item.url === pendingItem.url) || pendingItem;
        if (current.contextualScoreSource === 'llm' || !contextualScoringEnabled()) return current;
        await startContextualScoring(container, { urls: [pendingItem.url] });
        return pending.find((item) => item.url === pendingItem.url) || current;
      };

      const doTailor = async () => {
        const scoredItem = await scorePendingItem();
        const decision = pendingTailorDecision(scoredItem);
        if (decision.shouldWarn) {
          const okLowScore = await confirmModal({
            title: 'Low-fit tailor?',
            confirmText: 'Tailor anyway',
            body: `<p style="font-size:14px;color:var(--subtext);margin-bottom:10px"><strong style="color:var(--text)">${esc(scoredItem.company)} - ${esc(scoredItem.role)}</strong> is only scoring <strong style="color:var(--yellow)">${Number.isFinite(decision.score) ? decision.score.toFixed(1) : 'n/a'}/5</strong>.</p><p style="font-size:13px;color:var(--subtext0)">This usually means weak fit. Tailoring now may burn time and credits before the role is worth pursuing.</p>`,
          });
          if (!okLowScore) return;
        }
        btn.disabled = true;
        try {
          const result = await api.tailor(scoredItem);
          toast(`Tailor bundle ready for ${scoredItem.company}`);
          if (result?.paths?.cv) window.open(api.tailorFileUrl(result.paths.cv), '_blank', 'noopener');
        } catch (err) {
          toast(`Tailor failed: ${err.message}`, 'error');
        } finally {
          btn.disabled = false;
        }
      };

      if (isAlreadyEvaluated(btn.dataset.company, btn.dataset.role)) {
        const ok = await confirmModal({
          title: 'Already Tailored',
          body: `<p style="font-size:14px;color:var(--subtext)">A tailored report already exists for <strong style="color:var(--text)">${esc(btn.dataset.company)} - ${esc(btn.dataset.role)}</strong>. Re-running will use additional API credits.</p>`,
        });
        if (ok) await doTailor();
      } else {
        await doTailor();
      }
    };
  });

  container.querySelectorAll('.app-pdf-btn').forEach(btn => {
    btn.onclick = () => runModePrompt('pdf', {
      url: btn.dataset.url,
      company: btn.dataset.company,
      role: btn.dataset.role,
    });
  });

  container.querySelectorAll('.app-apply-mode-btn').forEach(btn => {
    btn.onclick = () => runModePrompt('apply', {
      url: btn.dataset.url,
      company: btn.dataset.company,
      role: btn.dataset.role,
    });
  });

  container.querySelectorAll('.app-prep-btn').forEach(btn => {
    btn.onclick = () => runModePrompt('interview-prep', {
      company: btn.dataset.company,
      role: btn.dataset.role,
      url: btn.dataset.url,
    });
  });

  // Single: Mark Applied
  container.querySelectorAll('.pending-apply-btn').forEach(btn => {
    btn.onclick = async () => {
      try {
        await api.applyPending(btn.dataset.url, btn.dataset.company, btn.dataset.role);
        selected.delete(btn.dataset.url);
        toast(`${btn.dataset.company} marked as Applied`);
        render(container);
      } catch { toast('Failed to update', 'error'); }
    };
  });

  // Unskip (restore to pending)
  container.querySelectorAll('.unskip-btn').forEach(btn => {
    btn.onclick = async () => {
      try {
        await api.unskipPending(btn.dataset.url);
        toast('Restored to pending');
        render(container);
      } catch { toast('Failed to restore', 'error'); }
    };
  });


  // Search input — preserveFocus keeps the cursor in the input across the
  // re-render the update() call triggers (otherwise typing more than once
  // de-focuses after the first keystroke).
  const searchInput = container.querySelector('#pipeline-search');
  if (searchInput) {
    let debounceTimer;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        searchQuery = e.target.value.trim();
        currentPage = 1;
        preserveFocus(container, () => update(container));
      }, 200);
    });
  }

  bindFilterPopover(container);

  // Attach overflow menu listeners
  attachOverflowListeners(container);

  const refreshBtn = container.querySelector('#refresh-btn');
  if (refreshBtn) refreshBtn.onclick = async () => {
    setScanProgress({ visible: false });
    refreshBtn.disabled = true;
    try {
      await refreshPendingPostings(container, { force: true, source: 'manual' });
      await refreshData(container);
      await syncScanRunState(container, { refreshOnFinish: false });
    } finally {
      if (refreshBtn.isConnected) refreshBtn.disabled = false;
    }
  };

  // Add Entry insight card → modal that captures a URL plus optional manual
  // company/role overrides and appends a new pending row to data/pipeline.md.
  // If the user only pastes a job URL, the server tries to auto-fill company,
  // role, and location from job-page metadata before writing the row.
  const addJob = async () => {
    const result = await confirmModal({
      title: 'Add a job to your pipeline',
      confirmText: 'Add to pipeline',
      body: `
        <p style="font-size:13px;color:var(--subtext);margin-bottom:14px">Paste the posting link. Company and role can be filled manually, or left blank if the page exposes them cleanly for auto-fill.</p>
        <div class="form-group"><label class="form-label">Job URL</label><input class="form-input" data-return="url" type="url" placeholder="https://company.com/jobs/123" autocomplete="off" autofocus></div>
        <div class="form-group"><label class="form-label">Company <span style="color:var(--subtext);font-weight:400">(optional if auto-fill works)</span></label><input class="form-input" data-return="company" type="text" placeholder="Acme Corp" autocomplete="off"></div>
        <div class="form-group"><label class="form-label">Role <span style="color:var(--subtext);font-weight:400">(optional if auto-fill works)</span></label><input class="form-input" data-return="role" type="text" placeholder="Senior Designer" autocomplete="off"></div>
      `,
    });
    if (!result || !result.data) return;
    const { url = '', company = '', role = '' } = result.data;
    const cleanUrl = url.trim();
    const cleanCompany = company.trim();
    const cleanRole = role.trim();
    if (!cleanUrl) {
      toast('Job URL is required.', 'error');
      return;
    }
    try {
      const added = await api.addPending({
        url: cleanUrl,
        company: cleanCompany,
        role: cleanRole,
        postedAt: new Date().toISOString().slice(0, 10),
      });
      toast(`Added ${(added.company || cleanCompany || 'job')} to pending`);
      currentFilter = 'pending';
      currentPage = 1;
      await loadData();
      update(container);
      startContextualScoring(container, { urls: [added.url || cleanUrl] }).catch(() => {});
    } catch (err) {
      const msg = err.message?.includes('409')
        ? 'That URL is already in your pipeline.'
        : err.message?.includes('400')
          ? 'Could not infer company/role from that link. Add them manually and try again.'
          : `Failed to add: ${err.message}`;
      toast(msg, 'error');
    }
  };
  container.querySelectorAll('#add-job-btn, #add-entry-btn').forEach((btn) => {
    btn.onclick = addJob;
  });

  // Insight-card CTA: open the most actionable weak application directly in
  // the score breakdown instead of just expanding a row with no next step.
  const optimizeBtn = container.querySelector('#insight-optimize-btn');
  if (optimizeBtn) {
    optimizeBtn.onclick = () => {
      const suggestion = buildAiSuggestion(apps);
      const target = suggestion.targetNum != null
        ? apps.find(a => a.num === suggestion.targetNum)
        : null;
      if (!target) {
        toast('No active applications to optimize yet.');
        return;
      }
      currentFilter = suggestion.targetFilter || target.statusNormalized || 'applied';
      expandedRow = target.num;
      update(container);
      if (suggestion.openScoreModal) openScoreModal(target, { kind: 'evaluated' });
    };
  }
}

// Keyboard shortcuts for pipeline
export function initKeyboard(container) {
  document.addEventListener('keydown', (e) => {
    // Ctrl+R or Cmd+R: refresh pipeline
    if ((e.ctrlKey || e.metaKey) && e.key === 'r' && !e.target.closest('input, textarea, select')) {
      e.preventDefault();
      render(container);
    }
    // Arrow key navigation in tables (when focused on a row)
    if (e.key === 'ArrowDown' && e.target.closest('.data-table') && !e.target.closest('input, button, a')) {
      const current = document.activeElement;
      const nextRow = current?.closest('tr')?.nextElementSibling;
      if (nextRow) {
        const focusable = nextRow.querySelector('td:not(:has(button, a, input))');
        if (focusable) focusable.focus();
      }
    }
    if (e.key === 'ArrowUp' && e.target.closest('.data-table') && !e.target.closest('input, button, a')) {
      const current = document.activeElement;
      const prevRow = current?.closest('tr')?.previousElementSibling;
      if (prevRow) {
        const focusable = prevRow.querySelector('td:not(:has(button, a, input))');
        if (focusable) focusable.focus();
      }
    }
  });
}
