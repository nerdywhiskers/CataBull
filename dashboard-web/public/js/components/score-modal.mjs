// Score-rationale modal. Two flavors:
//   - evaluated app  → A–E weighted breakdown + formula + report excerpt
//   - pending item   → heuristic factor list with +/− deltas
//
// Both surface the *why* behind the number rather than just the number.
// Data shapes match what the /applications endpoint already returns:
//   evaluated: { score, scoreBlocks: { A,B,C,D,E }, scoreComputed?, rationaleExcerpt?, reportPath? }
//   pending:   { relevance, relevanceFactors: [{ label, delta }], role }

import { runModePrompt } from '../lib/modes.mjs';

const BLOCK_LABELS = {
  A: { label: 'Match con CV',  weight: 0.30, isPenalty: false },
  B: { label: 'North Star',     weight: 0.25, isPenalty: false },
  C: { label: 'Comp',           weight: 0.20, isPenalty: false },
  D: { label: 'Cultural',       weight: 0.15, isPenalty: false },
  E: { label: 'Red flags',      weight: 0.10, isPenalty: true },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Mirrors scoreClass() in views/pipeline.mjs so the modal's accent matches
// the score-ring chip the user clicked. Buckets: 4.5+ excellent, 4.0+ good,
// 3.5+ decent, 3.0+ low, else poor. Existing tone-* CSS already maps each
// to a Catppuccin accent (green/sky/yellow/peach/red).
function scoreTone(score) {
  if (score >= 4.5) return 'excellent';
  if (score >= 4.0) return 'good';
  if (score >= 3.5) return 'decent';
  if (score >= 3.0) return 'low';
  return 'poor';
}

function renderEvaluated(app) {
  const blocks = app.scoreBlocks || {};
  const finalScore = Number.isFinite(app.scoreComputed) ? app.scoreComputed : Number(app.score) || 0;
  const tone = scoreTone(finalScore);

  const bars = ['A', 'B', 'C', 'D', 'E'].map(letter => {
    const meta = BLOCK_LABELS[letter];
    const value = Number(blocks[letter]);
    if (!Number.isFinite(value)) return '';
    const ratio = Math.max(0, Math.min(1, value / 5));
    const weightLabel = `${Math.round(meta.weight * 100)}%${meta.isPenalty ? ' ↓' : ''}`;
    return `
      <div class="score-modal-row">
        <span class="score-modal-letter">${letter}</span>
        <span class="score-modal-label">${esc(meta.label)}</span>
        <span class="score-modal-bar">
          <span class="score-modal-bar-fill tone-${scoreTone(value)}" style="width:${(ratio * 100).toFixed(0)}%"></span>
        </span>
        <span class="score-modal-value">${value.toFixed(1)}</span>
        <span class="score-modal-weight" title="Weight in final score">${weightLabel}</span>
      </div>`;
  }).filter(Boolean).join('');

  const formula = Number.isFinite(app.scoreComputed)
    ? `A·30% + B·25% + C·20% + D·15% − (5−E)·10% = <strong>${app.scoreComputed.toFixed(1)}</strong>`
    : '';

  const excerpt = app.rationaleExcerpt
    ? `<div class="score-modal-excerpt"><span class="score-modal-excerpt-label">Why this score</span><p>${esc(app.rationaleExcerpt)}</p></div>`
    : '';

  const reportBtn = app.reportPath
    ? `<button class="btn btn-secondary" data-action="open-report">Open full report</button>`
    : '';

  return {
    title: `Match Score · ${finalScore.toFixed(1)}/5`,
    tone,
    headerSub: `${esc(app.company || '')} · ${esc(app.role || '')}`,
    body: `
      <div class="score-modal-bars">${bars}</div>
      ${formula ? `<div class="score-modal-formula">${formula}</div>` : ''}
      ${excerpt}
    `,
    actions: reportBtn,
  };
}

function renderPending(item) {
  const score = Number.isFinite(item.contextualScore) ? item.contextualScore : (Number(item.relevance) || 0);
  const tone = scoreTone(score);
  const factors = Array.isArray(item.relevanceFactors) ? item.relevanceFactors : [];
  const isContextual = item.contextualScoreSource === 'llm';

  const contextualRows = isContextual
    ? [
        item.contextualRationale ? `<p class="score-modal-contextual-rationale">${esc(item.contextualRationale)}</p>` : '',
        Array.isArray(item.contextualSignals) && item.contextualSignals.length
          ? `<div class="score-modal-factors">${item.contextualSignals.map((signal) => `
              <div class="score-modal-factor positive">
                <span class="score-modal-factor-sign">+</span>
                <span class="score-modal-factor-label">${esc(signal)}</span>
              </div>`).join('')}</div>`
          : '',
      ].filter(Boolean).join('')
    : '';

  const factorRows = !isContextual && factors.length
    ? factors.map(f => {
        const delta = Number(f.delta) || 0;
        const sign = delta >= 0 ? '+' : '−';
        const cls = delta >= 0 ? 'positive' : 'negative';
        return `
          <div class="score-modal-factor ${cls}">
            <span class="score-modal-factor-sign">${sign}</span>
            <span class="score-modal-factor-label">${esc(f.label)}</span>
            <span class="score-modal-factor-delta">${delta > 0 ? '+' : ''}${delta.toFixed(1)}</span>
          </div>`;
      }).join('')
    : '<p class="score-modal-empty">No matching keywords or roles in your profile yet.</p>';

  return {
    title: `Match Preview · ${score.toFixed(1)}/5`,
    tone,
    headerSub: `${esc(item.company || '')} · ${esc(item.role || '')}`,
    body: `
      <p class="score-modal-meta">${isContextual ? 'LLM contextual score from your profile + archetype notes.' : 'Heuristic preview from your profile + portal keywords.'} Run a full evaluation for the complete A–E breakdown.</p>
      ${isContextual ? contextualRows : `<div class="score-modal-factors">${factorRows}</div>`}
    `,
    actions: `<button class="btn btn-secondary" data-action="evaluate">Run full evaluation</button>`,
  };
}

export function openScoreModal(target, { kind = 'evaluated' } = {}) {
  const view = kind === 'pending' ? renderPending(target) : renderEvaluated(target);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal score-modal">
      <header class="score-modal-header tone-${view.tone}">
        <div class="score-modal-title">${esc(view.title)}</div>
        ${view.headerSub ? `<div class="score-modal-sub">${view.headerSub}</div>` : ''}
      </header>
      <div class="score-modal-body">${view.body}</div>
      <div class="modal-actions">
        ${view.actions}
        <button class="btn" data-action="close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-action="close"]')?.addEventListener('click', close);
  overlay.querySelector('[data-action="open-report"]')?.addEventListener('click', () => {
    close();
    // Reports live inside the Analytics view, same target as the inline
    // 📄 button in pipeline rows. Keep behaviors aligned so users get
    // consistent navigation regardless of where they click.
    window.location.hash = '#/analytics';
  });
  overlay.querySelector('[data-action="evaluate"]')?.addEventListener('click', () => {
    close();
    runModePrompt('evaluate', { company: target.company, role: target.role, url: target.url || target.jobUrl || '' });
  });
}
