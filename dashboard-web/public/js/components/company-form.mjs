function esc(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseJsonField(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

function selectedProvider(company) {
  if (company.provider) return company.provider;
  if (company.scan_method === 'websearch') return 'webfetch';
  return 'auto';
}

function companyModal({ title, company = {}, confirmText = 'Save', providers = [] } = {}) {
  const providerOptions = [{ name: 'auto', description: 'Auto-detect from the careers URL' }, ...providers];

  return new Promise((resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal company-modal">
        <div class="modal-title">${esc(title)}</div>
        <div class="form-group">
          <label class="form-label" for="company-name">Name</label>
          <input class="form-input" id="company-name" value="${esc(company.name || '')}" placeholder="OpenAI">
        </div>
        <div class="form-group">
          <label class="form-label" for="company-careers-url">Careers URL</label>
          <input class="form-input" id="company-careers-url" value="${esc(company.careers_url || '')}" placeholder="https://company.com/careers">
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label" for="company-provider">Provider</label>
            <select class="form-select" id="company-provider">
              ${providerOptions.map((option) =>
                `<option value="${option.name}"${selectedProvider(company) === option.name ? ' selected' : ''}>${option.name}${option.description ? ` - ${option.description}` : ''}</option>`
              ).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="company-enabled">Enabled</label>
            <select class="form-select" id="company-enabled">
              <option value="true"${company.enabled !== false ? ' selected' : ''}>Enabled</option>
              <option value="false"${company.enabled === false ? ' selected' : ''}>Disabled</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="company-api-url">API URL</label>
          <input class="form-input" id="company-api-url" value="${esc(company.api || '')}" placeholder="https://boards-api.greenhouse.io/v1/boards/company/jobs">
        </div>
        <div class="form-group">
          <label class="form-label" for="company-provider-config">Provider Config JSON</label>
          <textarea class="form-textarea" id="company-provider-config" placeholder='{"selectors":{"jobLink":"a[href*=\"/jobs/\"]"}}'>${esc(company.provider_config ? JSON.stringify(company.provider_config, null, 2) : '')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label" for="company-notes">Notes</label>
          <textarea class="form-textarea" id="company-notes" placeholder="Notes about remote policy, HQ, or hiring focus">${esc(company.notes || '')}</textarea>
        </div>
        <div class="modal-actions">
          <button class="btn" id="company-modal-cancel">Cancel</button>
          <button class="btn btn-primary" id="company-modal-confirm">${esc(confirmText)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };

    const fail = (error) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      reject(error);
    };

    const collect = () => {
      try {
        const provider = overlay.querySelector('#company-provider').value;
        return {
          name: overlay.querySelector('#company-name').value.trim(),
          careers_url: overlay.querySelector('#company-careers-url').value.trim(),
          provider: provider === 'auto' ? null : provider,
          api: overlay.querySelector('#company-api-url').value.trim(),
          provider_config: parseJsonField(overlay.querySelector('#company-provider-config').value),
          notes: overlay.querySelector('#company-notes').value.trim(),
          enabled: overlay.querySelector('#company-enabled').value === 'true',
          scan_method: null,
          scan_query: null,
        };
      } catch (error) {
        fail(error);
        return null;
      }
    };

    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
    };
    document.addEventListener('keydown', onKey);

    overlay.querySelector('#company-modal-cancel').onclick = () => close(false);
    overlay.querySelector('#company-modal-confirm').onclick = () => {
      const payload = collect();
      if (payload) close(payload);
    };
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(false);
    });
    overlay.querySelector('#company-name')?.focus();
  });
}

export function AddCompanyModal(providers) {
  return companyModal({ title: 'Add Company', confirmText: 'Add company', providers });
}

export function EditCompanyModal(company, providers) {
  return companyModal({ title: `Edit ${company.name}`, company, confirmText: 'Save changes', providers });
}
