import { api } from '../api.mjs';
import { AddCompanyModal, EditCompanyModal } from '../components/company-form.mjs';
import { toast } from '../components/toast.mjs';
import { confirmModal } from '../components/confirm.mjs';
import { runModePrompt } from '../lib/modes.mjs';
import { INDUSTRIES } from '../lib/industries.mjs';
import { preserveFocus } from '../lib/focus.mjs';

// The per-company "Scan" button respects the cap set on the Discover page;
// the Discover page is the source of truth for that select. Keep the key
// in sync with discover.mjs:SCAN_LIMIT_KEY.
const SCAN_LIMIT_KEY = 'careerbot-scan-limit';

const INDUSTRY_FILTER_KEY = 'careerbot-portals-industry-filter';
const HEALTH_FILTER_KEY = 'careerbot-portals-health-filter';

function loadSetFromStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function persistSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* ignore */ }
}

let portals = null;
let companyMetrics = {};
let providerOptions = [];
let activeTab = 'companies';
let searchQuery = '';
let activeFilter = 'all';
let groupByProvider = true;
let healthSnapshot = null;
let healthChecking = false;
let fixBrokenLinksRunning = false;
let fixBrokenLinksProgress = null;
// Toggle for the bot-blocked digest under the Health Tools card. Collapsed
// by default so it doesn't dominate the tab on profiles where every other
// company is behind a WAF.
let botBlockedExpanded = false;
let industryFilter = loadSetFromStorage(INDUSTRY_FILTER_KEY);
let healthFilter = loadSetFromStorage(HEALTH_FILTER_KEY);
let healthToolsExpanded = false;

const SOURCE_LABELS = {
  greenhouse: 'Greenhouse',
  ashby: 'Ashby',
  lever: 'Lever',
  workable: 'Workable',
  linkedin: 'LinkedIn',
  wellfound: 'Wellfound',
  ladders: 'Ladders',
  remoteok: 'Remote OK',
  remotive: 'Remotive',
  weworkremotely: 'We Work Remotely',
  workingnomads: 'Working Nomads',
  ai_jobs: 'ai-jobs.net',
  yc: 'YC Jobs',
  webfetch: 'Webfetch',
};

function esc(value = '') {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function explicitProvider(company) {
  if (company.provider) return company.provider;
  if (company.scan_method === 'websearch') return 'webfetch';
  return null;
}

function inferProvider(company) {
  const provider = explicitProvider(company);
  if (provider === 'greenhouse') return { key: 'greenhouse', label: 'Greenhouse', scanable: Boolean(company.careers_url || company.api) };
  if (provider === 'ashby') return { key: 'ashby', label: 'Ashby', scanable: Boolean(company.careers_url) };
  if (provider === 'lever') return { key: 'lever', label: 'Lever', scanable: Boolean(company.careers_url) };
  if (provider === 'webfetch') return { key: 'webfetch', label: 'Webfetch', scanable: Boolean(company.careers_url) };
  if (company.api?.includes('greenhouse') || /greenhouse/.test(company.careers_url || '')) return { key: 'greenhouse', label: 'Greenhouse', scanable: true };
  if (/ashbyhq/.test(company.careers_url || '')) return { key: 'ashby', label: 'Ashby', scanable: true };
  if (/lever\.co/.test(company.careers_url || '')) return { key: 'lever', label: 'Lever', scanable: true };
  if (company.careers_url) return { key: 'webfetch', label: 'Webfetch', scanable: true };
  return { key: 'manual', label: 'Manual', scanable: false };
}

function sourceFromQueryName(name = '') {
  const lower = String(name).toLowerCase();
  if (lower.includes('linkedin')) return 'linkedin';
  if (lower.includes('wellfound')) return 'wellfound';
  if (lower.includes('ladders')) return 'ladders';
  if (lower.includes('remoteok') || lower.includes('remote ok')) return 'remoteok';
  if (lower.includes('remotive')) return 'remotive';
  if (lower.includes('weworkremotely')) return 'weworkremotely';
  if (lower.includes('working nomads')) return 'workingnomads';
  if (lower.includes('ai-jobs')) return 'ai_jobs';
  if (lower.includes('yc jobs') || lower.includes('ycombinator')) return 'yc';
  if (lower.includes('workable')) return 'workable';
  if (lower.includes('greenhouse')) return 'greenhouse';
  if (lower.includes('ashby')) return 'ashby';
  if (lower.includes('lever')) return 'lever';
  return lower.split(/[-\u2013\u2014]/)[0].trim();
}

function labelForIndustry(industry = '') {
  return String(industry)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, chr => chr.toUpperCase());
}

function getCompanyHealth(name) {
  if (!healthSnapshot?.companies) return null;
  return healthSnapshot.companies.find(c => c.name === name) || null;
}

function matchesQuickFilter(company, metrics) {
  if (activeFilter === 'all') return true;
  if (activeFilter === 'recent') return metrics.lastScannedAt && (Date.now() - new Date(metrics.lastScannedAt).getTime()) < (7 * 24 * 60 * 60 * 1000);
  if (activeFilter === 'never') return !metrics.lastScannedAt;
  if (activeFilter === 'match') return (metrics.matchRate || 0) >= 20;
  if (activeFilter === 'disabled') return company.enabled === false;
  return true;
}

function matchesIndustryFilter(company) {
  if (industryFilter.size === 0) return true;
  const companyIndustries = Array.isArray(company.industries) ? company.industries : [];
  return companyIndustries.some(ind => industryFilter.has(ind));
}

function matchesHealthFilter(company) {
  if (healthFilter.size === 0) return true;
  const health = getCompanyHealth(company.name);
  const status = health?.status;
  const isAutoDisabled = company.auto_disabled === true;
  for (const target of healthFilter) {
    if (target === 'auto_disabled' && isAutoDisabled) return true;
    if (status === target) return true;
  }
  return false;
}

function matchesFilter(company, metrics) {
  return matchesQuickFilter(company, metrics)
    && matchesIndustryFilter(company)
    && matchesHealthFilter(company);
}

function companyList() {
  const companies = portals?.tracked_companies || [];
  return companies
    .filter(company => {
      const haystack = `${company.name} ${company.notes || ''}`.toLowerCase();
      return !searchQuery.trim() || haystack.includes(searchQuery.trim().toLowerCase());
    })
    .filter(company => matchesFilter(company, companyMetrics[company.name] || {}));
}

function renderCompaniesHeader() {
  const tracked = portals?.tracked_companies?.length || 0;
  return `
    <header class="section-header">
      <div>
        <h1 class="section-title">Portals</h1>
        <p class="section-sub">Manage tracked companies, sources, and title keywords. ${tracked} compan${tracked === 1 ? 'y' : 'ies'} tracked.</p>
      </div>
    </header>
  `;
}

function renderCompanyToolbar() {
  const filters = [
    ['all', 'All'],
    ['recent', 'Scanned <7d'],
    ['never', 'Never scanned'],
    ['match', 'Match >= 20%'],
    ['disabled', 'Disabled'],
  ];

  const industryChips = INDUSTRIES.map(ind => `
    <button class="filter-chip${industryFilter.has(ind.id) ? ' active' : ''}" data-industry="${esc(ind.id)}" title="${esc(ind.description)}">${esc(ind.label)}</button>
  `).join('');

  const healthFilters = [
    { id: 'healthy', label: 'Healthy' },
    { id: 'empty', label: 'Empty' },
    { id: 'not_found', label: 'Not Found' },
    { id: 'bot_blocked', label: 'Bot-blocked' },
    { id: 'unknown_ats', label: 'Unknown ATS' },
    { id: 'network_error', label: 'Network' },
    { id: 'auto_disabled', label: 'Auto-disabled' },
  ];
  const healthChips = healthFilters.map(h => `
    <button class="filter-chip filter-chip-health filter-chip-health-${h.id}${healthFilter.has(h.id) ? ' active' : ''}" data-health-status="${esc(h.id)}">${esc(h.label)}</button>
  `).join('');

  // Bulk-action row reflects the currently-visible filtered list. Counts
  // come from companyList() which already AND-combines search, quick
  // filter, industry chips, and health chips.
  const visible = companyList();
  const visibleEnabled = visible.filter(c => c.enabled !== false).length;
  const visibleDisabled = visible.length - visibleEnabled;
  const filtersActive = searchQuery.trim()
    || activeFilter !== 'all'
    || industryFilter.size > 0
    || healthFilter.size > 0;
  const bulkRow = visible.length > 0 ? `
    <div class="filter-chip-group" style="border-top:1px solid var(--border);padding-top:10px;margin-top:10px">
      <span class="filter-chip-label">Bulk</span>
      <span style="font-size:12px;color:var(--subtext)">${visible.length} ${filtersActive ? 'matching' : 'total'} (${visibleEnabled} enabled, ${visibleDisabled} disabled)</span>
      <button class="btn btn-sm" id="bulk-enable-btn" ${visibleDisabled === 0 ? 'disabled' : ''} title="Enable every company currently visible in this list">Enable all visible</button>
      <button class="btn btn-sm" id="bulk-disable-btn" ${visibleEnabled === 0 ? 'disabled' : ''} title="Disable every company currently visible in this list">Disable all visible</button>
    </div>
  ` : '';

  return `
    <div class="card" style="margin-bottom:16px">
      <div class="company-toolbar">
        <input class="form-input" id="company-search" placeholder="Search companies" value="${esc(searchQuery)}">
        <label class="company-group-toggle">
          <input type="checkbox" id="group-provider-toggle" ${groupByProvider ? 'checked' : ''}>
          <span>Group by ATS</span>
        </label>
      </div>
      <div class="filter-tabs" style="margin-bottom:20px">
        ${filters.map(([key, label]) => `<button class="filter-tab${activeFilter === key ? ' active' : ''}" data-company-filter="${key}">${label}</button>`).join('')}
      </div>
      <div class="filter-chip-group">
        <span class="filter-chip-label">Industry</span>
        ${industryChips}
        ${industryFilter.size > 0 ? '<button class="btn btn-ghost btn-sm" id="clear-industry-filter" style="font-size:11px">Clear</button>' : ''}
      </div>
      <div class="filter-chip-group">
        <span class="filter-chip-label">Health</span>
        ${healthChips}
        ${healthFilter.size > 0 ? '<button class="btn btn-ghost btn-sm" id="clear-health-filter" style="font-size:11px">Clear</button>' : ''}
      </div>
      ${bulkRow}
    </div>
  `;
}

async function bulkSetEnabled(enabled, container) {
  const visible = companyList();
  const targets = visible.filter(c => (c.enabled !== false) !== enabled);
  if (!targets.length) return 0;
  const noun = targets.length === 1 ? 'company' : 'companies';
  const action = enabled ? 'Enable' : 'Disable';
  const ok = await confirmModal({
    title: `${action} ${targets.length} ${noun}?`,
    body: `
      <p style="font-size:14px;color:var(--subtext);margin-bottom:8px">${action}s every company currently visible on this Companies tab. The set is computed from your active search, quick filter, industry chips, and health chips.</p>
      <p style="font-size:13px;color:var(--text);margin-bottom:8px">Affected (first 10):</p>
      <p style="font-size:13px;color:var(--subtext);font-family:monospace">${targets.slice(0,10).map(c => esc(c.name)).join(', ')}${targets.length > 10 ? ` …+${targets.length - 10} more` : ''}</p>
    `,
    confirmText: `${action} ${targets.length}`,
  });
  if (!ok) return 0;
  for (const company of targets) company.enabled = enabled;
  try {
    await api.updatePortals(portals);
    update(container);
    toast(`${enabled ? 'Enabled' : 'Disabled'} ${targets.length} ${noun}`);
    return targets.length;
  } catch (err) {
    // Roll back local state on failure to keep UI in sync with disk
    for (const company of targets) company.enabled = !enabled;
    update(container);
    toast(`Bulk update failed: ${err.message}`, 'error');
    return 0;
  }
}

function renderCompanyCard(company) {
  const metrics = companyMetrics[company.name] || { lastScannedAt: null, jobsFound: 0, matchRate: 0, pipelineMatches: 0 };
  const provider = inferProvider(company);
  const canScan = provider.scanable;
  const scanDisabledText = canScan ? '' : 'This company needs a careers URL or supported provider config before it can be scanned.';
  const industries = Array.isArray(company.industries) ? company.industries : [];

  const health = getCompanyHealth(company.name);
  const autoDisabled = company.auto_disabled === true;
  const autoDisableThreshold = Number(healthSnapshot?.autoDisableThreshold) || 3;
  const failures = Number(company?.health?.consecutive_failures) || 0;
  const healthPill = health
    ? `<span class="health-pill health-pill-${esc(health.status)}" title="${esc(HEALTH_LABELS[health.status] || health.status)}${health.error ? ' — ' + esc(health.error) : ''}">${esc(HEALTH_LABELS[health.status] || health.status)}</span>`
    : '<span class="health-pill health-pill-unknown" title="No health check yet">Unchecked</span>';
  const decayBadge = failures > 0 && !autoDisabled
    ? `<span class="health-decay" title="${failures} consecutive failed check${failures === 1 ? '' : 's'} (auto-disable at ${autoDisableThreshold})">${failures}/${autoDisableThreshold} failed</span>`
    : '';
  const autoBadge = autoDisabled
    ? '<span class="health-auto-disabled" title="Auto-disabled after consecutive health failures. Re-enable here once the URL is fixed.">auto-disabled</span>'
    : '';

  // Sniffer suggestion (W5) — surfaces inside the card when the health
  // classifier found candidate ATS URLs the user can adopt directly.
  const suggested = health?.suggestedCareersUrl || company?.health?.suggested_careers_url;
  const suggestedProvider = health?.suggestedProvider || company?.health?.suggested_provider;
  const sniffedCandidates = (health?.sniffedCandidates) || (company?.health?.sniffed_candidates) || [];
  const candidateCount = sniffedCandidates.length;
  const sniffSuggestion = suggested
    ? `<div class="health-sniff-suggestion" data-suggested-url="${esc(suggested)}">
         <span class="health-sniff-label">Suggested:</span>
         <a href="${esc(suggested)}" target="_blank" rel="noopener" class="health-sniff-url">${esc(suggested)}</a>
         ${suggestedProvider ? `<span class="health-sniff-provider">[${esc(suggestedProvider)}]</span>` : ''}
         ${candidateCount > 1 ? `<span class="health-sniff-more" title="${candidateCount - 1} additional candidate(s) found">+${candidateCount - 1} more</span>` : ''}
         <button class="btn btn-sm btn-primary health-sniff-adopt-btn" data-company="${esc(company.name)}" data-url="${esc(suggested)}">Use this URL</button>
       </div>`
    : (candidateCount > 0
      ? `<div class="health-sniff-suggestion health-sniff-ambiguous">
           <span class="health-sniff-label">Sniffer found ${candidateCount} candidates — review:</span>
           ${sniffedCandidates.slice(0, 3).map((cand) => `
             <div class="health-sniff-candidate">
               <a href="${esc(cand.url)}" target="_blank" rel="noopener">${esc(cand.url)}</a>
               <span class="health-sniff-provider">[${esc(cand.provider)}]</span>
               <button class="btn btn-sm health-sniff-adopt-btn" data-company="${esc(company.name)}" data-url="${esc(cand.url)}">Use</button>
             </div>
           `).join('')}
         </div>`
      : '');

  // "Find new URL" only makes sense for auto-disabled rows — same flow
  // the old Health tab exposed.
  const recoverBtn = autoDisabled
    ? `<button class="btn btn-sm health-recover-btn" data-company="${esc(company.name)}" title="Run WebSearch + role-fit pre-flight to find a new careers URL">Find new URL</button>`
    : '';

  return `
    <article class="card company-card" data-company="${esc(company.name)}" data-url="${esc(company.careers_url)}">
      <div class="company-card-top">
        <div>
          <div class="company-title-row">
            <h3 class="company-title">${esc(company.name)}</h3>
            <span class="company-provider-badge ${esc(provider.key)}">${esc(provider.label)}</span>
            ${healthPill}
          </div>
          <a href="${esc(company.careers_url)}" target="_blank" class="company-link">${esc(company.careers_url)}</a>
          ${(decayBadge || autoBadge) ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${autoBadge}${decayBadge}</div>` : ''}
        </div>
        <label class="toggle">
          <input type="checkbox" class="company-enabled-toggle" data-company="${esc(company.name)}" ${company.enabled !== false ? 'checked' : ''}>
          <span class="toggle-track"></span>
          <span class="toggle-thumb"></span>
        </label>
      </div>
      ${industries.length ? `<div class="tag-list">${industries.slice(0, 4).map(industry => `<span class="tag">${esc(labelForIndustry(industry))}</span>`).join('')}</div>` : ''}
      ${company.notes ? `<p class="company-notes">${esc(company.notes)}</p>` : '<p class="company-notes muted">No notes yet.</p>'}
      ${sniffSuggestion}
      <div class="company-metrics">
        <div><span class="metric-label">Last scanned</span><strong>${metrics.lastScannedAt ? timeAgo(metrics.lastScannedAt) : 'Never'}</strong></div>
        <div><span class="metric-label">Jobs found</span><strong>${metrics.jobsFound || 0}</strong></div>
        <div><span class="metric-label">Match rate</span><strong>${(metrics.matchRate || 0).toFixed(1)}%</strong></div>
      </div>
      <div class="company-actions">
        <button class="btn btn-sm company-scan-btn" data-company="${esc(company.name)}" ${canScan ? '' : 'disabled'} title="${esc(scanDisabledText)}">Scan Now</button>
        <button class="btn btn-sm health-recheck-btn" data-company="${esc(company.name)}" title="Run a health check on this company's careers URL">Recheck</button>
        ${recoverBtn}
        <button class="btn btn-sm company-edit-url-btn" data-company="${esc(company.name)}" data-url="${esc(company.careers_url)}" title="Edit just the careers URL">Edit URL</button>
        <button class="btn btn-sm company-deep-btn" data-company="${esc(company.name)}" data-url="${esc(company.careers_url)}" style="color:var(--yellow)">Deep Research</button>
        <button class="btn btn-sm company-edit-btn" data-company="${esc(company.name)}">Edit</button>
        <button class="btn btn-ghost btn-sm company-delete-btn" data-company="${esc(company.name)}" style="color:var(--red)">Delete</button>
      </div>
    </article>
  `;
}

function renderCompanyGrid() {
  const companies = companyList();
  if (!companies.length) return '<div class="empty-state"><h3>No companies match this filter</h3><p>Try a different search or add a new company.</p></div>';

  if (!groupByProvider) {
    return `<div class="company-grid">${companies.map(renderCompanyCard).join('')}</div>`;
  }

  const groups = {};
  for (const company of companies) {
    const provider = inferProvider(company).label;
    if (!groups[provider]) groups[provider] = [];
    groups[provider].push(company);
  }

  return Object.entries(groups)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([provider, entries]) => `
      <details class="company-group" open>
        <summary class="company-group-summary">
          <span>${esc(provider)}</span>
          <span>${entries.length} companies</span>
        </summary>
        <div class="company-grid">${entries.map(renderCompanyCard).join('')}</div>
      </details>
    `).join('');
}

function renderFilters() {
  if (!portals?.title_filter) return '';
  const titleFilter = portals.title_filter;
  return `
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <h3 style="font-size:14px;font-weight:600;color:var(--subtext);margin:0">Positive Keywords</h3>
        <button class="btn btn-ghost btn-sm" id="clear-positive-btn" ${(titleFilter.positive || []).length ? '' : 'disabled'} style="font-size:11px;color:var(--red)">Clear all</button>
      </div>
      <div class="tag-list">${(titleFilter.positive || []).map(keyword => `<span class="tag">${esc(keyword)}<span class="tag-remove" data-type="positive" data-keyword="${esc(keyword)}">&times;</span></span>`).join('')}</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <input class="form-input" id="add-positive" placeholder="Add keyword..." style="flex:1">
        <button class="btn btn-sm" id="add-positive-btn">Add</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <h3 style="font-size:14px;font-weight:600;color:var(--subtext);margin:0">Negative Keywords</h3>
        <button class="btn btn-ghost btn-sm" id="clear-negative-btn" ${(titleFilter.negative || []).length ? '' : 'disabled'} style="font-size:11px;color:var(--red)">Clear all</button>
      </div>
      <div class="tag-list">${(titleFilter.negative || []).map(keyword => `<span class="tag">${esc(keyword)}<span class="tag-remove" data-type="negative" data-keyword="${esc(keyword)}">&times;</span></span>`).join('')}</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <input class="form-input" id="add-negative" placeholder="Add keyword..." style="flex:1">
        <button class="btn btn-sm" id="add-negative-btn">Add</button>
      </div>
    </div>

    <div style="display:flex;justify-content:flex-end">
      <button class="btn btn-primary" id="save-filters">Save Filters</button>
    </div>
  `;
}

function renderSources() {
  const companyGroups = {};
  for (const company of portals?.tracked_companies || []) {
    const provider = inferProvider(company);
    if (!companyGroups[provider.key]) {
      companyGroups[provider.key] = { key: provider.key, label: provider.label, enabled: 0, total: 0 };
    }
    companyGroups[provider.key].total += 1;
    if (company.enabled !== false) companyGroups[provider.key].enabled += 1;
  }

  const queryGroups = {};
  for (const query of portals?.search_queries || []) {
    const source = sourceFromQueryName(query.name);
    const label = SOURCE_LABELS[source] || source || 'Other';
    if (!queryGroups[source]) queryGroups[source] = { key: source, label, enabled: 0, total: 0 };
    queryGroups[source].total += 1;
    if (query.enabled !== false) queryGroups[source].enabled += 1;
  }

  for (const source of ['linkedin', 'wellfound', 'ladders', 'remoteok', 'workable']) {
    if (!queryGroups[source]) queryGroups[source] = { key: source, label: SOURCE_LABELS[source], enabled: 0, total: 0 };
  }

  const sourceRow = (entry, kind, dataKind) => {
    const on = entry.enabled > 0;
    const detail = entry.total ? `${entry.enabled}/${entry.total} enabled` : 'No query configured';
    const toggleDisabled = entry.total === 0;
    return `
      <div class="source-row">
        <div>
          <strong>${esc(entry.label)}</strong>
          <span>${esc(kind)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <span class="source-status ${on ? 'on' : 'off'}">${on ? 'Enabled' : 'Disabled'} - ${esc(detail)}</span>
          <label class="toggle" title="${toggleDisabled ? 'No entries to toggle' : (on ? 'Disable all' : 'Enable all')}" style="${toggleDisabled ? 'opacity:0.4;pointer-events:none' : ''}">
            <input type="checkbox" class="source-enabled-toggle" data-source-kind="${esc(dataKind)}" data-source-key="${esc(entry.key)}" ${on ? 'checked' : ''} ${toggleDisabled ? 'disabled' : ''}>
            <span class="toggle-track"></span>
            <span class="toggle-thumb"></span>
          </label>
        </div>
      </div>
    `;
  };

  return `
    <div class="grid-2" style="gap:16px">
      <div class="card">
        <h3 style="font-size:14px;font-weight:600;color:var(--subtext);margin:0 0 12px 0">Company Portals</h3>
        <div class="source-list">
          ${Object.values(companyGroups).sort((a, b) => a.label.localeCompare(b.label)).map(entry => sourceRow(entry, 'Direct company scan', 'company')).join('')}
        </div>
      </div>
      <div class="card">
        <h3 style="font-size:14px;font-weight:600;color:var(--subtext);margin:0 0 12px 0">Job Boards</h3>
        <div class="source-list">
          ${Object.values(queryGroups).sort((a, b) => a.label.localeCompare(b.label)).map(entry => sourceRow(entry, 'Search query', 'query')).join('')}
        </div>
      </div>
    </div>
  `;
}

async function setSourceEnabled(kind, key, enabled, container) {
  if (!portals) return 0;
  let touched = 0;
  if (kind === 'company') {
    for (const company of portals.tracked_companies || []) {
      if (inferProvider(company).key === key && (company.enabled !== false) !== enabled) {
        company.enabled = enabled;
        touched += 1;
      }
    }
  } else if (kind === 'query') {
    for (const query of portals.search_queries || []) {
      if (sourceFromQueryName(query.name) === key && (query.enabled !== false) !== enabled) {
        query.enabled = enabled;
        touched += 1;
      }
    }
  }
  if (!touched) return 0;
  await api.updatePortals(portals);
  update(container);
  return touched;
}

function timeAgo(dateStr, future = false) {
  const diff = future ? new Date(dateStr) - Date.now() : Date.now() - new Date(dateStr);
  const abs = Math.abs(diff);
  if (abs < 60000) return future ? 'in less than a minute' : 'just now';
  if (abs < 3600000) { const minutes = Math.floor(abs / 60000); return future ? `in ${minutes}m` : `${minutes}m ago`; }
  if (abs < 86400000) { const hours = Math.floor(abs / 3600000); return future ? `in ${hours}h` : `${hours}h ago`; }
  const days = Math.floor(abs / 86400000);
  return future ? `in ${days}d` : `${days}d ago`;
}

async function loadCompanyMetrics() {
  // One batched call replaces what used to be N parallel per-company fetches
  // (each of which re-parsed scan-history.tsv + pipeline.md server-side).
  // Server route reads both files via the mtime cache, so back-to-back loads
  // skip the I/O entirely.
  try {
    const data = await api.getPortalsMetrics();
    companyMetrics = data.metrics || {};
  } catch {
    companyMetrics = {};
  }
}

const HEALTH_LABELS = {
  healthy: 'Healthy',
  empty: 'Empty',
  not_found: 'Not Found',
  redirected: 'Redirected',
  bot_blocked: 'Bot-blocked',
  unknown_ats: 'Unknown ATS',
  network_error: 'Network',
  no_provider: 'No Provider',
};

const HEALTH_SEVERITY = ['not_found', 'bot_blocked', 'no_provider', 'redirected', 'unknown_ats', 'network_error', 'empty', 'healthy'];

function renderHealthTools() {
  const summary = healthSnapshot?.summary || {};
  const lastRun = healthSnapshot?.finishedAt;
  const autoDisabledThisRun = Array.isArray(healthSnapshot?.autoDisabled) ? healthSnapshot.autoDisabled : [];
  const autoDisableThreshold = Number(healthSnapshot?.autoDisableThreshold) || 3;

  // Companies the scraper can't reach because of a WAF (Akamai/Cloudflare/etc.).
  // No URL fix will help — these need a human to open the careers page,
  // eyeball the jobs, and add interesting ones to the pipeline manually.
  const botBlockedCompanies = (healthSnapshot?.companies || [])
    .filter((c) => c.status === 'bot_blocked' && c.probedUrl);

  const summaryRow = HEALTH_SEVERITY.map((status) => {
    const count = summary[status] || 0;
    if (count === 0) return '';
    return `<span class="health-chip health-chip-${status}">${HEALTH_LABELS[status]}: ${count}</span>`;
  }).filter(Boolean).join('');

  const botBlockedCallout = botBlockedCompanies.length > 0 ? `
    <div class="bot-blocked-callout" style="margin-top:14px;padding:10px 12px;border-radius:var(--radius);background:rgba(243,139,168,0.08);border-left:3px solid var(--red);font-size:12px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="flex:1;min-width:200px;color:var(--text)">
          <strong>${botBlockedCompanies.length}</strong> compan${botBlockedCompanies.length === 1 ? 'y is' : 'ies are'} bot-blocked — no scraper can reach them.
          Open each careers page manually and add interesting roles to the pipeline.
        </span>
        <button class="btn btn-sm" id="bot-blocked-open-all-btn" style="white-space:nowrap">Open all in tabs (${botBlockedCompanies.length})</button>
        <button class="btn btn-sm btn-ghost" id="bot-blocked-toggle-btn">${botBlockedExpanded ? 'Hide list' : 'Show list'}</button>
      </div>
      ${botBlockedExpanded ? `
        <ul style="margin:10px 0 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;max-height:240px;overflow-y:auto">
          ${botBlockedCompanies.map((c) => `
            <li style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px;background:var(--surface0)">
              <span style="flex-shrink:0;min-width:160px;color:var(--text);font-weight:500">${esc(c.name)}</span>
              <a href="${esc(c.probedUrl)}" target="_blank" rel="noopener noreferrer" style="flex:1;min-width:0;color:var(--blue);text-decoration:none;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.probedUrl)} ↗</a>
            </li>
          `).join('')}
        </ul>
      ` : ''}
    </div>
  ` : '';

  const banner = autoDisabledThisRun.length
    ? `<div class="card" style="margin-bottom:8px;border-left:3px solid var(--yellow)">
         <p style="font-weight:600;margin-bottom:4px;font-size:13px">⚠ Auto-disabled ${autoDisabledThisRun.length} compan${autoDisabledThisRun.length === 1 ? 'y' : 'ies'}</p>
         <p style="font-size:12px;color:var(--subtext);margin:0">
           ${autoDisabledThisRun.map(esc).join(', ')} hit ${autoDisableThreshold} consecutive failed checks. Filter by Auto-disabled below to address them, or click "Find new URL" on the affected card.
         </p>
       </div>`
    : '';

  return `
    ${banner}
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;align-items:stretch;justify-content:space-between;gap:16px;flex-wrap:wrap">
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px">
          <h3 style="font-size:15px;font-weight:600;color:var(--text);margin:0;line-height:1.2">Health Tools</h3>
          <p style="font-size:12px;color:var(--subtext0);margin:0;line-height:1.4">
            ${lastRun
              ? `Last checked ${timeAgo(lastRun)}. Probes every enabled company's ATS endpoint without using agent credits.`
              : 'No checks run yet. Probes every enabled company\'s ATS endpoint without using agent credits.'}
          </p>
          ${summaryRow ? `<div class="health-summary" style="margin-top:auto">${summaryRow}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;align-items:stretch;min-width:200px">
          <button class="btn btn-secondary" id="health-check-all-btn" style="justify-content:center" ${healthChecking || fixBrokenLinksRunning ? 'disabled' : ''}>
            ${healthChecking ? '<span class="spinner"></span> Checking…' : 'Run Health Check All'}
          </button>
          <button class="btn btn-primary" id="fix-broken-links-btn" style="justify-content:center" ${healthChecking || fixBrokenLinksRunning ? 'disabled' : ''} title="Auto-recover careers_url for broken portals using JSON probes + Playwright network capture. No agent or API credits used.">
            ${fixBrokenLinksRunning
              ? `<span class="spinner"></span> ${fixBrokenLinksProgress?.label || 'Fixing…'}`
              : 'Fix Broken Links'}
          </button>
        </div>
      </div>
      ${botBlockedCallout}
      ${fixBrokenLinksRunning && fixBrokenLinksProgress ? `
        <div style="margin-top:10px;font-size:12px;color:var(--subtext0)">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px">
            <span>Phase ${fixBrokenLinksProgress.phase || 1} — ${fixBrokenLinksProgress.lastName || 'starting…'}</span>
            <span>${fixBrokenLinksProgress.done || 0}/${fixBrokenLinksProgress.total || 0} · ${fixBrokenLinksProgress.recovered || 0} recovered</span>
          </div>
          <div style="height:4px;background:var(--surface1);border-radius:2px;overflow:hidden">
            <div style="height:100%;width:${fixBrokenLinksProgress.total ? Math.round(100 * (fixBrokenLinksProgress.done || 0) / fixBrokenLinksProgress.total) : 0}%;background:var(--blue);transition:width 0.2s"></div>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

async function loadState() {
  const [portalsData, providersData, healthData] = await Promise.all([
    api.getPortals(),
    api.getPortalsProviders().catch(() => ({ providers: [] })),
    api.getHealthStatus().catch(() => ({ snapshot: null })),
  ]);
  portals = portalsData.portals;
  providerOptions = providersData.providers || [];
  healthSnapshot = healthData?.snapshot || null;
  await loadCompanyMetrics();
}

export async function render(container) {
  container.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
  try {
    await loadState();
  } catch {
    portals = null;
  }

  if (!portals) {
    container.innerHTML = '<div class="empty-state"><h3>No portals configured</h3><p>Complete onboarding to set up job portals.</p></div>';
    return;
  }

  update(container);
}

function update(container) {
  let body;
  if (activeTab === 'companies') body = `${renderHealthTools()}${renderCompanyToolbar()}${renderCompanyGrid()}`;
  else if (activeTab === 'sources') body = renderSources();
  else body = renderFilters();

  container.innerHTML = `
    ${renderCompaniesHeader()}
    <div class="portals-tab-row">
      <div class="filter-tabs">
        <button class="filter-tab${activeTab === 'companies' ? ' active' : ''}" data-tab="companies">Companies</button>
        <button class="filter-tab${activeTab === 'sources' ? ' active' : ''}" data-tab="sources">Sources</button>
        <button class="filter-tab${activeTab === 'filters' ? ' active' : ''}" data-tab="filters">Title Keywords</button>
      </div>
      <button class="btn btn-soft btn-sm" id="add-company-btn"><span style="font-weight:700">+</span> Add Company</button>
    </div>
    ${body}
  `;

  container.querySelectorAll('.filter-tab[data-tab]').forEach(button => {
    button.onclick = () => {
      activeTab = button.dataset.tab;
      update(container);
    };
  });

  // preserveFocus keeps the cursor in the search input across update()'s
  // full re-render — otherwise typing more than once de-focuses.
  container.querySelector('#company-search')?.addEventListener('input', (event) => {
    searchQuery = event.target.value;
    preserveFocus(container, () => update(container));
  });

  container.querySelector('#group-provider-toggle')?.addEventListener('change', (event) => {
    groupByProvider = event.target.checked;
    update(container);
  });

  container.querySelectorAll('[data-company-filter]').forEach(button => {
    button.onclick = () => {
      activeFilter = button.dataset.companyFilter;
      update(container);
    };
  });

  container.querySelectorAll('[data-industry]').forEach(button => {
    button.onclick = () => {
      const id = button.dataset.industry;
      if (industryFilter.has(id)) industryFilter.delete(id);
      else industryFilter.add(id);
      persistSet(INDUSTRY_FILTER_KEY, industryFilter);
      update(container);
    };
  });

  container.querySelectorAll('[data-health-status]').forEach(button => {
    button.onclick = () => {
      const id = button.dataset.healthStatus;
      if (healthFilter.has(id)) healthFilter.delete(id);
      else healthFilter.add(id);
      persistSet(HEALTH_FILTER_KEY, healthFilter);
      update(container);
    };
  });

  container.querySelector('#clear-industry-filter')?.addEventListener('click', () => {
    industryFilter.clear();
    persistSet(INDUSTRY_FILTER_KEY, industryFilter);
    update(container);
  });

  container.querySelector('#clear-health-filter')?.addEventListener('click', () => {
    healthFilter.clear();
    persistSet(HEALTH_FILTER_KEY, healthFilter);
    update(container);
  });

  container.querySelector('#bulk-enable-btn')?.addEventListener('click', () => bulkSetEnabled(true, container));
  container.querySelector('#bulk-disable-btn')?.addEventListener('click', () => bulkSetEnabled(false, container));

  container.querySelectorAll('.company-edit-url-btn').forEach(button => {
    button.onclick = async () => {
      const name = button.dataset.company;
      const company = portals?.tracked_companies?.find(c => c.name === name);
      if (!company) return;
      const result = await confirmModal({
        title: `Edit careers URL for ${name}`,
        body: `
          <p style="font-size:13px;color:var(--subtext);margin-bottom:8px">Update the URL we use to scan and health-check this company.</p>
          <input class="form-input" data-return="newUrl" autocomplete="off" spellcheck="false" autofocus value="${esc(company.careers_url || '')}" placeholder="https://...">
          <p style="font-size:12px;color:var(--subtext0);margin-top:8px">Saving runs a fresh health check on the new URL.</p>
        `,
        confirmText: 'Save URL',
      });
      if (!result) return;
      const newUrl = (result.data?.newUrl || '').trim();
      if (!newUrl || newUrl === company.careers_url) return;
      try {
        const updated = { ...company, careers_url: newUrl };
        // Adopting a manual URL invalidates any prior sniffer suggestions —
        // strip them so the card doesn't keep nagging.
        if (updated.health) {
          updated.health = { ...updated.health };
          delete updated.health.sniffed_candidates;
          delete updated.health.suggested_careers_url;
          delete updated.health.suggested_provider;
        }
        await api.updateCompany(name, updated);
        company.careers_url = newUrl;
        if (company.health) {
          delete company.health.sniffed_candidates;
          delete company.health.suggested_careers_url;
          delete company.health.suggested_provider;
        }
        toast(`${name}: URL updated, rechecking…`);
        try {
          const recheck = await api.recheckHealthCompany(name);
          if (healthSnapshot && Array.isArray(healthSnapshot.companies)) {
            const idx = healthSnapshot.companies.findIndex(c => c.name === name);
            if (idx >= 0) healthSnapshot.companies[idx] = recheck.result;
          }
        } catch { /* user can recheck manually */ }
        update(container);
      } catch (err) {
        toast(`Failed to update URL: ${err.message}`, 'error');
      }
    };
  });

  container.querySelector('#add-company-btn')?.addEventListener('click', async () => {
    try {
      const payload = await AddCompanyModal(providerOptions);
      if (!payload) return;
      await api.addCompany(payload);
      toast(`${payload.name} added`);
      await render(container);
    } catch (error) {
      toast(error.message || 'Failed to add company', 'error');
    }
  });

  container.querySelectorAll('.company-enabled-toggle').forEach(toggle => {
    toggle.onchange = async () => {
      try {
        await api.toggleCompany(toggle.dataset.company, toggle.checked);
        const match = portals.tracked_companies.find(company => company.name === toggle.dataset.company);
        if (match) match.enabled = toggle.checked;
        toast(`${toggle.dataset.company} ${toggle.checked ? 'enabled' : 'disabled'}`);
      } catch {
        toast('Failed to update', 'error');
        toggle.checked = !toggle.checked;
      }
    };
  });

  container.querySelectorAll('.source-enabled-toggle').forEach(toggle => {
    toggle.onchange = async () => {
      const kind = toggle.dataset.sourceKind;
      const key = toggle.dataset.sourceKey;
      const enabled = toggle.checked;
      try {
        const touched = await setSourceEnabled(kind, key, enabled, container);
        const noun = kind === 'company' ? 'companies' : 'queries';
        toast(`${enabled ? 'Enabled' : 'Disabled'} ${touched} ${key} ${noun}`);
      } catch (err) {
        toast(`Failed to update sources: ${err.message}`, 'error');
        toggle.checked = !enabled;
      }
    };
  });

  container.querySelectorAll('.company-deep-btn').forEach(button => {
    button.onclick = () => runModePrompt('deep', {
      company: button.dataset.company,
      url: button.dataset.url,
    });
  });

  container.querySelectorAll('.company-edit-btn').forEach(button => {
    button.onclick = async () => {
      const company = portals.tracked_companies.find(item => item.name === button.dataset.company);
      if (!company) return;
      try {
        const payload = await EditCompanyModal(company, providerOptions);
        if (!payload) return;
        await api.updateCompany(company.name, payload);
        toast(`${company.name} updated`);
        await render(container);
      } catch (error) {
        toast(error.message || 'Failed to update company', 'error');
      }
    };
  });

  container.querySelectorAll('.company-delete-btn').forEach(button => {
    button.onclick = async () => {
      const result = await confirmModal({
        title: `Delete ${button.dataset.company}?`,
        body: `<p style="font-size:14px;color:var(--subtext)">This removes the company from <code>portals.yml</code>. Scan history and reports stay untouched.</p>`,
        confirmText: 'Delete',
        danger: true,
      });
      if (!result) return;
      try {
        await api.deleteCompany(button.dataset.company);
        toast(`${button.dataset.company} deleted`);
        await render(container);
      } catch {
        toast('Failed to delete company', 'error');
      }
    };
  });

  container.querySelectorAll('.company-scan-btn').forEach(button => {
    button.onclick = async () => {
      const savedLimit = parseInt(localStorage.getItem(SCAN_LIMIT_KEY) || '0', 10) || 0;
      button.disabled = true;
      const original = button.textContent;
      button.textContent = 'Scanning...';
      try {
        const result = await api.scanCompany(button.dataset.company, savedLimit);
        if (result.success) {
          toast(`${button.dataset.company}: ${result.newOffers} new offer${result.newOffers !== 1 ? 's' : ''}`);
        } else {
          toast(result.error || `No scan support yet for ${button.dataset.company}`, 'error');
        }
        await render(container);
      } catch (error) {
        toast(error.message || 'Scan failed', 'error');
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    };
  });

  // Health Check (W1) — runs the per-company classifier and refreshes
  // the snapshot. Long-running (30-90s for ~16 companies), so we toggle
  // a flag and re-render to show a spinner.
  const healthCheckBtn = container.querySelector('#health-check-all-btn');
  if (healthCheckBtn) {
    healthCheckBtn.onclick = async () => {
      healthChecking = true;
      update(container);
      try {
        const res = await api.runHealthCheck();
        healthSnapshot = res?.snapshot || null;
        // After a check, portals.yml has been patched in place — reload
        // it so the in-memory copy reflects new health blocks and any
        // auto_disabled flips.
        try {
          const portalsData = await api.getPortals();
          if (portalsData?.portals) portals = portalsData.portals;
        } catch { /* non-fatal — UI uses stale portals if reload fails */ }
        const problems = (healthSnapshot?.companies || []).filter((c) => !['healthy', 'empty'].includes(c.status)).length;
        const autoDisabled = (healthSnapshot?.autoDisabled || []).length;
        if (autoDisabled > 0) {
          toast(`Health check done — ${autoDisabled} auto-disabled, ${problems} need attention`, 'error');
        } else {
          toast(problems
            ? `Health check done — ${problems} compan${problems === 1 ? 'y' : 'ies'} need attention`
            : 'Health check done — all healthy');
        }
      } catch (error) {
        toast(`Health check failed: ${error.message}`, 'error');
      } finally {
        healthChecking = false;
        update(container);
      }
    };
  }

  // Fix Broken Links — agent-agnostic bulk recovery. Spawns the Node
  // healthcheck script server-side and streams progress via SSE.
  const fixBrokenBtn = container.querySelector('#fix-broken-links-btn');
  if (fixBrokenBtn) {
    fixBrokenBtn.onclick = async () => {
      const brokenCount = (healthSnapshot?.companies || [])
        .filter((c) => !['healthy', 'empty'].includes(c.status)).length;
      if (brokenCount === 0) {
        toast('No broken portals to fix — everything is healthy.', 'success');
        return;
      }
      const etaMin = Math.max(2, Math.ceil(brokenCount * 0.08));
      const ok = await confirmModal({
        title: 'Fix Broken Links',
        confirmText: `Run on ${brokenCount} broken`,
        body: `
          <p style="font-size:14px;color:var(--text);margin-bottom:10px">
            Tries to auto-recover the <strong>careers_url</strong> for every broken portal in your latest health check.
          </p>
          <p style="font-size:13px;color:var(--subtext);margin-bottom:8px">How it works (no agent credits used):</p>
          <ul style="font-size:13px;color:var(--subtext);margin:0 0 12px 18px;padding:0">
            <li><strong>Phase 1</strong> — Probes Greenhouse / Ashby / Lever JSON APIs with slug variants derived from the company name.</li>
            <li><strong>Phase 2</strong> — Launches a headless browser, captures the page's network traffic, and matches XHRs/iframes against known ATS hosts (Workday, SmartRecruiters, Phenom, etc.).</li>
          </ul>
          <p style="font-size:13px;color:var(--yellow);margin-bottom:8px">
            ⚠ Expected runtime: <strong>~${etaMin} minute${etaMin === 1 ? '' : 's'}</strong> for ${brokenCount} broken portals.
            Phase 2 uses Playwright and takes ~3–10 seconds per company.
          </p>
          <p style="font-size:12px;color:var(--subtext0);margin:0">
            Proposed URL changes are written to <code>portals.yml</code> automatically.
            Companies without a recoverable ATS (custom in-house boards) are left untouched.
            You can re-run "Run Health Check All" afterwards to confirm the fixes worked.
          </p>
        `,
      });
      if (!ok) return;

      fixBrokenLinksRunning = true;
      fixBrokenLinksProgress = { label: 'Starting…', phase: 1, done: 0, total: brokenCount, recovered: 0, lastName: '' };
      update(container);

      try {
        // Note: raw fetch (not via api.mjs `request()`) because we need
        // SSE streaming, not a JSON response. Have to manually prefix the
        // /api/v1 mount point and pass credentials so the session cookie
        // rides along — the auth gate rejects calls that miss either.
        const res = await fetch('/api/v1/health/fix-broken-links', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'text/event-stream' },
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || `HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalRecovered = 0;
        let finalApplied = 0;
        let lastRenderAt = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE frames are separated by blank lines (\n\n).
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            let evt;
            try { evt = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
            if (evt.event === 'phase_start') {
              fixBrokenLinksProgress.phase = evt.phase;
              fixBrokenLinksProgress.total = evt.total;
              fixBrokenLinksProgress.done = 0;
              fixBrokenLinksProgress.label = `Phase ${evt.phase}…`;
            } else if (evt.event === 'company_done') {
              fixBrokenLinksProgress.done = evt.done;
              fixBrokenLinksProgress.total = evt.total;
              fixBrokenLinksProgress.lastName = evt.name;
              if (evt.recovered) fixBrokenLinksProgress.recovered += 1;
              fixBrokenLinksProgress.label = `Phase ${evt.phase}`;
            } else if (evt.event === 'apply_start') {
              fixBrokenLinksProgress.label = 'Applying to portals.yml…';
            } else if (evt.event === 'done') {
              finalRecovered = evt.recovered;
              finalApplied = evt.applied;
            } else if (evt.event === 'error') {
              throw new Error(`Step ${evt.step} failed (exit ${evt.exitCode}): ${evt.detail || ''}`);
            }
            // Throttle re-renders so a fast stream doesn't thrash the DOM.
            const now = Date.now();
            if (now - lastRenderAt > 250) {
              update(container);
              lastRenderAt = now;
            }
          }
        }

        toast(
          finalApplied > 0
            ? `Fixed ${finalApplied} broken portal${finalApplied === 1 ? '' : 's'} (${finalRecovered} recovered, ${finalRecovered - finalApplied} skipped)`
            : 'No recoverable portals — remaining broken sites need manual review',
        );

        // Reload portals so the new careers_urls show up in the table.
        try {
          const portalsData = await api.getPortals();
          if (portalsData?.portals) portals = portalsData.portals;
        } catch { /* non-fatal */ }
      } catch (err) {
        toast(`Fix Broken Links failed: ${err.message}`, 'error');
      } finally {
        fixBrokenLinksRunning = false;
        fixBrokenLinksProgress = null;
        update(container);
      }
    };
  }

  // Bot-blocked digest — "Show list" toggle + "Open all in tabs" bulk action.
  const botBlockedToggle = container.querySelector('#bot-blocked-toggle-btn');
  if (botBlockedToggle) {
    botBlockedToggle.onclick = () => {
      botBlockedExpanded = !botBlockedExpanded;
      update(container);
    };
  }
  const botBlockedOpenAll = container.querySelector('#bot-blocked-open-all-btn');
  if (botBlockedOpenAll) {
    botBlockedOpenAll.onclick = async () => {
      const urls = (healthSnapshot?.companies || [])
        .filter((c) => c.status === 'bot_blocked' && c.probedUrl)
        .map((c) => c.probedUrl);
      if (urls.length === 0) return;
      // Confirm before spawning a deluge — most browsers also pop-up-block
      // bulk window.open calls, but the confirm gives the user a chance to
      // cancel before the browser does it for them.
      if (urls.length > 5) {
        const ok = await confirmModal({
          title: `Open ${urls.length} tabs?`,
          confirmText: `Open ${urls.length} tabs`,
          body: `
            <p style="font-size:14px;color:var(--text);margin-bottom:8px">
              You're about to open ${urls.length} careers pages in new tabs. Your browser may pop-up-block all but the first if it doesn't trust the action.
            </p>
            <p style="font-size:12px;color:var(--subtext0);margin:0">
              Tip: if you only want a quick batch, click "Show list" and open them one at a time.
            </p>
          `,
        });
        if (!ok) return;
      }
      for (const url of urls) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      toast(`Opened ${urls.length} careers page${urls.length === 1 ? '' : 's'} — review and add interesting roles to the pipeline.`);
    };
  }

  container.querySelectorAll('.health-recheck-btn').forEach((btn) => {
    btn.onclick = async () => {
      const name = btn.dataset.company;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const res = await api.recheckHealthCompany(name);
        // Patch the in-memory snapshot so the row updates immediately.
        if (healthSnapshot && Array.isArray(healthSnapshot.companies)) {
          const idx = healthSnapshot.companies.findIndex((c) => c.name === name);
          if (idx >= 0) healthSnapshot.companies[idx] = res.result;
        } else {
          // Refetch if we don't have a snapshot yet.
          const full = await api.getHealthStatus();
          healthSnapshot = full?.snapshot || null;
        }
        toast(`${name}: ${res.result.status}`);
        update(container);
      } catch (error) {
        toast(`Recheck failed: ${error.message}`, 'error');
        btn.disabled = false;
        btn.textContent = 'Recheck';
      }
    };
  });

  // W8 — URL recovery for auto-disabled companies. Runs lib/discovery
  // scoped to one name (WebSearch + sniff + health + role-fit), then
  // proposes the resolved URL with role-fit context. Acceptance writes
  // the new URL, re-enables the company, and clears the auto-disable
  // state so the next health check has a fresh window.
  container.querySelectorAll('.health-recover-btn').forEach((btn) => {
    btn.onclick = async () => {
      const name = btn.dataset.company;
      btn.disabled = true;
      btn.textContent = 'Searching…';
      try {
        const res = await api.recoverHealthCompany(name);
        if (!res?.proposed_url) {
          toast(`No working URL found for ${name}. The agent couldn't resolve a careers page that returns relevant postings.`, 'error');
          return;
        }
        const sameAsBefore = res.proposed_url === res.old_url;
        const roleFitNote = (() => {
          if (res.role_fit === 'matches') {
            const m = res.role_fit_meta || {};
            return `<span style="color:var(--green)">${m.matchCount || '?'} of ${m.totalSampled || '?'} sample postings match your title filter.</span>`;
          }
          if (res.role_fit === 'no_current_matches') return '<span style="color:var(--yellow)">Page is up but no current postings match your title filter.</span>';
          if (res.role_fit === 'empty') return '<span style="color:var(--yellow)">Page returned no postings — possibly a hiring freeze.</span>';
          return '';
        })();
        const confidenceBadge = res.verify_confidence
          ? `<span style="font-size:11px;color:var(--subtext0);margin-left:6px">[${esc(res.verify_confidence)} confidence]</span>`
          : '';
        const ok = await confirmModal({
          title: sameAsBefore ? `${name}: same URL — verify only?` : `Update ${name}'s careers URL?`,
          body: `
            ${res.old_url ? `<p style="font-size:13px;color:var(--subtext);margin-bottom:6px">From: <code>${esc(res.old_url)}</code></p>` : ''}
            <p style="font-size:13px;color:var(--subtext);margin-bottom:6px">${sameAsBefore ? 'Same URL:' : 'To:'} <code>${esc(res.proposed_url)}</code>${confidenceBadge}</p>
            ${res.provider ? `<p style="font-size:12px;color:var(--subtext0);margin-bottom:10px">Provider: ${esc(res.provider)}</p>` : ''}
            ${roleFitNote ? `<p style="font-size:13px;margin-bottom:10px">${roleFitNote}</p>` : ''}
            ${res.verify_notes ? `<p style="font-size:12px;color:var(--subtext0);font-style:italic">"${esc(res.verify_notes)}"</p>` : ''}
            <p style="font-size:12px;color:var(--subtext0);margin-top:10px">Accepting writes the new URL, clears <code>auto_disabled</code>, and resets the failure counter.</p>
          `,
          confirmText: sameAsBefore ? 'Re-enable as-is' : 'Update URL',
        });
        if (!ok) return;
        await api.acceptHealthRecovery(name, res.proposed_url);
        toast(`${name}: URL updated. Re-running health check…`);
        // Refresh portals + run a fresh recheck so the row updates.
        try {
          const portalsData = await api.getPortals();
          if (portalsData?.portals) portals = portalsData.portals;
        } catch { /* non-fatal */ }
        try {
          const recheck = await api.recheckHealthCompany(name);
          if (healthSnapshot && Array.isArray(healthSnapshot.companies)) {
            const idx = healthSnapshot.companies.findIndex((c) => c.name === name);
            if (idx >= 0) healthSnapshot.companies[idx] = recheck.result;
          }
        } catch { /* user can recheck manually */ }
        update(container);
      } catch (error) {
        toast(`Recovery failed: ${error.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Find new URL';
      }
    };
  });

  // W5 — adopt sniffer suggestion: write the candidate URL back to
  // careers_url in portals.yml and re-run the health check so the
  // dashboard reflects the new state immediately.
  container.querySelectorAll('.health-sniff-adopt-btn').forEach((btn) => {
    btn.onclick = async () => {
      const name = btn.dataset.company;
      const url = btn.dataset.url;
      const ok = await confirmModal({
        title: `Update ${name}'s careers URL?`,
        body: `<p style="font-size:14px;color:var(--subtext);margin-bottom:8px">Sets <code>careers_url</code> for <strong>${esc(name)}</strong> to:</p><p style="font-size:13px;font-family:monospace;color:var(--text);word-break:break-all">${esc(url)}</p><p style="font-size:13px;color:var(--subtext0);margin-top:8px">Then runs a health check on the new URL to confirm it works.</p>`,
        confirmText: 'Update & recheck',
      });
      if (!ok) return;

      btn.disabled = true;
      btn.textContent = 'Updating…';
      try {
        // Locate the company in our in-memory portals config and patch
        // careers_url. Reuse the existing per-company endpoint so we
        // don't need a new route on the server.
        const target = portals?.tracked_companies?.find((c) => c.name === name);
        if (!target) throw new Error(`Company "${name}" not found in portals.yml`);
        const updated = { ...target, careers_url: url };
        // Adopting a suggestion implies the user accepts it as authoritative —
        // clear stale sniffer metadata so the row stops nagging on next render.
        if (updated.health) {
          updated.health = { ...updated.health };
          delete updated.health.sniffed_candidates;
          delete updated.health.suggested_careers_url;
          delete updated.health.suggested_provider;
        }
        await api.updateCompany(name, updated);
        target.careers_url = url;
        if (target.health) {
          delete target.health.sniffed_candidates;
          delete target.health.suggested_careers_url;
          delete target.health.suggested_provider;
        }

        // Recheck so the snapshot reflects the new URL.
        const res = await api.recheckHealthCompany(name);
        if (healthSnapshot && Array.isArray(healthSnapshot.companies)) {
          const idx = healthSnapshot.companies.findIndex((c) => c.name === name);
          if (idx >= 0) healthSnapshot.companies[idx] = res.result;
        }
        toast(`${name}: careers_url updated → ${res.result.status}`);
        update(container);
      } catch (error) {
        toast(`Update failed: ${error.message}`, 'error');
        btn.disabled = false;
        btn.textContent = 'Use this URL';
      }
    };
  });

  container.querySelectorAll('.tag-remove').forEach(button => {
    button.onclick = () => {
      const type = button.dataset.type;
      const keyword = button.dataset.keyword;
      portals.title_filter[type] = portals.title_filter[type].filter(item => item !== keyword);
      update(container);
    };
  });

  const addKeyword = (type, inputSelector) => {
    const input = container.querySelector(inputSelector);
    if (!input) return;
    const value = input.value.trim();
    if (value && !portals.title_filter[type].includes(value)) {
      portals.title_filter[type].push(value);
      update(container);
    }
  };

  container.querySelector('#add-positive-btn')?.addEventListener('click', () => addKeyword('positive', '#add-positive'));
  container.querySelector('#add-negative-btn')?.addEventListener('click', () => addKeyword('negative', '#add-negative'));
  container.querySelector('#add-positive')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') addKeyword('positive', '#add-positive'); });
  container.querySelector('#add-negative')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') addKeyword('negative', '#add-negative'); });

  container.querySelector('#save-filters')?.addEventListener('click', async () => {
    try {
      await api.updateFilters(portals.title_filter);
      toast('Filters saved');
    } catch {
      toast('Failed to save', 'error');
    }
  });

  const clearKeywords = async (type) => {
    const count = (portals.title_filter?.[type] || []).length;
    if (!count) return;
    const ok = await confirmModal({
      title: `Clear all ${type} keywords?`,
      body: `<p style="font-size:14px;color:var(--subtext)">This will remove all <strong>${count}</strong> ${type} keywords from your filter list.</p>`,
      confirmText: 'Clear all',
      danger: true,
    });
    if (!ok) return;
    portals.title_filter[type] = [];
    try {
      await api.updateFilters(portals.title_filter);
      toast(`Cleared ${count} ${type} keyword${count !== 1 ? 's' : ''}`);
      update(container);
    } catch {
      toast('Failed to save', 'error');
    }
  };

  container.querySelector('#clear-positive-btn')?.addEventListener('click', () => clearKeywords('positive'));
  container.querySelector('#clear-negative-btn')?.addEventListener('click', () => clearKeywords('negative'));
}
