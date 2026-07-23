/**
 * views/discover.mjs — Discover tab (PR 1.3).
 *
 * Aggregated card-style view of pending postings across portals.yml,
 * sorted by fit score with the rationale surfaced inline (not just in a
 * tooltip the way Pipeline shows it).
 *
 * The post-onboarding experience: fresh user lands here and sees real
 * roles to act on, not a config screen.
 *
 * Data: reuses /applications (which already returns pending items
 * enriched with relevance + factors). Card actions reuse the existing
 * pipeline routes (skip / apply) so the data contract stays consistent
 * across views.
 */

import { api } from '../api.mjs';
import { deepProgressFromEvent, pendingRefreshProgressFromState, quickProgressFromEvent, renderScanProgress } from '../components/scan-progress.mjs';
import { toast } from '../components/toast.mjs';
import { confirmModal } from '../components/confirm.mjs';
import { openScoreModal } from '../components/score-modal.mjs';
import { promptLowTailorScoreAction, promptTailorAction } from '../components/tailor-choice.mjs';
import { notifyScanComplete, requestPermission } from '../components/notifications.mjs';
import { runModePrompt } from '../lib/modes.mjs';
import { preserveFocus } from '../lib/focus.mjs';
import { DEFAULT_PENDING_REFRESH_INTERVAL_MS, getPendingRefreshState, runPendingRefresh, subscribePendingRefresh } from '../lib/pending-refresh.mjs';
import {
  applyContextualScoreResults,
  contextualScoringEnabled,
  mergePendingContextualState,
  resetPendingToHeuristicScores,
  setContextualScoringEnabled,
} from '../lib/pending-contextual-scoring.mjs';
import {
  buildDiscoverFilter,
  groupPostingsByCompany,
  sortByRelevance,
  collectIndustries,
} from '../lib/discover-grouping.mjs';

// Cached state — refreshed on render or when actions mutate.
let pending = [];
let portals = null;
let scanStatus = null;
let scanProgress = { visible: false };
let minScore = 2.5;     // default threshold; matches the scan relevance default
let industryFilter = new Set();   // empty = no filter
let companyFilter = '';          // free-text
let searchQuery = '';
let groupBy = 'flat';            // 'company' | 'flat' — flat by default per UX 2026-05-16
let activeContainer = null;
let pendingRefreshPoller = null;
let pendingRefreshState = getPendingRefreshState();
let contextualScoringRun = 0;
let contextualScoringActive = false;
let contextualScoringError = '';

// Scan controls moved here from the Portals page (2026-05-16). The
// `catabull-scan-limit` localStorage key stays shared with portals.mjs
// so the per-company Scan button there honors the same cap.
const SCAN_LIMIT_KEY = 'catabull-scan-limit';
const SCAN_LIMIT_OPTIONS = [
  { value: '5', label: '5' },
  { value: '10', label: '10' },
  { value: '25', label: '25' },
  { value: '50', label: '50' },
  { value: '100', label: '100' },
  { value: '0', label: 'All' },
];

function isContainerActive(container) {
  return Boolean(container?.isConnected && container.classList.contains('active'));
}

function rerenderIfActive(container) {
  if (!isContainerActive(container)) return;
  rerender(container);
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
      rerender: async () => rerenderIfActive(container),
    });
    if (manual) {
      if (result?.error) toast(`Liveness check failed: ${result.error}`, 'error');
      else if (result?.checked) toast(`Checked ${result.checked} jobs — ${result.expired} expired`);
      else rerenderIfActive(container);
    } else if (result?.error) {
      toast(`Auto-refresh failed: ${result.error}`, 'error');
    } else if (result?.expired) {
      toast(`Auto-refresh expired ${result.expired} posting${result.expired === 1 ? '' : 's'}`);
    } else if (result?.checked) {
      rerenderIfActive(container);
    }
    return result;
  } catch (err) {
    const message = manual ? `Liveness check failed: ${err.message}` : `Auto-refresh failed: ${err.message}`;
    toast(message, 'error');
    throw err;
  }
}

function ensurePendingRefresh(container) {
  activeContainer = container;
  if (!pendingRefreshPoller) {
    pendingRefreshPoller = setInterval(() => {
      if (!isContainerActive(activeContainer)) return;
      refreshPendingPostings(activeContainer, { source: 'auto' }).catch(() => {});
    }, DEFAULT_PENDING_REFRESH_INTERVAL_MS);
  }
  if (!window.__catabullDiscoverRefreshBound) {
    window.__catabullDiscoverRefreshBound = true;
    subscribePendingRefresh((state) => {
      pendingRefreshState = state;
      rerenderIfActive(activeContainer);
    });
    window.addEventListener('catabull:data-maybe-changed', () => {
      if (!isContainerActive(activeContainer)) return;
      loadData().then(() => rerenderIfActive(activeContainer)).catch(() => {});
      refreshPendingPostings(activeContainer, { source: 'auto' }).catch(() => {});
    });
  }
}

function timeAgo(dateStr, future = false) {
  const diff = future ? new Date(dateStr) - Date.now() : Date.now() - new Date(dateStr);
  const abs = Math.abs(diff);
  if (abs < 60000) return future ? 'in less than a minute' : 'just now';
  if (abs < 3600000) { const m = Math.floor(abs / 60000); return future ? `in ${m}m` : `${m}m ago`; }
  if (abs < 86400000) { const h = Math.floor(abs / 3600000); return future ? `in ${h}h` : `${h}h ago`; }
  const d = Math.floor(abs / 86400000);
  return future ? `in ${d}d` : `${d}d ago`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scoreValue(p) {
  if (Number.isFinite(p?.contextualScore)) return p.contextualScore;
  return Number.isFinite(p?.relevance) ? p.relevance : 0;
}

function normalizeTitleFilter(filter = {}) {
  const unique = (items) => [...new Set((Array.isArray(items) ? items : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
  return {
    positive: unique(filter.positive),
    negative: unique(filter.negative),
  };
}

function setScanProgress(progress) {
  scanProgress = progress || { visible: false };
}

function updateScanProgressSlot(container) {
  const slot = container.querySelector('.scan-progress-slot');
  if (slot) slot.innerHTML = renderScanProgress(scanProgress);
}

function scoreClass(score) {
  if (score >= 4.5) return 'excellent';
  if (score >= 4.0) return 'good';
  if (score >= 3.5) return 'decent';
  if (score >= 3.0) return 'low';
  return 'poor';
}

// Same circular score ring used in the Pipeline table, kept in sync with
// pipeline.mjs:renderScoreRing so both views feel the same at a glance.
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

// Build a one-line description from the heuristic match factors. Falls back
// to the canned rationale when factors aren't available so an early-onboarded
// user still sees something useful. Factor labels from lib/relevance.mjs are
// already self-describing (e.g. "Matches target role 'staff engineer'") so
// we join them as-is instead of prepending extra words.
function describeMatch(p) {
  if (p.contextualScoring) return 'Contextual match scoring in progress...';
  if (p.contextualRationale) return p.contextualRationale;
  const factors = Array.isArray(p.relevanceFactors) ? p.relevanceFactors : [];
  if (factors.length === 0) {
    return p.relevanceRationale || 'Heuristic match preview — run a full evaluation to see the A–E breakdown.';
  }
  const positives = factors.filter((f) => Number(f.delta) > 0).slice(0, 2).map((f) => f.label);
  const negatives = factors.filter((f) => Number(f.delta) < 0).slice(0, 1).map((f) => f.label);
  const parts = [...positives, ...negatives];
  return parts.length ? parts.join(' · ') : (p.relevanceRationale || 'Heuristic match preview.');
}

// Map a posting's company name → its portals.yml entry (for industries).
function portalCompany(name) {
  if (!portals?.tracked_companies) return null;
  const lower = String(name || '').trim().toLowerCase();
  return portals.tracked_companies.find((c) => String(c.name || '').toLowerCase() === lower) || null;
}

function postingIndustries(p) {
  const company = portalCompany(p.company);
  return Array.isArray(company?.industries) ? company.industries : [];
}

function applyFilters(items) {
  const predicate = buildDiscoverFilter({
    minScore,
    industries: industryFilter,
    company: companyFilter,
    search: searchQuery,
    resolveIndustries: postingIndustries,
  });
  return items.filter(predicate);
}

function uniqueIndustries() {
  return collectIndustries(portals?.tracked_companies);
}

function renderScanSchedule() {
  if (!scanStatus) return '';
  const savedLimit = localStorage.getItem(SCAN_LIMIT_KEY) || '0';
  const busy = scanStatus.running || scanProgress?.visible || pendingRefreshState?.active;
  const titleFilter = normalizeTitleFilter(portals?.title_filter);
  const keywordCount = titleFilter.positive.length + titleFilter.negative.length;

  let lastScanBadge = '';
  if (scanStatus.lastScanAt) {
    const r = scanStatus.lastScanResult;
    const resultText = r
      ? (r.success
          ? `${r.newOffers} new offer${r.newOffers !== 1 ? 's' : ''}`
          : 'failed')
      : '';
    const tone = r ? (r.success ? 'var(--green)' : 'var(--red)') : 'var(--subtext)';
    lastScanBadge = `<span class="scan-card-last" style="color:${tone}" title="Last scan ${esc(scanStatus.lastScanAt)}">${timeAgo(scanStatus.lastScanAt)}${resultText ? ` · ${resultText}` : ''}</span>`;
  } else {
    lastScanBadge = '<span class="scan-card-last">never</span>';
  }

  return `
    <div class="scan-card">
      <div class="scan-card-left">
        <button class="btn btn-sm btn-soft" id="search-keywords-btn" type="button" title="Edit keywords used to score and filter search results">
          Search Keywords${keywordCount ? ` (${keywordCount})` : ''}
        </button>
        <input class="form-input discover-search scan-card-search" id="discover-search" placeholder="Search company or role..." value="${esc(searchQuery)}" />
        <label class="discover-context-toggle scan-card-context-toggle" title="Use your configured agent to rescore pending roles against profile and archetypes after scans finish">
          <span class="toggle">
            <input type="checkbox" id="contextual-scoring-toggle" ${contextualScoringEnabled() ? 'checked' : ''}>
            <span class="toggle-track"></span>
            <span class="toggle-thumb"></span>
          </span>
          <span class="discover-context-toggle-copy">
            <span>AI Score</span>
            ${contextualScoringActive ? '<span class="discover-context-toggle-state"><span class="spinner"></span> scoring</span>' : ''}
          </span>
        </label>
        <span class="scan-card-last-group">
          <span class="scan-card-label scan-card-last-label">Last</span>
          ${lastScanBadge}
        </span>
      </div>
      <div class="scan-card-controls">
        <select class="form-select scan-card-select" id="scan-limit-select" ${busy ? 'disabled' : ''} title="Cap on new offers added per scan">
          ${SCAN_LIMIT_OPTIONS.map(o => `<option value="${o.value}"${o.value === savedLimit ? ' selected' : ''}>Max: ${o.label}</option>`).join('')}
        </select>
        <button class="btn btn-sm btn-primary" id="scan-now-btn" ${busy ? 'disabled' : ''} title="ATS-only quick scan. Direct providers only; no branded-page scraping.">
          <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor" aria-hidden="true"><path d="M7.5 0L0 7.5h4L3.5 14 11 6.5H7L7.5 0z"/></svg>
          ${busy ? 'Scanning' : 'Quick Scan'}
        </button>
        <button class="btn btn-sm btn-secondary" id="deep-scan-btn" ${busy ? 'disabled' : ''} title="Quick Scan + WebSearch on job boards + JobSpy aggregator scrape. Several minutes; uses WebSearch quota.">Deep Scan</button>
        <button class="btn-icon" id="discover-refresh-btn" title="Refresh + verify each pending posting is still live" ${busy ? 'disabled' : ''}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 6a4.5 4.5 0 1 1-1.3-3.18"/><polyline points="11.5 1 11.5 4 8.5 4"/></svg>
        </button>
      </div>
    </div>
  `;
}

function renderKeywordGroup(type, label, draft) {
  const items = draft[type] || [];
  return `
    <section class="keyword-modal-section">
      <div class="keyword-modal-section-head">
        <h4>${esc(label)}</h4>
        <button class="btn btn-ghost btn-sm keyword-clear-btn" data-keyword-clear="${type}" ${items.length ? '' : 'disabled'}>Clear</button>
      </div>
      <div class="tag-list keyword-modal-tags">
        ${items.length
          ? items.map((keyword) => `<span class="tag">${esc(keyword)}<span class="tag-remove" data-keyword-type="${type}" data-keyword="${esc(keyword)}">&times;</span></span>`).join('')
          : '<span class="muted" style="font-size:12px">No keywords yet.</span>'}
      </div>
      <div class="keyword-modal-add-row">
        <input class="form-input" id="keyword-${type}-input" placeholder="Add keyword..." autocomplete="off">
        <button class="btn btn-sm" data-keyword-add="${type}" type="button">Add</button>
      </div>
    </section>
  `;
}

function openSearchKeywordsModal(container) {
  if (!portals) return;
  let draft = normalizeTitleFilter(portals.title_filter);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };

  const addKeyword = (type) => {
    const input = overlay.querySelector(`#keyword-${type}-input`);
    const value = input?.value.trim();
    if (!value) return;
    if (!draft[type].includes(value)) draft[type] = [...draft[type], value];
    renderModal();
    overlay.querySelector(`#keyword-${type}-input`)?.focus();
  };

  const removeKeyword = (type, keyword) => {
    draft[type] = draft[type].filter((item) => item !== keyword);
    renderModal();
  };

  const clearKeywords = (type) => {
    draft[type] = [];
    renderModal();
  };

  const save = async () => {
    const saveBtn = overlay.querySelector('#keyword-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    try {
      await api.updateFilters(draft);
      portals.title_filter = normalizeTitleFilter(draft);
      toast('Search keywords saved');
      close();
      rerender(container);
    } catch (error) {
      toast(`Failed to save keywords: ${error.message}`, 'error');
      if (saveBtn) saveBtn.disabled = false;
    }
  };

  function bindModalEvents() {
    overlay.querySelector('#keyword-cancel-btn')?.addEventListener('click', close);
    overlay.querySelector('#keyword-save-btn')?.addEventListener('click', save);
    overlay.querySelectorAll('[data-keyword-add]').forEach((button) => {
      button.addEventListener('click', () => addKeyword(button.dataset.keywordAdd));
    });
    overlay.querySelectorAll('.keyword-modal-add-row input').forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') addKeyword(input.id.includes('positive') ? 'positive' : 'negative');
      });
    });
    overlay.querySelectorAll('[data-keyword-type]').forEach((button) => {
      button.addEventListener('click', () => removeKeyword(button.dataset.keywordType, button.dataset.keyword));
    });
    overlay.querySelectorAll('[data-keyword-clear]').forEach((button) => {
      button.addEventListener('click', () => clearKeywords(button.dataset.keywordClear));
    });
  }

  function renderModal() {
    overlay.innerHTML = `
      <div class="modal search-keywords-modal" role="dialog" aria-modal="true" aria-label="Search keywords">
        <div class="modal-title">Search Keywords</div>
        <p class="keyword-modal-copy">Positive keywords boost role matches. Negative keywords suppress roles you do not want.</p>
        ${renderKeywordGroup('positive', 'Positive Keywords', draft)}
        ${renderKeywordGroup('negative', 'Negative Keywords', draft)}
        <div class="modal-actions">
          <button class="btn" id="keyword-cancel-btn" type="button">Cancel</button>
          <button class="btn btn-primary" id="keyword-save-btn" type="button">Save Keywords</button>
        </div>
      </div>
    `;
    bindModalEvents();
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  renderModal();
  document.body.appendChild(overlay);
  overlay.querySelector('#keyword-positive-input')?.focus();
}

function renderHeader() {
  const totalIfFiltered = applyFilters(pending).length;
  const scoringStatus = contextualScoringEnabled()
    ? (contextualScoringActive
        ? 'Contextual scoring running'
        : contextualScoringError
          ? 'Contextual scoring unavailable'
          : 'Contextual scoring on')
    : 'Heuristic scoring';
  return `
    <header class="section-header">
      <div>
        <h1 class="section-title">Discover</h1>
        <p class="section-sub">Scored roles across your tracked portals and job boards. ${totalIfFiltered} of ${pending.length} pending postings shown. ${scoringStatus}.</p>
      </div>
    </header>
  `;
}

function renderTopBar() {
  const industries = uniqueIndustries();
  const industryChips = industries.map((i) => {
    const active = industryFilter.has(i);
    return `<button class="discover-chip${active ? ' active' : ''}" data-industry="${esc(i)}" type="button">${esc(i)}</button>`;
  }).join('');

  return `
    ${renderHeader()}
    ${renderScanSchedule()}
    <div class="scan-progress-slot">${renderScanProgress(scanProgress)}</div>
    <div class="scan-progress-slot">${renderScanProgress(pendingRefreshProgressFromState(pendingRefreshState))}</div>
    <div class="discover-toolbar">
      <div class="discover-toolbar-row">
        <div class="discover-group-toggle">
          <button class="discover-toggle-btn${groupBy === 'flat' ? ' active' : ''}" data-group="flat" type="button">Flat</button>
          <button class="discover-toggle-btn${groupBy === 'company' ? ' active' : ''}" data-group="company" type="button">By company</button>
        </div>
        <label class="discover-score-slider">
          <span>Min score: <strong id="discover-min-label">${minScore.toFixed(1)}</strong></span>
          <input type="range" min="0" max="5" step="0.5" value="${minScore}" id="discover-min-input" />
        </label>
      </div>
      ${industries.length > 0 ? `
        <div class="discover-chips">
          <span class="discover-chip-label">Industry:</span>
          ${industryChips}
          ${industryFilter.size > 0 ? '<button class="discover-chip-clear" id="discover-clear-industry" type="button">Clear</button>' : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function renderCard(p) {
  const score = scoreValue(p);
  const tone = scoreClass(score);
  const description = describeMatch(p);
  const inds = postingIndustries(p);
  const indPills = inds.slice(0, 3).map((i) => `<span class="discover-card-tag">${esc(i)}</span>`).join('');
  const posted = p.postedAt ? `<span class="discover-card-meta-item">Posted ${esc(p.postedAt)}</span>` : '';
  const skipped = p.status === 'SKIP';

  return `
    <article class="discover-card${skipped ? ' is-skipped' : ''}" data-url="${esc(p.url)}" data-company="${esc(p.company)}" data-role="${esc(p.role)}" role="button" tabindex="0" aria-label="View match details for ${esc(p.role)} at ${esc(p.company)}">
      <header class="discover-card-head">
        <div class="discover-card-title">
          <span class="discover-card-company">${esc(p.company)}</span>
          <span class="discover-card-role">${esc(p.role)}</span>
        </div>
        <button type="button" class="score-trigger discover-card-score-btn" data-score-trigger title="Click for match details">
          ${p.contextualScoring ? renderScoreLoading() : renderScoreRing(score, tone, p.contextualScoreSource === 'llm' ? 'LLM contextual score' : '')}
        </button>
      </header>
      <p class="discover-card-rationale">${esc(description)}</p>
      <div class="discover-card-meta">
        ${posted}
        ${indPills}
      </div>
      <div class="discover-card-actions">
        <a class="btn btn-ghost btn-sm" href="${esc(p.url)}" target="_blank" rel="noreferrer" data-card-stop>Open</a>
        <button class="btn btn-sm btn-secondary discover-tailor" type="button" data-card-stop title="Score the role and draft a tailored CV + cover letter when the fit is strong">Tailor</button>
        <button class="btn btn-sm btn-soft discover-applied" type="button" data-card-stop>Applied</button>
        <button class="btn btn-ghost btn-sm discover-skip" type="button" data-card-stop>Skip</button>
      </div>
    </article>
  `;
}

function renderGroups(filtered) {
  if (groupBy === 'flat') {
    const sorted = sortByRelevance(filtered);
    return `<div class="discover-grid">${sorted.map(renderCard).join('')}</div>`;
  }
  const groups = groupPostingsByCompany(filtered);
  return groups.map((g) => `
    <details class="discover-group" open>
      <summary class="discover-group-summary">
        <span class="discover-group-name">${esc(g.company)}</span>
        <span class="discover-group-count">${g.count} role${g.count === 1 ? '' : 's'}</span>
        <span class="badge badge-score ${scoreClass(g.bestScore)} discover-group-best">${g.bestScore.toFixed(1)} top</span>
      </summary>
      <div class="discover-grid">${g.items.map(renderCard).join('')}</div>
    </details>
  `).join('');
}

function renderEmptyState() {
  if (pending.length === 0) {
    return `
      <div class="empty-state">
        <h3>No pending roles yet</h3>
        <p>Run a scan or a Deep scan to discover roles.</p>
      </div>
    `;
  }
  return `
    <div class="empty-state">
      <h3>No matches with current filters</h3>
      <p>Lower the minimum score, clear industry filters, or change your search keywords.</p>
    </div>
  `;
}

function renderBody() {
  if (pending.length === 0) return renderEmptyState();
  const filtered = applyFilters(pending);
  if (filtered.length === 0) return renderEmptyState();
  return renderGroups(filtered);
}

function rerender(container) {
  // Preserve scroll while re-rendering for filter changes.
  const prevScroll = container.scrollTop;
  container.innerHTML = `
    ${renderTopBar()}
    <div class="discover-body">${renderBody()}</div>
  `;
  bindEvents(container);
  container.scrollTop = prevScroll;
}

function bindEvents(container) {
  container.querySelector('#discover-refresh-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await refreshPendingPostings(container, { force: true, source: 'manual' });
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  });

  bindScanControls(container);
  container.querySelector('#search-keywords-btn')?.addEventListener('click', () => openSearchKeywordsModal(container));
  container.querySelector('#contextual-scoring-toggle')?.addEventListener('change', async (e) => {
    const enabled = Boolean(e.target.checked);
    setContextualScoringEnabled(enabled);
    contextualScoringError = '';
    if (!enabled) {
      contextualScoringRun++;
      contextualScoringActive = false;
      pending = resetPendingToHeuristicScores(pending);
      rerender(container);
      return;
    }
    rerender(container);
    startContextualScoring(container);
  });

  // preserveFocus keeps the cursor in the search input across rerender()'s
  // full innerHTML rewrite — otherwise typing more than once de-focuses.
  container.querySelector('#discover-search')?.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    preserveFocus(container, () => rerender(container));
  });

  // The slider used to call rerender() on every `input`, which destroys
  // the slider element mid-drag and forces the user to click-step rather
  // than drag. Update the label + filtered body in place so the slider
  // keeps focus and drag works the way the OS native range control wants.
  container.querySelector('#discover-min-input')?.addEventListener('input', (e) => {
    minScore = Number.parseFloat(e.target.value);
    const label = container.querySelector('#discover-min-label');
    if (label) label.textContent = minScore.toFixed(1);
    const body = container.querySelector('.discover-body');
    if (body) {
      body.innerHTML = renderBody();
      bindCardEvents(container);
    }
  });

  container.querySelectorAll('.discover-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      groupBy = btn.dataset.group;
      rerender(container);
    });
  });

  container.querySelectorAll('.discover-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ind = btn.dataset.industry;
      if (industryFilter.has(ind)) industryFilter.delete(ind);
      else industryFilter.add(ind);
      rerender(container);
    });
  });

  container.querySelector('#discover-clear-industry')?.addEventListener('click', () => {
    industryFilter.clear();
    rerender(container);
  });

  bindCardEvents(container);
}

// Scan card handlers (Scan Now / Deep Scan / max-new). Lives
// on Discover since 2026-05-16 — Portals used to own this card.
function bindScanControls(container) {
  const limitSelect = container.querySelector('#scan-limit-select');
  if (limitSelect) {
    limitSelect.onchange = () => localStorage.setItem(SCAN_LIMIT_KEY, limitSelect.value);
  }

  // Quick Scan — ATS-only fast path streamed via SSE so progress matches Deep Scan UX.
  const scanNowBtn = container.querySelector('#scan-now-btn');
  if (scanNowBtn) {
    scanNowBtn.onclick = async () => {
      const limit = parseInt(localStorage.getItem(SCAN_LIMIT_KEY) || '0', 10) || 0;
      setScanProgress(quickProgressFromEvent({ stage: 'quick:start' }));
      rerender(container);
      toast(limit ? `Quick scan started (up to ${limit} new offers)…` : 'Quick scan started — ATS providers only…');
      const stream = api.runQuickScanStream({ limit });
      let lastStage = 'quick:start';

      await new Promise((resolve) => {
        const done = (fn) => { try { stream.close(); } catch {} fn(); };

        stream.addEventListener('progress', (ev) => {
          let data; try { data = JSON.parse(ev.data); } catch { return; }
          lastStage = data.stage || lastStage;
          const next = quickProgressFromEvent(data);
          if (next) {
            setScanProgress(next);
            updateScanProgressSlot(container);
          }
        });

        stream.addEventListener('complete', async (ev) => {
          let data; try { data = JSON.parse(ev.data); } catch { data = { summary: {} }; }
          const quick = data.summary?.quick?.added ?? 0;
          toast(`Quick scan complete: ${quick} new offer${quick !== 1 ? 's' : ''}`);
          await requestPermission();
          notifyScanComplete(quick || 0, 0);
          done(async () => {
            setScanProgress({ visible: false });
            await loadData();
            rerender(container);
            startContextualScoring(container);
            resolve();
          });
        });

        stream.addEventListener('error', (ev) => {
          let data; try { data = JSON.parse(ev.data || '{}'); } catch { data = {}; }
          const message = data.message
            ? `Quick scan failed: ${data.message}`
            : `Quick scan disconnected (last stage: ${lastStage}).`;
          toast(message, 'error');
          done(() => {
            setScanProgress({ visible: false });
            rerender(container);
            resolve();
          });
        });
      });
    };
  }

  // Deep Scan — Levels 1+2 (node scan.mjs) + Level 3 (WebSearch +
  // Playwright liveness) + Level 4 (JobSpy) in-process, streamed via SSE.
  const deepScanBtn = container.querySelector('#deep-scan-btn');
  if (deepScanBtn) {
    deepScanBtn.onclick = async () => {
      const ok = await confirmModal({
        title: 'Run Deep Scan?',
        body: `
          <p style="font-size:14px;color:var(--subtext);margin-bottom:8px">Starts with the same ATS-only Quick Scan, then searches broader job boards (Wellfound / RemoteOK / Ladders / JobSpy aggregators) and Playwright-verifies each hit before adding it to your pipeline.</p>
          <ul style="font-size:13px;color:var(--text);margin:8px 0 8px 20px;line-height:1.7">
            <li>Takes <strong>several minutes</strong> (vs the ATS-only quick scan)</li>
            <li>Uses your configured WebSearch provider quota (Brave / Serper / scrape)</li>
            <li>Finds roles at companies that aren't in <code>tracked_companies</code></li>
          </ul>
          <p style="font-size:13px;color:var(--subtext0)">Run weekly, not on every visit. New roles appear in this view when finished.</p>
        `,
        confirmText: 'Start Deep Scan',
      });
      if (!ok) return;

      const limit = parseInt(localStorage.getItem(SCAN_LIMIT_KEY) || '0', 10) || 0;
      setScanProgress(deepProgressFromEvent({ stage: 'quick:start' }) || { visible: true, tone: 'running', eyebrow: 'Deep Scan', title: 'Starting…', detail: '', meta: '' });
      rerender(container);

      let lastStage = 'starting';
      const stream = api.scanDeepStream({ limit });

      await new Promise((resolve) => {
        const done = (fn) => { try { stream.close(); } catch {} fn(); };

        stream.addEventListener('progress', (ev) => {
          let data; try { data = JSON.parse(ev.data); } catch { return; }
          lastStage = data.stage;
          const next = deepProgressFromEvent(data);
          if (next) {
            setScanProgress(next);
            updateScanProgressSlot(container);
          }
        });

        stream.addEventListener('complete', async (ev) => {
          let data; try { data = JSON.parse(ev.data); } catch { data = { summary: {} }; }
          const total = data.summary?.totalNew ?? 0;
          const lvl3 = data.summary?.level3?.added ?? 0;
          const lvl4 = data.summary?.level4?.added?.length ?? 0;
          const quick = data.summary?.quick?.added ?? 0;
          toast(`Deep scan complete — ${total} new role${total === 1 ? '' : 's'} (${quick} APIs + ${lvl3} WebSearch + ${lvl4} JobSpy). Refreshing…`);
          done(async () => {
            setScanProgress({ visible: false });
            await loadData();
            rerender(container);
            startContextualScoring(container);
            resolve();
          });
        });

        stream.addEventListener('error', (ev) => {
          let data; try { data = JSON.parse(ev.data || '{}'); } catch { data = {}; }
          const message = data.message
            ? `Deep scan failed: ${data.message}`
            : `Deep scan disconnected (last stage: ${lastStage}).`;
          toast(message, 'error');
          done(() => {
            setScanProgress({ visible: false });
            rerender(container);
            resolve();
          });
        });
      });
    };
  }
}

// Card-only handlers, separated from bindEvents so the slider's live-drag
// path (which only repaints `.discover-body`) can re-attach them without
// touching the toolbar inputs that would otherwise lose focus mid-drag.
function bindCardEvents(container) {
  container.querySelectorAll('.discover-card').forEach((card) => {
    const url = card.dataset.url;
    const company = card.dataset.company;
    const role = card.dataset.role;

    // Clicking the card body opens the match-score modal. Action buttons
    // inside the card are tagged with data-card-stop so they don't bubble.
    const openMatchModal = () => {
      const posting = pending.find((p) => p.url === url);
      if (!posting) return;
      openScoreModal(posting, { kind: 'pending' });
    };
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-card-stop]')) return;
      openMatchModal();
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (e.target.closest('[data-card-stop]')) return;
        e.preventDefault();
        openMatchModal();
      }
    });

    card.querySelector('.discover-tailor')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = pending.find((p) => p.url === url) || { company, role, url };
      openTailorModal(item, container);
    });
    card.querySelector('.discover-applied')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await api.applyPending(url, company, role);
        toast(`${company} marked as applied`);
        await loadData();
        rerender(container);
      } catch (err) {
        toast(`Failed: ${err.message}`, 'error');
      }
    });
    card.querySelector('.discover-skip')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await api.skipPending(url);
        toast(`${role} skipped`);
        await loadData();
        rerender(container);
      } catch (err) {
        toast(`Failed: ${err.message}`, 'error');
      }
    });
  });
}

function tailorScoreForWarning(item) {
  const llmScore = Number(item?.contextualScore);
  const heuristicScore = Number(item?.relevance);
  return item?.contextualScoreSource === 'llm' && Number.isFinite(llmScore) ? llmScore : heuristicScore;
}

async function confirmLowTailorScore(item) {
  const score = tailorScoreForWarning(item);
  if (!Number.isFinite(score) || score >= 3) return 'tailor';
  return promptLowTailorScoreAction({
    company: item.company,
    role: item.role,
    score,
  });
}

async function openTailorModal(item, container) {
  const { company, role, url } = item;
  const lowScoreChoice = await confirmLowTailorScore(item);
  if (lowScoreChoice === 'skip') {
    try {
      await api.skipPending(url);
      await loadData();
      rerender(container);
      toast(`Skipped ${company} for low fit`);
    } catch (err) {
      toast(`Skip failed: ${err.message || String(err)}`, 'error');
    }
    return;
  }
  if (lowScoreChoice !== 'tailor') return;
  const action = await promptTailorAction({ company, role });
  if (!action) return;
  if (action === 'evaluate') {
    toast(`Running full evaluation for ${company}`);
    try {
      await runModePrompt('evaluate', { url, company, role });
      const tailorResult = await api.tailor({ company, role, url });
      await loadData();
      rerender(container);
      toast(`Evaluation + tailor bundle ready for ${company}`);
      renderResult(tailorResult);
    } catch (err) {
      toast(`Evaluation failed: ${err.message || String(err)}`, 'error');
    }
    return;
  }

  // Modal lives on body so it overlays the whole dashboard. Built once
  // and reused — re-renders into innerHTML for state changes.
  let modal = document.getElementById('tailor-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'tailor-modal';
    modal.className = 'tailor-modal-backdrop';
    document.body.appendChild(modal);
  }

  const close = () => modal.remove();

  function renderRunning() {
    modal.innerHTML = `
      <div class="tailor-modal">
        <header class="tailor-modal-head">
          <h3>Tailoring application for <em>${esc(role)}</em> at <em>${esc(company)}</em></h3>
          <button class="btn btn-ghost btn-sm" id="tailor-cancel" type="button">Close</button>
        </header>
        <div class="tailor-modal-body">
          <div class="onboarding-status" style="display:flex">
            <span class="spinner"></span>
            <span>Running the agent — generating tailored CV, cover letter, and Q&amp;A. ~1–3 minutes.</span>
          </div>
          <p class="tailor-modal-hint">The agent reads your CV, profile, and the JD. Output lands in <code>output/tailor-bundles/</code> on disk and previews here when done.</p>
        </div>
      </div>
    `;
    modal.querySelector('#tailor-cancel').addEventListener('click', close);
  }

  function renderResult(result) {
    const { paths, preview, slug } = result;
    const reportFilename = result.report?.filename || '';
    const qaPreview = (preview.qa_first || []).map((q) => `
      <details class="tailor-qa">
        <summary>${esc(q.question)}</summary>
        <p>${esc(q.answer)}</p>
      </details>
    `).join('');

    modal.innerHTML = `
      <div class="tailor-modal tailor-modal-result">
        <header class="tailor-modal-head">
          <h3>✓ Tailor bundle ready</h3>
          <button class="btn btn-ghost btn-sm" id="tailor-cancel" type="button">Close</button>
        </header>
        <div class="tailor-modal-body">
          <p class="tailor-modal-hint">
            Saved to <code>${esc(result.dir)}</code>${reportFilename ? ` and added to <a href="#/reports/${encodeURIComponent(reportFilename)}">Reports</a>` : ''}.
          </p>

          <section class="tailor-section">
            <header>
              <h4>Tailored CV</h4>
              <span class="cell-actions">
                <a class="btn btn-sm" href="${api.tailorFileUrl(paths.cv)}" target="_blank" rel="noreferrer">MD</a>
                ${paths.cvDoc ? `<a class="btn btn-sm" href="${api.tailorFileUrl(paths.cvDoc)}" target="_blank" rel="noreferrer">DOC</a>` : ''}
                ${paths.cvPdf ? `<a class="btn btn-sm btn-primary" href="${api.tailorFileUrl(paths.cvPdf)}" target="_blank" rel="noreferrer">PDF</a>` : ''}
              </span>
            </header>
            <pre class="tailor-preview">${esc(preview.cv_excerpt)}…</pre>
          </section>

          <section class="tailor-section">
            <header>
              <h4>Cover letter</h4>
              <span class="cell-actions">
                <a class="btn btn-sm" href="${api.tailorFileUrl(paths.coverLetter)}" target="_blank" rel="noreferrer">MD</a>
                ${paths.coverLetterDoc ? `<a class="btn btn-sm" href="${api.tailorFileUrl(paths.coverLetterDoc)}" target="_blank" rel="noreferrer">DOC</a>` : ''}
                ${paths.coverLetterPdf ? `<a class="btn btn-sm btn-primary" href="${api.tailorFileUrl(paths.coverLetterPdf)}" target="_blank" rel="noreferrer">PDF</a>` : ''}
              </span>
            </header>
            <pre class="tailor-preview">${esc(preview.cover_letter_excerpt)}…</pre>
          </section>

        <section class="tailor-section">
          <header>
            <h4>Application Q&amp;A (${preview.qa_count})</h4>
          </header>
          ${qaPreview}
        </section>

          ${reportFilename ? `<a class="btn btn-sm btn-secondary" href="#/reports/${encodeURIComponent(reportFilename)}">View report</a>` : ''}
        </div>
      </div>
    `;
    modal.querySelector('#tailor-cancel').addEventListener('click', close);
  }

  function renderError(message) {
    modal.innerHTML = `
      <div class="tailor-modal tailor-modal-error">
        <header class="tailor-modal-head">
          <h3>Tailor failed</h3>
          <button class="btn btn-ghost btn-sm" id="tailor-cancel" type="button">Close</button>
        </header>
        <div class="tailor-modal-body">
          <p class="tailor-modal-error-text">${esc(message)}</p>
          <p class="tailor-modal-hint">The agent's output couldn't be parsed, or the agent didn't return all three required sections. Try again — agents are non-deterministic and a re-run often succeeds.</p>
        </div>
      </div>
    `;
    modal.querySelector('#tailor-cancel').addEventListener('click', close);
  }

  renderRunning();

  api.tailor({ company, role, url })
    .then(async (result) => {
      renderResult(result);
      await loadData();
      rerender(container);
    })
    .catch((err) => renderError(err.message || String(err)));
}

async function loadData() {
  try {
    const [appsResp, portalsResp, statusResp] = await Promise.all([
      api.getApplications(),
      api.getPortals(),
      api.getScanStatus().catch(() => null),
    ]);
    const nextPending = Array.isArray(appsResp.pending) ? appsResp.pending : [];
    pending = mergePendingContextualState(nextPending, pending);
    portals = portalsResp?.portals || portalsResp || null;
    scanStatus = statusResp || null;
  } catch (err) {
    pending = [];
    portals = null;
    scanStatus = null;
    toast(`Failed to load discover data: ${err.message}`, 'error');
  }
}

async function startContextualScoring(container) {
  if (!contextualScoringEnabled() || contextualScoringActive || pending.length === 0) return;
  const urls = pending
    .filter((p) => p.url && p.contextualScoreSource !== 'llm')
    .map((p) => p.url);
  if (!urls.length) return;

  const runId = ++contextualScoringRun;
  contextualScoringActive = true;
  contextualScoringError = '';
  pending = pending.map((p) => urls.includes(p.url) ? { ...p, contextualScoring: true } : p);
  rerenderIfActive(container);

  try {
    const result = await api.getContextualScores(urls);
    if (runId !== contextualScoringRun) return;
    pending = applyContextualScoreResults(pending, result.scores || []);
  } catch (err) {
    if (runId !== contextualScoringRun) return;
    contextualScoringError = err.message || String(err);
    pending = pending.map((p) => ({ ...p, contextualScoring: false }));
    toast(`Contextual scoring unavailable: ${contextualScoringError}`, 'error');
  } finally {
    if (runId === contextualScoringRun) {
      contextualScoringActive = false;
      rerenderIfActive(container);
    }
  }
}

export async function render(container) {
  ensurePendingRefresh(container);
  container.innerHTML = '<div class="empty-state"><p>Loading…</p></div>';
  await loadData();
  rerender(container);
  refreshPendingPostings(container, { source: 'load' }).catch(() => {});
}
