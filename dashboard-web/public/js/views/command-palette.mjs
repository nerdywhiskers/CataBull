import { api } from '../api.mjs';
import { getMode, listModes, prefillModeTarget, runModePrompt, targetLabel, targetPlaceholder } from '../lib/modes.mjs';

let root = null;
let resourceCache = null;
let state = {
  open: false,
  step: 'modes',
  query: '',
  selectedIndex: 0,
  modeId: null,
  targetValue: '',
  context: {},
};

function esc(value) {
  return (value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function modeList() {
  const query = state.query.trim().toLowerCase();
  return listModes()
    .filter(mode => mode.placements.includes('palette'))
    .filter(mode => {
      if (!query) return true;
      return `${mode.label} ${mode.description}`.toLowerCase().includes(query);
    });
}

function activeContext() {
  const source = document.activeElement?.closest?.('[data-url],[data-company],[data-role]');
  if (!source) return {};
  return {
    url: source.dataset.url || '',
    company: source.dataset.company || '',
    role: source.dataset.role || '',
  };
}

async function loadResources() {
  if (resourceCache) return resourceCache;
  const [applications, portals] = await Promise.all([
    api.getApplications().catch(() => ({ pending: [], applications: [] })),
    api.getPortals().catch(() => ({ portals: { tracked_companies: [] } })),
  ]);

  const urls = new Set();
  for (const item of applications.pending || []) urls.add(item.url);
  for (const item of applications.applications || []) {
    if (item.jobUrl) urls.add(item.jobUrl);
  }

  const companies = new Set();
  for (const item of applications.pending || []) companies.add(item.company);
  for (const item of applications.applications || []) companies.add(item.company);
  for (const item of portals?.portals?.tracked_companies || []) companies.add(item.name);

  resourceCache = {
    urls: [...urls].filter(Boolean).sort(),
    companies: [...companies].filter(Boolean).sort(),
  };
  return resourceCache;
}

function suggestionItems(mode) {
  if (!mode?.needsTarget || !resourceCache) return [];
  if (mode.targetKind === 'url') return resourceCache.urls;
  if (mode.targetKind === 'company') return resourceCache.companies;
  return [];
}

function focusCurrentInput() {
  requestAnimationFrame(() => {
    const selector = state.step === 'modes' ? '#palette-search' : '#palette-target';
    root.querySelector(selector)?.focus();
    if (state.step === 'target') {
      const input = root.querySelector('#palette-target');
      if (input?.setSelectionRange) input.setSelectionRange(input.value.length, input.value.length);
    }
  });
}

function close() {
  state = { open: false, step: 'modes', query: '', selectedIndex: 0, modeId: null, targetValue: '', context: {} };
  render();
}

function beginTargetStep(modeId) {
  state.modeId = modeId;
  state.step = 'target';
  state.targetValue = prefillModeTarget(modeId, state.context);
  render();
  focusCurrentInput();
}

async function runSelectedMode(modeId, extraContext = {}) {
  const ok = await runModePrompt(modeId, { ...state.context, ...extraContext });
  if (ok) close();
}

function submitTarget() {
  const mode = getMode(state.modeId);
  if (!mode) return;
  const value = state.targetValue.trim();
  if (!value) return;

  if (mode.targetKind === 'url') {
    runSelectedMode(mode.id, { url: value });
    return;
  }
  if (mode.targetKind === 'company') {
    runSelectedMode(mode.id, { company: value });
    return;
  }
  runSelectedMode(mode.id, { text: value });
}

function render() {
  if (!root) return;
  if (!state.open) {
    root.innerHTML = '';
    return;
  }

  const modes = modeList();
  const selectedMode = modes[state.selectedIndex] || modes[0] || null;
  const mode = getMode(state.modeId);
  const suggestions = suggestionItems(mode);
  const contextText = [state.context.company, state.context.role].filter(Boolean).join(' / ');

  root.innerHTML = `
    <div class="palette-overlay" id="palette-overlay">
      <div class="palette-shell card" role="dialog" aria-modal="true" aria-label="Command palette">
        ${state.step === 'modes' ? `
          <div class="palette-header">
            <div>
              <div class="palette-eyebrow">Command Palette</div>
              <h2 class="palette-title">Launch a CataBull mode</h2>
            </div>
            <button class="btn btn-ghost btn-sm" id="palette-close">Esc</button>
          </div>
          <input id="palette-search" class="form-input palette-input" placeholder="Search modes, examples: pattern, pdf, interview" value="${esc(state.query)}" autocomplete="off">
          ${contextText ? `<div class="palette-context">Current context: ${esc(contextText)}</div>` : ''}
          <div class="palette-results" id="palette-results">
            ${modes.length ? modes.map((item, index) => `
              <button class="palette-result${index === state.selectedIndex ? ' active' : ''}" data-mode="${item.id}">
                <span class="palette-result-main">
                  <span class="palette-result-label">${esc(item.label)}</span>
                  <span class="palette-result-desc">${esc(item.description)}</span>
                </span>
                <span class="palette-result-meta">${esc(item.group)}</span>
              </button>
            `).join('') : `<div class="palette-empty">No modes match "${esc(state.query)}".</div>`}
          </div>
        ` : `
          <div class="palette-header">
            <div>
              <div class="palette-eyebrow">${esc(mode?.group || 'Mode')}</div>
              <h2 class="palette-title">${esc(mode?.label || 'Mode')}</h2>
            </div>
            <button class="btn btn-ghost btn-sm" id="palette-back">Back</button>
          </div>
          <label class="form-label" for="palette-target">${esc(targetLabel(state.modeId))}</label>
          ${contextText ? `<div class="palette-context">Context: ${esc(contextText)}</div>` : ''}
          ${mode?.targetKind === 'jd-text'
            ? `<textarea id="palette-target" class="form-textarea palette-textarea" placeholder="${esc(targetPlaceholder(state.modeId))}">${esc(state.targetValue)}</textarea>`
            : `<input id="palette-target" class="form-input palette-input" placeholder="${esc(targetPlaceholder(state.modeId))}" value="${esc(state.targetValue)}" list="palette-target-options" autocomplete="off">`
          }
          ${suggestions.length ? `
            <datalist id="palette-target-options">
              ${suggestions.map(item => `<option value="${esc(item)}"></option>`).join('')}
            </datalist>
          ` : ''}
          <p class="palette-help">${esc(mode?.description || '')}${mode?.targetKind === 'jd-text' ? ' Use Ctrl+Enter to run.' : ''}</p>
          <div class="modal-actions" style="margin-top:16px">
            <button class="btn btn-ghost" id="palette-cancel">Cancel</button>
            <button class="btn btn-primary" id="palette-run">Run</button>
          </div>
        `}
      </div>
    </div>
  `;

  root.querySelector('#palette-overlay')?.addEventListener('click', (event) => {
    if (event.target.id === 'palette-overlay') close();
  });

  root.querySelector('#palette-close')?.addEventListener('click', close);
  root.querySelector('#palette-back')?.addEventListener('click', () => {
    state.step = 'modes';
    state.modeId = null;
    render();
    focusCurrentInput();
  });
  root.querySelector('#palette-cancel')?.addEventListener('click', close);

  const search = root.querySelector('#palette-search');
  if (search) {
    search.addEventListener('input', (event) => {
      state.query = event.target.value;
      state.selectedIndex = 0;
      render();
      focusCurrentInput();
    });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        state.selectedIndex = Math.min(state.selectedIndex + 1, Math.max(modes.length - 1, 0));
        render();
        focusCurrentInput();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        state.selectedIndex = Math.max(state.selectedIndex - 1, 0);
        render();
        focusCurrentInput();
      } else if (event.key === 'Enter' && selectedMode) {
        event.preventDefault();
        if (selectedMode.needsTarget) beginTargetStep(selectedMode.id);
        else runSelectedMode(selectedMode.id);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
  }

  root.querySelectorAll('.palette-result').forEach(button => {
    button.addEventListener('click', () => {
      const selected = getMode(button.dataset.mode);
      if (!selected) return;
      if (selected.needsTarget) beginTargetStep(selected.id);
      else runSelectedMode(selected.id);
    });
  });

  const target = root.querySelector('#palette-target');
  if (target) {
    target.addEventListener('input', (event) => {
      state.targetValue = event.target.value;
    });
    target.addEventListener('keydown', (event) => {
      const submitTextArea = mode?.targetKind === 'jd-text' && event.key === 'Enter' && (event.ctrlKey || event.metaKey);
      const submitSingleLine = mode?.targetKind !== 'jd-text' && event.key === 'Enter';
      if (submitTextArea || submitSingleLine) {
        event.preventDefault();
        submitTarget();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'Backspace' && !state.targetValue) {
        state.step = 'modes';
        state.modeId = null;
        render();
        focusCurrentInput();
      }
    });
  }

  root.querySelector('#palette-run')?.addEventListener('click', submitTarget);
}

export async function init(container) {
  root = container;
  render();
  await loadResources().catch(() => {});
}

export function open() {
  state.open = true;
  state.step = 'modes';
  state.query = '';
  state.selectedIndex = 0;
  state.modeId = null;
  state.targetValue = '';
  state.context = activeContext();
  render();
  focusCurrentInput();
  loadResources().catch(() => {});
}

export function isOpen() {
  return state.open;
}
