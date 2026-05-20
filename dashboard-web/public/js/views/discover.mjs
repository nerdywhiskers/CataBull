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
import { toast } from '../components/toast.mjs';
import { confirmModal } from '../components/confirm.mjs';
import { openScoreModal } from '../components/score-modal.mjs';
import { notifyScanComplete, requestPermission } from '../components/notifications.mjs';
import { runModePrompt } from '../lib/modes.mjs';
import { preserveFocus } from '../lib/focus.mjs';
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
let minScore = 2.5;     // default threshold; matches the scan relevance default
let industryFilter = new Set();   // empty = no filter
let companyFilter = '';          // free-text
let searchQuery = '';
let groupBy = 'flat';            // 'company' | 'flat' — flat by default per UX 2026-05-16

// Scan controls moved here from the Portals page (2026-05-16). The
// `careerbot-scan-limit` localStorage key stays shared with portals.mjs
// so the per-company Scan button there honors the same cap.
const SCAN_LIMIT_KEY = 'careerbot-scan-limit';
const SCAN_LIMIT_OPTIONS = [
  { value: '5', label: '5' },
  { value: '10', label: '10' },
  { value: '25', label: '25' },
  { value: '50', label: '50' },
  { value: '100', label: '100' },
  { value: '0', label: 'All' },
];

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

// Build a one-line description from the heuristic match factors. Falls back
// to the canned rationale when factors aren't available so an early-onboarded
// user still sees something useful. Factor labels from lib/relevance.mjs are
// already self-describing (e.g. "Matches target role 'staff engineer'") so
// we join them as-is instead of prepending extra words.
function describeMatch(p) {
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
  const scheduleLabels = { off: 'Off', daily: 'Daily', 'every-3-days': 'Every 3 days', weekly: 'Weekly' };
  const current = scanStatus.schedule || 'off';
  const savedLimit = localStorage.getItem(SCAN_LIMIT_KEY) || '0';

  let lastScanBadge = '';
  if (scanStatus.lastScanAt) {
    const r = scanStatus.lastScanResult;
    const resultText = r
      ? (r.success
          ? `${r.newOffers} new offer${r.newOffers !== 1 ? 's' : ''}`
          : 'failed')
      : '';
    const tone = r ? (r.success ? 'var(--green)' : 'var(--red)') : 'var(--subtext)';
    lastScanBadge = `<span class="scan-card-last" style="color:${tone}">${timeAgo(scanStatus.lastScanAt)}${resultText ? ` · ${resultText}` : ''}</span>`;
  }

  return `
    <div class="scan-card">
      <div class="scan-card-left">
        <span class="scan-card-eyebrow">Last Scan</span>
        ${lastScanBadge}
      </div>
      <div class="scan-card-controls">
        <span class="scan-card-label">Schedule</span>
        <select class="form-select scan-card-select" id="scan-schedule-select" title="Run scan on a schedule">
          ${Object.entries(scheduleLabels).map(([value, label]) => `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <select class="form-select scan-card-select" id="scan-limit-select" ${scanStatus.running ? 'disabled' : ''} title="Cap on new offers added per scan">
          ${SCAN_LIMIT_OPTIONS.map(o => `<option value="${o.value}"${o.value === savedLimit ? ' selected' : ''}>Max: ${o.label}</option>`).join('')}
        </select>
        <button class="btn btn-sm btn-primary" id="scan-now-btn" ${scanStatus.running ? 'disabled' : ''} title="API sweep across tracked companies (~30s, no LLM)">
          <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor" aria-hidden="true"><path d="M7.5 0L0 7.5h4L3.5 14 11 6.5H7L7.5 0z"/></svg>
          ${scanStatus.running ? 'Scanning' : 'Scan'}
        </button>
        <button class="btn btn-sm btn-secondary" id="deep-scan-btn" ${scanStatus.running ? 'disabled' : ''} title="Quick Scan + WebSearch on job boards + JobSpy aggregator scrape. Several minutes; uses WebSearch quota.">Deep Scan</button>
        <button class="btn-icon" id="discover-refresh-btn" title="Refresh pending list">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 6a4.5 4.5 0 1 1-1.3-3.18"/><polyline points="11.5 1 11.5 4 8.5 4"/></svg>
        </button>
      </div>
    </div>
  `;
}

function renderHeader() {
  const totalIfFiltered = applyFilters(pending).length;
  return `
    <header class="section-header">
      <div>
        <h1 class="section-title">Discover</h1>
        <p class="section-sub">Scored roles across your tracked portals and job boards. ${totalIfFiltered} of ${pending.length} pending postings shown.</p>
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
    <div class="discover-toolbar">
      <div class="discover-toolbar-row">
        <input class="form-input discover-search" id="discover-search" placeholder="Search company or role…" value="${esc(searchQuery)}" />
        <label class="discover-score-slider">
          <span>Min score: <strong id="discover-min-label">${minScore.toFixed(1)}</strong></span>
          <input type="range" min="0" max="5" step="0.5" value="${minScore}" id="discover-min-input" />
        </label>
        <div class="discover-group-toggle">
          <button class="discover-toggle-btn${groupBy === 'flat' ? ' active' : ''}" data-group="flat" type="button">Flat</button>
          <button class="discover-toggle-btn${groupBy === 'company' ? ' active' : ''}" data-group="company" type="button">By company</button>
        </div>
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
  const score = Number.isFinite(p.relevance) ? p.relevance : 0;
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
          ${renderScoreRing(score, tone, '')}
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
        <p>Run a scan from the <a href="#/portals">Portals</a> tab to discover roles. Onboarding's verified discovery seeds your <code>portals.yml</code>; the scan then populates this view.</p>
      </div>
    `;
  }
  return `
    <div class="empty-state">
      <h3>No matches with current filters</h3>
      <p>Lower the minimum score, clear industry filters, or change your title filter on the <a href="#/portals">Portals</a> tab.</p>
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
    toast('Refreshing pending list…');
    try {
      await loadData();
      rerender(container);
    } finally {
      // rerender() replaces the node; nothing to re-enable.
    }
  });

  bindScanControls(container);

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

// Scan card handlers (Scan Now / Deep Scan / schedule / max-new). Lives
// on Discover since 2026-05-16 — Portals used to own this card.
function bindScanControls(container) {
  const scheduleSelect = container.querySelector('#scan-schedule-select');
  if (scheduleSelect) {
    scheduleSelect.onchange = async () => {
      try {
        scanStatus = await api.setScanSchedule(scheduleSelect.value);
        toast(`Scan schedule: ${scheduleSelect.value}`);
        rerender(container);
      } catch {
        toast('Failed to update schedule', 'error');
      }
    };
  }

  const limitSelect = container.querySelector('#scan-limit-select');
  if (limitSelect) {
    limitSelect.onchange = () => localStorage.setItem(SCAN_LIMIT_KEY, limitSelect.value);
  }

  // Scan Now — API sweep via local scan.mjs (~30s, no LLM).
  const scanNowBtn = container.querySelector('#scan-now-btn');
  if (scanNowBtn) {
    scanNowBtn.onclick = async () => {
      const limit = parseInt(localStorage.getItem(SCAN_LIMIT_KEY) || '0', 10) || 0;
      scanNowBtn.disabled = true;
      scanNowBtn.textContent = 'Scanning…';
      toast(limit ? `Scanning (up to ${limit} new offers)…` : 'Scan started, this takes about 30 seconds…');
      try {
        const result = await api.runScanNow(limit);
        if (result.success) {
          toast(`Scan complete: ${result.newOffers} new offer${result.newOffers !== 1 ? 's' : ''}`);
          await requestPermission();
          notifyScanComplete(result.newOffers || 0, 0);
        } else {
          toast(`Scan error: ${result.error || 'unknown'}`, 'error');
        }
      } catch (error) {
        toast(`Scan failed: ${error.message}`, 'error');
      } finally {
        await loadData();
        rerender(container);
      }
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
          <p style="font-size:14px;color:var(--subtext);margin-bottom:8px">Runs Quick Scan first, then searches every enabled job board (Wellfound / RemoteOK / Ladders / JobSpy aggregators) and Playwright-verifies each hit before adding it to your pipeline.</p>
          <ul style="font-size:13px;color:var(--text);margin:8px 0 8px 20px;line-height:1.7">
            <li>Takes <strong>several minutes</strong> (vs ~30s for the regular Scan Now)</li>
            <li>Uses your configured WebSearch provider quota (Brave / Serper / scrape)</li>
            <li>Finds roles at companies that aren't in <code>tracked_companies</code></li>
          </ul>
          <p style="font-size:13px;color:var(--subtext0)">Run weekly, not on every visit. New roles appear in this view when finished.</p>
        `,
        confirmText: 'Start Deep Scan',
      });
      if (!ok) return;

      const limit = parseInt(localStorage.getItem(SCAN_LIMIT_KEY) || '0', 10) || 0;
      deepScanBtn.disabled = true;
      deepScanBtn.textContent = 'Running…';

      let lastStage = 'starting';
      const stream = api.scanDeepStream({ limit });

      await new Promise((resolve) => {
        const done = (fn) => { try { stream.close(); } catch {} fn(); };

        stream.addEventListener('progress', (ev) => {
          let data; try { data = JSON.parse(ev.data); } catch { return; }
          lastStage = data.stage;
          if (data.stage === 'quick:scanning')           deepScanBtn.textContent = `Quick · ${data.companies} portals…`;
          else if (data.stage === 'quick:done')          deepScanBtn.textContent = `L3 starting (Quick +${data.added || 0})…`;
          else if (data.stage === 'l3:search:start')     deepScanBtn.textContent = `Searching ${data.queryIndex + 1}/${data.total}…`;
          else if (data.stage === 'l3:liveness:check')   deepScanBtn.textContent = `Verifying ${data.index + 1}/${data.total}…`;
          else if (data.stage === 'l3:done')             deepScanBtn.textContent = `L3 done (+${data.added})`;
          else if (data.stage === 'l4:start')            deepScanBtn.textContent = `JobSpy ${data.queries} queries…`;
          else if (data.stage === 'l4:query:start')      deepScanBtn.textContent = `JobSpy ${data.queryIndex + 1}/${data.total}…`;
          else if (data.stage === 'l4:liveness:check')   deepScanBtn.textContent = `JobSpy verify ${data.index + 1}/${data.total}…`;
          else if (data.stage === 'l4:done')             deepScanBtn.textContent = `L4 done (+${data.added})`;
        });

        stream.addEventListener('complete', async (ev) => {
          let data; try { data = JSON.parse(ev.data); } catch { data = { summary: {} }; }
          const total = data.summary?.totalNew ?? 0;
          const lvl3 = data.summary?.level3?.added ?? 0;
          const lvl4 = data.summary?.level4?.added?.length ?? 0;
          const quick = data.summary?.quick?.added ?? 0;
          toast(`Deep scan complete — ${total} new role${total === 1 ? '' : 's'} (${quick} APIs + ${lvl3} WebSearch + ${lvl4} JobSpy). Refreshing…`);
          done(async () => {
            deepScanBtn.disabled = false;
            deepScanBtn.textContent = 'Deep Scan';
            await loadData();
            rerender(container);
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
            deepScanBtn.disabled = false;
            deepScanBtn.textContent = 'Deep Scan';
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
      openTailorModal({ company, role, url });
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

function openTailorModal({ company, role, url }) {
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
            Saved to <code>${esc(result.dir)}</code>. Convert <code>cv.md</code> to PDF via <code>npm run pdf -- ${esc(paths.cv)} output/${esc(slug)}.pdf</code>.
          </p>

          <section class="tailor-section">
            <header>
              <h4>Tailored CV</h4>
              <a class="btn btn-sm" href="${api.tailorFileUrl(paths.cv)}" target="_blank" rel="noreferrer">Download</a>
            </header>
            <pre class="tailor-preview">${esc(preview.cv_excerpt)}…</pre>
          </section>

          <section class="tailor-section">
            <header>
              <h4>Cover letter</h4>
              <a class="btn btn-sm" href="${api.tailorFileUrl(paths.coverLetter)}" target="_blank" rel="noreferrer">Download</a>
            </header>
            <pre class="tailor-preview">${esc(preview.cover_letter_excerpt)}…</pre>
          </section>

          <section class="tailor-section">
            <header>
              <h4>Application Q&amp;A (${preview.qa_count})</h4>
              <a class="btn btn-sm" href="${api.tailorFileUrl(paths.qa)}" target="_blank" rel="noreferrer">Download all</a>
            </header>
            ${qaPreview}
          </section>
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
    .then(renderResult)
    .catch((err) => renderError(err.message || String(err)));
}

async function loadData() {
  try {
    const [appsResp, portalsResp, statusResp] = await Promise.all([
      api.getApplications(),
      api.getPortals(),
      api.getScanStatus().catch(() => null),
    ]);
    pending = Array.isArray(appsResp.pending) ? appsResp.pending : [];
    portals = portalsResp || null;
    scanStatus = statusResp || null;
  } catch (err) {
    pending = [];
    portals = null;
    scanStatus = null;
    toast(`Failed to load discover data: ${err.message}`, 'error');
  }
}

export async function render(container) {
  container.innerHTML = '<div class="empty-state"><p>Loading…</p></div>';
  await loadData();
  rerender(container);
}
