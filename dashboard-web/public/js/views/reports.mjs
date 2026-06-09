import { api } from '../api.mjs';
import { renderMarkdown } from '../components/markdown.mjs';

let reportsList = [];
let reportsSearch = '';

function scoreClass(archetype) {
  // Extract score from archetype if possible, otherwise just style it
  return 'evaluated'; // fallback badge class
}

function filteredReports() {
  const query = reportsSearch.trim().toLowerCase();
  if (!query) return reportsList;
  return reportsList.filter((report) => {
    const haystack = [report.filename, report.slug, report.date, report.archetype, report.tldr]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

function renderList(container, archivedCount = 0) {
  const visibleReports = filteredReports();
  if (!reportsList.length) {
    container.innerHTML = '<div class="empty-state"><h3>No reports yet</h3><p>Evaluate a job offer to generate a report.</p></div>';
    return;
  }

  container.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">Reports</h2>
      <span style="font-size:13px;color:var(--subtext)">${reportsList.length} active${archivedCount ? ` · ${archivedCount} archived` : ''}</span>
    </div>
    <div class="card" style="margin-bottom:16px;padding:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <input id="reports-search" class="form-input" type="search" placeholder="Search reports by company, archetype, date, or TL;DR" value="${esc(reportsSearch)}" style="flex:1;min-width:260px" />
      <span style="font-size:12px;color:var(--subtext0)">${visibleReports.length} shown</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${visibleReports.map(r => `
        <div class="card report-card" data-filename="${r.filename}" style="cursor:pointer;padding:14px 20px;display:flex;align-items:center;gap:16px;transition:background var(--transition)">
          <span style="font-weight:600;color:var(--subtext0);width:40px;font-size:13px">#${r.number}</span>
          <div style="flex:1">
            <div style="font-weight:500">${esc(r.slug.replace(/-/g, ' '))}</div>
            <div style="font-size:12px;color:var(--subtext)">${r.date}${r.archetype ? ` · ${esc(r.archetype)}` : ''}</div>
          </div>
          ${r.tldr ? `<div style="flex:1;font-size:12px;color:var(--subtext);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.tldr)}</div>` : ''}
          <span style="font-size:12px;color:var(--subtext0)">▶</span>
        </div>
      `).join('') || '<div class="empty-state"><h3>No matching reports</h3><p>Try a different search.</p></div>'}
    </div>
  `;

  container.querySelector('#reports-search')?.addEventListener('input', (event) => {
    reportsSearch = event.target.value || '';
    renderList(container, archivedCount);
  });

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

function renderTailorBundle(tailorBundle) {
  if (!tailorBundle?.paths) return '';
  const links = [
    tailorBundle.paths.cv ? `<a class="btn btn-sm" href="${api.tailorFileUrl(tailorBundle.paths.cv)}" target="_blank" style="text-decoration:none">Tailored CV</a>` : '',
    tailorBundle.paths.coverLetter ? `<a class="btn btn-sm" href="${api.tailorFileUrl(tailorBundle.paths.coverLetter)}" target="_blank" style="text-decoration:none">Cover letter</a>` : '',
    tailorBundle.paths.qa ? `<a class="btn btn-sm" href="${api.tailorFileUrl(tailorBundle.paths.qa)}" target="_blank" style="text-decoration:none">Application Q&A</a>` : '',
  ].filter(Boolean).join('');
  if (!links) return '';
  return `
    <div class="card" style="margin-bottom:16px;background:var(--surface0)">
      <h3 style="font-size:13px;font-weight:600;color:var(--subtext);margin-bottom:10px">Tailor bundle</h3>
      <div style="display:flex;flex-wrap:wrap;gap:8px">${links}</div>
    </div>
  `;
}

function slugifyHeading(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

export function extractReportSections(raw = '') {
  const sections = [];
  const seen = new Set();
  for (const line of String(raw).split(/\r?\n/)) {
    const match = line.match(/^##\s+(.+)$/);
    if (!match) continue;
    const title = match[1].trim();
    const id = slugifyHeading(title);
    if (seen.has(id)) continue;
    seen.add(id);
    sections.push({ title, id });
  }
  return sections;
}

export function reportPostingUrl(raw = '') {
  const match = String(raw).match(/^\*\*URL:\*\*\s*(https?:\/\/\S+)/m);
  return match ? match[1] : '';
}

export function decorateReportHeadings(container) {
  const headings = Array.from(container?.querySelectorAll?.('h2') || []);
  const seen = new Set();
  headings.forEach((heading) => {
    const id = slugifyHeading(heading.textContent || '');
    let finalId = id;
    let suffix = 2;
    while (seen.has(finalId)) {
      finalId = `${id}-${suffix++}`;
    }
    seen.add(finalId);
    heading.id = finalId;
    heading.style.scrollMarginTop = '96px';
  });
}

async function renderReport(container, filename) {
  container.innerHTML = '<div class="empty-state"><p>Loading report...</p></div>';
  try {
    const data = await api.getReport(filename);
    const sections = extractReportSections(data.raw);
    const postingUrl = reportPostingUrl(data.raw);
    container.innerHTML = `
      <div class="section-header">
        <button class="btn btn-sm" id="back-to-reports">← Back</button>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span style="font-size:13px;color:var(--subtext)">${filename}</span>
          ${data.archived ? '<span class="badge">Archived</span>' : '<span class="badge badge-active">Active</span>'}
        </div>
      </div>
      <div class="card" style="margin-bottom:16px;background:var(--surface0);display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between">
        <div style="font-size:12px;color:var(--subtext)">Use report links below to jump to generated CV, cover letter, and supporting artifacts.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${postingUrl ? `<a class="btn btn-sm" href="${esc(postingUrl)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none">View posting</a>` : ''}
          <a class="btn btn-sm" href="${api.reportExportUrl(filename)}" style="text-decoration:none">Export bundle</a>
          ${data.archived ? '' : '<button class="btn btn-sm btn-ghost" id="archive-report">Archive report</button>'}
        </div>
      </div>
      ${sections.length ? `
        <div class="card" style="margin-bottom:16px;background:var(--surface0)">
          <h3 style="font-size:13px;font-weight:600;color:var(--subtext);margin-bottom:10px">Jump to section</h3>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            ${sections.map((section) => `<a class="btn btn-sm" href="#${section.id}" style="text-decoration:none">${esc(section.title)}</a>`).join('')}
          </div>
        </div>
      ` : ''}
      ${renderTailorBundle(data.tailorBundle)}
      ${renderArtifacts(data.artifacts)}
      <div class="card markdown-body" id="report-markdown" style="padding:24px 32px">
        ${renderMarkdown(data.raw)}
      </div>
    `;
    decorateReportHeadings(container.querySelector('#report-markdown'));
    container.querySelector('#back-to-reports').onclick = () => {
      window.location.hash = '#/analytics/reports';
    };
    container.querySelector('#archive-report')?.addEventListener('click', async () => {
      if (!window.confirm(`Archive ${filename}?`)) return;
      const button = container.querySelector('#archive-report');
      if (button) button.disabled = true;
      try {
        await api.archiveReport(filename);
        window.location.hash = '#/analytics/reports';
      } catch (error) {
        if (button) button.disabled = false;
        window.alert(error.message || 'Could not archive report.');
      }
    });
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
  let archivedCount = 0;
  try {
    const data = await api.getReports();
    reportsList = data.reports || [];
    archivedCount = data.archivedCount || 0;
  } catch {
    reportsList = [];
  }

  renderList(container, archivedCount);
}
