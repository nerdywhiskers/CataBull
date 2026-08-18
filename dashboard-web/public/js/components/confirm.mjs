/**
 * Reusable confirm modal. Returns a Promise<boolean> that resolves to
 * true when the user confirms, false when they cancel or click outside.
 *
 * Usage:
 *   if (await confirmModal({ title: 'Delete X?', body: '<p>...</p>', confirmText: 'Delete', danger: true })) {
 *     // do the thing
 *   }
 */
export function confirmModal({ title, body = '', confirmText = 'Proceed', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const confirmClass = danger ? 'btn btn-primary' : 'btn btn-primary';
    const confirmStyle = danger ? 'background:var(--red);border-color:var(--red);color:#fff' : '';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">${title}</div>
        ${body}
        <div class="modal-actions">
          <button class="btn" id="modal-cancel">Cancel</button>
          <button class="${confirmClass}" id="modal-confirm" style="${confirmStyle}">${confirmText}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') {
        // Don't submit while typing inside a field — Enter there should
        // just move between inputs, not save a half-edited form.
        const tag = (document.activeElement?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        close(true);
      }
    };
    document.addEventListener('keydown', onKey);

    // Collect values from inputs with data-return="key" before closing, so
    // callers can read typed-in data from inside the modal body (e.g. a
    // confirmation name). The values ride along on resolved `true` only.
    const collectData = () => {
      const data = {};
      overlay.querySelectorAll('[data-return]').forEach(el => {
        data[el.dataset.return] = el.value ?? '';
      });
      return data;
    };

    overlay.querySelector('#modal-cancel').onclick = () => close(false);
    overlay.querySelector('#modal-confirm').onclick = () => close({ ok: true, data: collectData() });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
  });
}
