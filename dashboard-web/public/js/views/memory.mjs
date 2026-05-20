import { api } from '../api.mjs';
import { confirmModal } from '../components/confirm.mjs';
import { toast } from '../components/toast.mjs';

function esc(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function confidenceTone(confidence) {
  return confidence === 'observed' ? 'green' : 'yellow';
}

function sourceHref(source) {
  if (!source) return '';
  if (/^https?:\/\//i.test(source)) return source;
  if (/^reports\//i.test(source)) {
    const filename = source.split('/').pop();
    return `/api/v1/reports/${encodeURIComponent(filename)}`;
  }
  return '';
}

function renderEntry(entry) {
  const href = sourceHref(entry.source);
  return `
    <article class="card memory-card" data-memory-id="${esc(entry.id)}">
      <div class="memory-card-header">
        <div>
          <div class="memory-card-title-row">
            <h3 class="memory-card-title">${esc(entry.name || entry.id)}</h3>
            <span class="analytics-chip ${confidenceTone(entry.confidence)}">${esc(entry.confidence || 'unknown')}</span>
            ${entry.status === 'superseded' ? '<span class="analytics-chip muted">superseded</span>' : ''}
          </div>
          <div class="memory-card-meta">
            <span>${esc(entry.type || 'memory')}</span>
            <span>Updated ${esc(entry.last_updated || entry.first_seen || 'unknown')}</span>
            <span>${Number(entry.occurrences) || 1} observations</span>
          </div>
        </div>
        <div class="memory-card-actions">
          <button class="btn btn-sm memory-edit-btn" data-memory-id="${esc(entry.id)}">Edit</button>
          <button class="btn btn-ghost btn-sm memory-delete-btn" data-memory-id="${esc(entry.id)}" style="color:var(--red)">Delete</button>
        </div>
      </div>
      ${entry.body ? `<p class="memory-card-body">${esc(entry.body)}</p>` : '<p class="memory-card-body memory-card-body-muted">No body text yet.</p>'}
      <div class="memory-card-footer">
        ${href ? `<a class="memory-source-link" href="${esc(href)}" target="_blank" rel="noreferrer">Source -></a>` : `<span class="memory-source-text">Source: ${esc(entry.source || 'unknown')}</span>`}
        ${entry.file ? `<span class="memory-source-text">${esc(entry.file)}</span>` : ''}
      </div>
    </article>
  `;
}

function renderGroup(group) {
  return `
    <section style="margin-bottom:24px">
      <div class="section-header" style="margin-bottom:14px">
        <div>
          <h2 class="section-title" style="font-size:18px">${esc(group.filename)}</h2>
          <span style="font-size:13px;color:var(--subtext)">${group.entries.length} entries</span>
        </div>
      </div>
      ${group.entries.length
        ? `<div class="memory-grid">${group.entries.map(renderEntry).join('')}</div>`
        : '<div class="card"><p class="analytics-panel-empty">No entries in this file yet.</p></div>'}
    </section>
  `;
}

export async function render(container) {
  container.innerHTML = '<div class="empty-state"><p>Loading memory...</p></div>';

  let data;
  try {
    data = await api.getMemory();
  } catch (error) {
    container.innerHTML = `<div class="empty-state"><h3>Memory unavailable</h3><p>${esc(error.message || 'Could not load memory.')}</p></div>`;
    return;
  }

  const files = (data.files || []).filter((group) => group.entries?.length);
  if (!files.length) {
    container.innerHTML = `
      <div class="empty-state"><h3>No learned memory yet</h3><p>Run pattern analysis or future memory-writing modes to populate this tab.</p></div>
    `;
    return;
  }

  container.innerHTML = `
    <p class="memory-meta">${files.reduce((sum, group) => sum + group.entries.length, 0)} entries across ${files.length} files</p>
    ${files.map(renderGroup).join('')}
  `;

  container.querySelectorAll('.memory-edit-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.memoryId;
      const entry = files.flatMap((group) => group.entries).find((item) => item.id === id);
      if (!entry) return;

      const result = await confirmModal({
        title: `Edit ${entry.name || entry.id}`,
        confirmText: 'Save memory',
        body: `
          <div class="form-group">
            <label class="form-label" for="memory-body">Body</label>
            <textarea class="form-textarea" id="memory-body" data-return="body">${esc(entry.body || '')}</textarea>
          </div>
        `,
      });
      if (!result?.ok) return;

      try {
        await api.updateMemory(id, { body: result.data.body });
        toast('Memory updated');
        await render(container);
      } catch (error) {
        toast(error.message || 'Failed to update memory', 'error');
      }
    });
  });

  container.querySelectorAll('.memory-delete-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.memoryId;
      const entry = files.flatMap((group) => group.entries).find((item) => item.id === id);
      if (!entry) return;

      const result = await confirmModal({
        title: `Delete ${entry.name || entry.id}?`,
        confirmText: 'Soft delete',
        danger: true,
        body: '<p style="font-size:14px;color:var(--subtext)">This keeps the entry in the file but marks it as superseded so it no longer participates as active memory.</p>',
      });
      if (!result?.ok) return;

      try {
        await api.deleteMemory(id);
        toast('Memory entry superseded');
        await render(container);
      } catch (error) {
        toast(error.message || 'Failed to delete memory', 'error');
      }
    });
  });
}
