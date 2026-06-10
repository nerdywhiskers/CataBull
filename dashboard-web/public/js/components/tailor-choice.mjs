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
            Choose whether to just build the tailored packet, or run the full evaluation flow too.
          </p>
          <div style="display:grid;gap:12px">
            <button class="btn btn-secondary" id="tailor-action-tailor" type="button">Tailor only</button>
            <button class="btn btn-primary" id="tailor-action-evaluate" type="button">Tailor + evaluation</button>
          </div>
          <p class="tailor-modal-hint" style="margin-top:14px">
            <strong>Tailor only</strong> keeps the fast bundle flow. <strong>Tailor + evaluation</strong> also runs the original scored report workflow.
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
