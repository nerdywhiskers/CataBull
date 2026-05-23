import { api } from '../api.mjs';
import { renderMarkdown } from '../components/markdown.mjs';
import { render as renderMemoryView } from './memory.mjs';

const SUB_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'memory', label: 'Memory' },
];

function renderAnalyticsTabs(activeKey) {
  return `<div class="filter-tabs analytics-subtabs" style="margin-bottom:16px">${SUB_TABS.map(t =>
    `<button class="filter-tab${activeKey === t.key ? ' active' : ''}" data-analytics-tab="${t.key}">${t.label}</button>`
  ).join('')}</div>`;
}

export async function render(container, subTab) {
  const tab = subTab === 'memory' ? 'memory' : 'overview';
  const subtitle = tab === 'memory'
    ? 'Patterns and notes CataBull has saved across sessions.'
    : 'Funnel, response rates, archetype performance, and follow-up cadence over time.';
  container.innerHTML = `
    <header class="section-header">
      <div>
        <h1 class="section-title">Analytics</h1>
        <p class="section-sub">${subtitle}</p>
      </div>
    </header>
    ${renderAnalyticsTabs(tab)}
    <div id="analytics-content"></div>
  `;
  const contentEl = container.querySelector('#analytics-content');

  container.querySelectorAll('[data-analytics-tab]').forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.analyticsTab;
      window.location.hash = key === 'memory' ? '#/analytics/memory' : '#/analytics';
    };
  });

  if (tab === 'memory') {
    await renderMemoryView(contentEl);
  } else {
    await renderOverview(contentEl);
  }
}

const TIME_RANGES = [
  { key: 'all', label: 'All time' },
  { key: '30d', label: 'Last 30 days' },
  { key: '7d', label: 'Last 7 days' },
];

let currentTimeRange = 'all';

const FUNNEL_COLORS = ['var(--blue)', 'var(--sky)', 'var(--teal)', 'var(--green)', 'var(--yellow)'];
const SCORE_COLORS = ['var(--green)', 'var(--sky)', 'var(--yellow)', 'var(--peach)', 'var(--red)'];
const RATE_COLORS = { green: 30, yellow: 15, peach: 5 };

function rateColor(val) {
  if (val >= 30) return 'var(--green)';
  if (val >= 15) return 'var(--yellow)';
  if (val >= 5) return 'var(--peach)';
  return 'var(--red)';
}

function barChart(items, colors, maxVal) {
  if (!maxVal) maxVal = Math.max(...items.map(i => i.count), 1);
  return `<div class="bar-chart">${items.map((item, i) => {
    const pct = (item.count / maxVal) * 100;
    const color = typeof colors === 'function' ? colors(i) : (colors[i] || 'var(--blue)');
    return `<div class="bar-row">
      <span class="bar-label">${item.label}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(pct, 1)}%;background:${color}"></div></div>
      <span class="bar-value">${item.count}${item.pct !== undefined ? ` (${item.pct.toFixed(0)}%)` : ''}</span>
    </div>`;
  }).join('')}</div>`;
}

function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function urgencyTone(urgency) {
  if (urgency === 'urgent') return 'red';
  if (urgency === 'overdue') return 'yellow';
  if (urgency === 'waiting') return 'green';
  return 'muted';
}

function renderPanelError(title, message) {
  return `
    <div class="card analytics-panel">
      <div class="analytics-panel-header">
        <h3>${title}</h3>
      </div>
      <p class="analytics-panel-empty">${esc(message)}</p>
    </div>
  `;
}

function renderPatternsCard(patterns) {
  if (!patterns || patterns.error) {
    return renderPanelError('Patterns', patterns?.error || 'Pattern analysis is unavailable right now.');
  }

  const blockers = (patterns.blockerAnalysis || []).slice(0, 5).map((item) => ({
    label: item.blocker.replace(/-/g, ' '),
    count: item.frequency,
    pct: item.percentage,
  }));
  const recommendations = (patterns.recommendations || []).slice(0, 3);

  return `
    <div class="card analytics-panel">
      <div class="analytics-panel-header">
        <div>
          <h3>Patterns</h3>
          <p>${patterns.metadata?.negative || patterns.metadata?.byOutcome?.negative || 0} negative outcomes analyzed</p>
        </div>
      </div>
      ${blockers.length ? `
        <div style="margin-bottom:16px">
          ${barChart(blockers, ['var(--red)', 'var(--peach)', 'var(--yellow)', 'var(--mauve)', 'var(--sky)'], Math.max(...blockers.map((item) => item.count), 1))}
        </div>
      ` : '<p class="analytics-panel-empty">No blocker patterns detected yet.</p>'}
      ${recommendations.length ? `
        <div class="analytics-list">
          ${recommendations.map((item) => `
            <div class="analytics-list-item">
              <span class="analytics-chip ${esc(item.impact || 'medium')}">${esc(item.impact || 'medium')}</span>
              <div>
                <strong>${esc(item.action)}</strong>
                <p>${esc(item.reasoning)}</p>
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderFollowupCard(followup) {
  if (!followup || followup.error) {
    return renderPanelError('Follow-up Urgency', followup?.error || 'Follow-up analysis is unavailable right now.');
  }

  const rows = (followup.entries || []).slice(0, 8);
  const metadata = followup.metadata || {};

  return `
    <div class="card analytics-panel">
      <div class="analytics-panel-header">
        <div>
          <h3>Follow-up Urgency</h3>
          <p>${metadata.actionable || 0} active applications in cadence tracking</p>
        </div>
      </div>
      <div class="analytics-summary">
        <span class="analytics-chip red">${metadata.urgent || 0} urgent</span>
        <span class="analytics-chip yellow">${metadata.overdue || 0} overdue</span>
        <span class="analytics-chip green">${metadata.waiting || 0} waiting</span>
        <span class="analytics-chip muted">${metadata.cold || 0} cold</span>
      </div>
      ${rows.length ? `
        <div class="analytics-table-wrap">
          <table class="data-table analytics-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Status</th>
                <th>Days</th>
                <th>Next</th>
                <th>Urgency</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((row) => `
                <tr>
                  <td>
                    <div style="font-weight:600">${esc(row.company)}</div>
                    <div style="font-size:12px;color:var(--subtext)">${esc(row.role)}</div>
                  </td>
                  <td>${esc(row.status)}</td>
                  <td>${row.daysSinceApplication}</td>
                  <td>${esc(row.nextFollowupDate || '—')}</td>
                  <td><span class="analytics-chip ${urgencyTone(row.urgency)}">${esc(row.urgency)}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<p class="analytics-panel-empty">No active follow-ups to track yet.</p>'}
    </div>
  `;
}

async function renderOverview(container) {
  container.innerHTML = '<div class="empty-state"><p>Loading analytics...</p></div>';
  let metricsData;
  let patternsData = null;
  let followupData = null;
  try {
    [metricsData, patternsData, followupData] = await Promise.all([
      api.getMetrics(),
      api.getPatternsMetrics().catch((error) => ({ error: error.message })),
      api.getFollowupMetrics().catch((error) => ({ error: error.message })),
    ]);
  } catch {
    container.innerHTML = '<div class="empty-state"><h3>No data yet</h3><p>Evaluate some offers to see analytics.</p></div>';
    return;
  }

  const { pipeline, progress } = metricsData;
  if (!pipeline || pipeline.total === 0) {
    container.innerHTML = `
      <div class="grid-2" style="margin-bottom:24px">
        ${renderPatternsCard(patternsData)}
        ${renderFollowupCard(followupData)}
      </div>
      <div class="empty-state"><h3>No tracker analytics yet</h3><p>Evaluate some offers to see funnel and score analytics here.</p></div>
    `;
    return;
  }

  // Filter by time range
  const now = Date.now();
  const dayMs = 86400000;
  const cutoff = currentTimeRange === '30d' ? now - 30 * dayMs : currentTimeRange === '7d' ? now - 7 * dayMs : 0;

  function isRecent(dateStr) {
    if (!dateStr) return true; // no date = include all
    const d = new Date(dateStr).getTime();
    return cutoff === 0 || d >= cutoff;
  }

  // Filter funnel stages by time range
  const filteredFunnel = progress.funnelStages.map(s => ({
    ...s,
    count: currentTimeRange === 'all' ? s.count : Math.max(0, s.count - (cutoff > 0 ? apps.filter(a => !isRecent(a.date)).length : 0)),
  }));

  // Filter weekly activity
  const filteredWeekly = cutoff === 0
    ? progress.weeklyActivity
    : progress.weeklyActivity.filter(w => {
        const weekStart = new Date(w.week + '-01T00:00:00').getTime();
        return weekStart >= cutoff;
      });

  container.innerHTML = `
    <div class="analytics-subtoolbar">
      <div class="analytics-range-group">
        ${TIME_RANGES.map(tr => `
          <button class="btn btn-sm${currentTimeRange === tr.key ? ' btn-primary' : ''}" data-time-range="${tr.key}">${tr.label}</button>
        `).join('')}
      </div>
      <span class="analytics-total">${pipeline.total} total offers evaluated</span>
    </div>

    <div class="grid-4" style="margin-bottom:24px">
      <div class="stat-card">
        <div class="stat-label">Total Evaluated</div>
        <div class="stat-value">${pipeline.total}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg Score</div>
        <div class="stat-value" style="color:${pipeline.avgScore >= 4 ? 'var(--green)' : pipeline.avgScore >= 3.5 ? 'var(--yellow)' : 'var(--peach)'}">${pipeline.avgScore.toFixed(1)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active</div>
        <div class="stat-value">${pipeline.actionable}</div>
        <div class="stat-sub">Not skipped/rejected</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">PDFs Generated</div>
        <div class="stat-value">${pipeline.withPdf}</div>
      </div>
    </div>

    <div class="grid-2" style="margin-bottom:24px">
      <div class="card">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:16px;color:var(--subtext)">Pipeline Funnel</h3>
        ${barChart(progress.funnelStages.map(s => ({ label: s.label, count: s.count, pct: s.pct })), FUNNEL_COLORS, progress.funnelStages[0]?.count || 1)}
      </div>
      <div class="card">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:16px;color:var(--subtext)">Score Distribution</h3>
        ${barChart(progress.scoreBuckets, SCORE_COLORS, Math.max(...progress.scoreBuckets.map(b => b.count), 1))}
      </div>
    </div>

    <div class="grid-3" style="margin-bottom:24px">
      <div class="stat-card">
        <div class="stat-label">Response Rate</div>
        <div class="stat-value" style="color:${rateColor(progress.responseRate)}">${progress.responseRate.toFixed(1)}%</div>
        <div class="stat-sub">Responded / Applied</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Interview Rate</div>
        <div class="stat-value" style="color:${rateColor(progress.interviewRate)}">${progress.interviewRate.toFixed(1)}%</div>
        <div class="stat-sub">Interview / Applied</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Offer Rate</div>
        <div class="stat-value" style="color:${rateColor(progress.offerRate)}">${progress.offerRate.toFixed(1)}%</div>
        <div class="stat-sub">Offer / Applied</div>
      </div>
    </div>

    <div class="grid-2" style="margin-bottom:24px">
      ${renderPatternsCard(patternsData)}
      ${renderFollowupCard(followupData)}
    </div>

    ${filteredWeekly.length > 0 ? `
    <div class="card" style="margin-bottom:24px">
      <h3 style="font-size:14px;font-weight:600;margin-bottom:16px;color:var(--subtext)">Weekly Activity</h3>
      ${barChart(filteredWeekly.map(w => ({ label: w.week, count: w.count })), () => 'var(--lavender)', Math.max(...filteredWeekly.map(w => w.count), 1))}
    </div>` : ''}

    <div id="reports-section"></div>
  `;

  // Load reports into the section
  loadReports(container.querySelector('#reports-section'));

  // Time range buttons
  container.querySelectorAll('[data-time-range]').forEach(btn => {
    btn.onclick = () => {
      currentTimeRange = btn.dataset.timeRange;
      renderOverview(container);
    };
  });
}

async function loadReports(section) {
  let reportsList = [];
  try {
    const data = await api.getReports();
    reportsList = data.reports || [];
  } catch { /* ok */ }

  if (!reportsList.length) return;

  section.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <h3 style="font-size:14px;font-weight:600;color:var(--subtext)">Reports</h3>
      <span style="font-size:12px;color:var(--subtext0)">${reportsList.length} reports</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px" id="reports-list">
      ${reportsList.map(r => `
        <div class="card report-card" data-filename="${r.filename}" style="cursor:pointer;padding:12px 16px;display:flex;align-items:center;gap:16px;transition:background var(--transition)">
          <span style="font-weight:600;color:var(--subtext0);width:40px;font-size:13px">#${r.number}</span>
          <div style="flex:1">
            <div style="font-weight:500">${esc(r.slug.replace(/-/g, ' '))}</div>
            <div style="font-size:12px;color:var(--subtext)">${r.date}${r.archetype ? ` \u00B7 ${esc(r.archetype)}` : ''}</div>
          </div>
          ${r.tldr ? `<div style="flex:1;font-size:12px;color:var(--subtext);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.tldr)}</div>` : ''}
          <span style="font-size:12px;color:var(--subtext0)">\u25B6</span>
        </div>
      `).join('')}
    </div>
    <div id="report-viewer" style="display:none;margin-top:16px"></div>
  `;

  section.querySelectorAll('.report-card').forEach(card => {
    card.onmouseenter = () => card.style.background = 'var(--surface1)';
    card.onmouseleave = () => card.style.background = '';
    card.onclick = async () => {
      const viewer = section.querySelector('#report-viewer');
      const list = section.querySelector('#reports-list');
      try {
        const data = await api.getReport(card.dataset.filename);
        list.style.display = 'none';
        viewer.style.display = 'block';
        viewer.innerHTML = `
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <button class="btn btn-sm" id="back-to-list">\u2190 Back</button>
            <span style="font-size:13px;color:var(--subtext)">${card.dataset.filename}</span>
          </div>
          <div class="card markdown-body" style="padding:24px 32px">${renderMarkdown(data.raw)}</div>
        `;
        viewer.querySelector('#back-to-list').onclick = () => {
          viewer.style.display = 'none';
          list.style.display = 'flex';
        };
      } catch { /* ok */ }
    };
  });
}
