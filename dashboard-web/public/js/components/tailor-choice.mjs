function esc(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function promptTailorAction({ company = '', role = '' } = {}) {
  return new Promise((resolve) => {
    let modal = document.getElementById('tailor-action-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'tailor-action-modal';
      modal.className = 'tailor-modal-backdrop';
      document.body.appendChild(modal);
    }

    const close = (choice = null) => {
      modal.remove();
      resolve(choice);
    };

    modal.innerHTML = `
      <div class="tailor-modal tailor-modal-result">
        <header class="tailor-modal-head">
          <h3>Tailor <em>${esc(role)}</em> at <em>${esc(company)}</em></h3>
          <button class="btn btn-ghost btn-sm" id="tailor-action-cancel" type="button">Cancel</button>
        </header>
        <div class="tailor-modal-body">
          <p class="tailor-modal-hint" style="margin-bottom:14px">
            Choose the lighter tailor pass or the full scored report. Full evaluation now also appends the tailored resume + cover letter packet into the report.
          </p>
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:stretch">
            <button class="btn btn-secondary" id="tailor-action-tailor" type="button" style="min-height:120px;white-space:normal;text-align:left;justify-content:flex-start;padding:14px 16px;line-height:1.45">
              <span>
                <strong style="display:block;margin-bottom:6px">Tailor only</strong>
                <span style="display:block;font-size:12px;opacity:.9">Build the resume + cover bundle fast. Lower token cost. Best when you already know the role is worth pursuing.</span>
              </span>
            </button>
            <button class="btn btn-primary" id="tailor-action-evaluate" type="button" style="min-height:120px;white-space:normal;text-align:left;justify-content:flex-start;padding:14px 16px;line-height:1.45">
              <span>
                <strong style="display:block;margin-bottom:6px">Tailor + full evaluation</strong>
                <span style="display:block;font-size:12px;opacity:.95">Run the scored report first, then append the tailored resume + cover packet to that report. Higher token cost, more detail, better for decision-making.</span>
              </span>
            </button>
          </div>
          <p class="tailor-modal-hint" style="margin-top:14px">
            Both options keep the role out of Pending once saved.
          </p>
        </div>
      </div>
    `;

    modal.querySelector('#tailor-action-cancel')?.addEventListener('click', () => close(null));
    modal.querySelector('#tailor-action-tailor')?.addEventListener('click', () => close('tailor'));
    modal.querySelector('#tailor-action-evaluate')?.addEventListener('click', () => close('evaluate'));
    modal.addEventListener('click', (event) => {
      if (event.target === modal) close(null);
    }, { once: true });
  });
}

export function promptLowTailorScoreAction({ company = '', role = '', score = NaN } = {}) {
  return new Promise((resolve) => {
    let modal = document.getElementById('tailor-low-score-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'tailor-low-score-modal';
      modal.className = 'tailor-modal-backdrop';
      document.body.appendChild(modal);
    }

    const close = (choice = null) => {
      modal.remove();
      resolve(choice);
    };

    modal.innerHTML = `
      <div class="tailor-modal tailor-modal-result">
        <header class="tailor-modal-head">
          <h3>Low-fit role</h3>
          <button class="btn btn-ghost btn-sm" id="tailor-low-score-cancel" type="button">Cancel</button>
        </header>
        <div class="tailor-modal-body">
          <p class="tailor-modal-hint" style="margin-bottom:10px">
            <strong style="color:var(--text)">${esc(company)} - ${esc(role)}</strong> is only scoring <strong style="color:var(--yellow)">${Number.isFinite(score) ? score.toFixed(1) : 'n/a'}/5</strong>.
          </p>
          <p class="tailor-modal-hint" style="margin-bottom:16px">
            Weak-fit roles usually burn time and credits. Skip it now, or override and continue with the regular tailoring flow.
          </p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn btn-secondary" id="tailor-low-score-skip" type="button">Skip role</button>
            <button class="btn btn-primary" id="tailor-low-score-tailor" type="button">Tailor anyway</button>
          </div>
        </div>
      </div>
    `;

    modal.querySelector('#tailor-low-score-cancel')?.addEventListener('click', () => close(null));
    modal.querySelector('#tailor-low-score-skip')?.addEventListener('click', () => close('skip'));
    modal.querySelector('#tailor-low-score-tailor')?.addEventListener('click', () => close('tailor'));
    modal.addEventListener('click', (event) => {
      if (event.target === modal) close(null);
    }, { once: true });
  });
}
