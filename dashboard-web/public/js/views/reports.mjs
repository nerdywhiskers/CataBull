import { api } from '../api.mjs';
import { renderMarkdown } from '../components/markdown.mjs';

let reportsList = [];
let viewingReport = null;

function scoreClass(archetype) {
  // Extract score from archetype if possible, otherwise just style it
  return 'evaluated'; // fallback badge class
}

function renderList(container) {
  if (!reportsList.length) {
    container.innerHTML = '<div class="empty-state"><h3>No reports yet</h3><p>Evaluate a job offer to generate a report.</p></div>';
    return;
  }

  container.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">Reports</h2>
      <span style="font-size:13px;color:var(--subtext)">${reportsList.length} reports</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${reportsList.map(r => `
        <div class="card report-card" data-filename="${r.filename}" style="cursor:pointer;padding:14px 20px;display:flex;align-items:center;gap:16px;transition:background var(--transition)">
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
  `;

  container.querySelectorAll('.report-card').forEach(card => {
    card.onmouseenter = () => card.style.background = 'var(--surface1)';
    card.onmouseleave = () => card.style.background = '';
    card.onclick = () => {
      window.location.hash = `#/reports/${card.dataset.filename}`;
    };
  });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatIcon(format) {
  if (format === 'pdf') return '\u{1F4C4}';      // \ud83d\udcc4
  if (format === 'html') return '\u{1F310}';     // \ud83c\udf10
  return '\u{1F4DD}';                            // \ud83d\udcdd
}

function renderArtifacts(artifacts) {
  if (!artifacts || !artifacts.length) return '';
  const links = artifacts.map(a => `
    <a class="btn btn-sm" href="/api/v1/cv/download?path=${encodeURIComponent(a.path)}" download style="text-decoration:none;display:inline-flex;align-items:center;gap:6px">
      <span>${formatIcon(a.format)}</span>
      <span>${esc(a.name)}</span>
      <span style="font-size:11px;color:var(--subtext0)">(${formatBytes(a.size)})</span>
    </a>
  `).join('');
  return `
    <div class="card" style="margin-bottom:16px;background:var(--surface0)">
      <h3 style="font-size:13px;font-weight:600;color:var(--subtext);margin-bottom:10px">Generated artifacts</h3>
      <div style="display:flex;flex-wrap:wrap;gap:8px">${links}</div>
    </div>
  `;
}

async function renderReport(container, filename) {
  container.innerHTML = '<div class="empty-state"><p>Loading report...</p></div>';
  try {
    const data = await api.getReport(filename);
    container.innerHTML = `
      <div class="section-header">
        <button class="btn btn-sm" id="back-to-reports">\u2190 Back</button>
        <span style="font-size:13px;color:var(--subtext)">${filename}</span>
      </div>
      ${renderArtifacts(data.artifacts)}
      <div class="card markdown-body" style="padding:24px 32px">
        ${renderMarkdown(data.raw)}
      </div>
    `;
    container.querySelector('#back-to-reports').onclick = () => {
      window.location.hash = '#/reports';
    };
  } catch {
    container.innerHTML = '<div class="empty-state"><h3>Report not found</h3></div>';
  }
}

function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export async function render(container, filename) {
  if (filename) {
    await renderReport(container, filename);
    return;
  }

  container.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
  try {
    const data = await api.getReports();
    reportsList = data.reports || [];
  } catch { reportsList = []; }

  renderList(container);
}
