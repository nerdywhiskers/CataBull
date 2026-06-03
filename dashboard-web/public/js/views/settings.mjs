import { api, waitForDashboardReload } from '../api.mjs';
import { toast } from '../components/toast.mjs';
import { confirmModal } from '../components/confirm.mjs';

const SCAN_LIMIT_KEY = 'catabull-scan-limit';

export async function render(container) {
  container.innerHTML = `
    <div class="settings-page">
      <header class="section-header">
        <div>
          <h1 class="section-title">Settings</h1>
          <p class="section-sub">Keys stay in your workspace .env file and are never shown after save.</p>
        </div>
      </header>
      <div class="settings-section">
        <span class="spinner"></span>
        <span>Loading settings</span>
      </div>
    </div>
  `;

  try {
    const [settings, maintenance] = await Promise.all([
      api.getSettings(),
      api.getSettingsMaintenance(),
    ]);
    renderSettings(container, settings, maintenance);
  } catch (err) {
    container.innerHTML = `
      <div class="settings-page">
        <header class="section-header">
          <div>
            <h1 class="section-title">Settings</h1>
            <p class="section-sub">Could not load settings.</p>
          </div>
        </header>
        <div class="empty-state"><h3>Settings unavailable</h3><p>${esc(err.message || 'Request failed')}</p></div>
      </div>
    `;
  }
}

function renderSettings(container, settings, maintenance = {}) {
  const secrets = settings.secrets || {};
  const scanDefaults = settings.scanDefaults || {};
  const scanLimit = Number.isFinite(scanDefaults.deepScanLimit) ? scanDefaults.deepScanLimit : 0;
  const minRelevance = Number.isFinite(scanDefaults.minRelevance) ? scanDefaults.minRelevance : 0;
  const freshnessDays = Number.isFinite(scanDefaults.freshnessDays) ? scanDefaults.freshnessDays : 0;
  const tailscale = settings.tailscale || {};
  const tailscaleStatus = tailscale.status || {};
  const tailscaleMode = tailscale.mode || 'off';
  const workspace = settings.workspace || {};
  const workspacePreference = workspace.globalInstallPreference || 'home';
  try { localStorage.setItem(SCAN_LIMIT_KEY, String(scanLimit)); } catch {}

  container.innerHTML = `
    <div class="settings-page">
      <header class="section-header">
        <div>
          <h1 class="section-title">Settings</h1>
          <p class="section-sub">Keys stay in your workspace .env file and are never shown after save.</p>
        </div>
        <div class="section-header-actions">
          <span class="stat-pill">
            <span class="stat-pill-label">Secrets</span>
            <span class="stat-pill-value">${configuredCount(secrets)}/${Object.keys(secrets).length}</span>
          </span>
        </div>
      </header>

      <form class="settings-form" id="settings-form">
        <div class="settings-column">
          <section class="settings-section">
            <div class="settings-section-header">
              <div>
                <h2>API Keys</h2>
                <p>Leave a configured key blank to keep the current value.</p>
              </div>
            </div>
            <div class="settings-grid">
              ${secretField({
                id: 'braveApiKey',
                label: 'Brave Search API key',
                description: 'Used by Deep Scan WebSearch.',
                secret: secrets.braveApiKey,
              })}
              ${secretField({
                id: 'serperApiKey',
                label: 'Serper API key',
                description: 'Optional Google-style WebSearch backup.',
                secret: secrets.serperApiKey,
              })}
              ${secretField({
                id: 'apolloApiKey',
                label: 'Apollo API key',
                description: 'Reserved for contact discovery and outreach.',
                secret: secrets.apolloApiKey,
              })}
            </div>
          </section>

          <section class="settings-section settings-section-compact">
            <div class="settings-section-header">
              <div>
                <h2>Tailnet Access</h2>
                <p>Share privately through Tailscale Serve.</p>
              </div>
            </div>
            <div class="settings-grid settings-grid-compact settings-grid-inline">
              <label class="settings-field">
                <span class="form-label">Tailscale mode</span>
                <select class="form-select" id="tailscale-mode">
                  ${tailscaleModeOption('off', 'Local only', tailscaleMode)}
                  ${tailscaleModeOption('detect', 'Detect only', tailscaleMode)}
                  ${tailscaleModeOption('serve', 'Share with tailnet', tailscaleMode)}
                </select>
                <span class="settings-help">CataBull still listens on localhost.</span>
              </label>
              <div class="settings-field">
                <div class="settings-field-top">
                  <span class="form-label">Tailscale status</span>
                  <span class="settings-status ${tailscaleStatus.available ? 'is-on' : 'is-off'}">${tailscaleStatus.available ? 'Available' : 'Unavailable'}</span>
                </div>
                <span class="settings-help">${esc(tailscaleStatus.message || 'Not checked')}</span>
                ${tailscale.url ? `<span class="settings-help">Tailnet URL: <code>${esc(tailscale.url)}</code></span>` : ''}
              </div>
            </div>
          </section>

          <section class="settings-section settings-section-compact">
            <div class="settings-section-header">
              <div>
                <h2>Global Install Workspace</h2>
                <p>Controls where the npm-installed catabull CLI stores and reads your data.</p>
              </div>
            </div>
            <div class="settings-grid settings-grid-compact settings-grid-inline">
              <label class="settings-field">
                <span class="form-label">Workspace preference</span>
                <select class="form-select" id="workspace-preference">
                  ${workspacePreferenceOption('home', `Home workspace (${workspace.homeRoot || '~/.catabull'})`, workspacePreference)}
                  ${workspacePreferenceOption('cwd', 'Current CataBull folder when detected', workspacePreference)}
                </select>
                <span class="settings-help">Default is the safe home workspace. Choosing the current folder only affects global installs and never changes which code install gets updated.</span>
              </label>
              <div class="settings-field">
                <div class="settings-field-top">
                  <span class="form-label">Current workspace root</span>
                </div>
                <span class="settings-help"><code>${esc(workspace.currentRoot || '(unknown)')}</code></span>
              </div>
            </div>
          </section>

          <section class="settings-section settings-section-compact">
            <div class="settings-section-header">
              <div>
                <h2>Application Updates</h2>
                <p>Check the CataBull repo and pull fast-forward updates into this install.</p>
              </div>
            </div>
            <div class="settings-grid settings-grid-compact">
              <div class="settings-field">
                <div class="settings-field-top">
                  <span class="form-label">Auto update</span>
                  <label class="toggle" title="Toggle automatic updates">
                    <input id="auto-update" type="checkbox" ${settings.updates?.autoUpdate ? 'checked' : ''}>
                    <span class="toggle-track"></span>
                    <span class="toggle-thumb"></span>
                  </label>
                </div>
                <span class="settings-help">When enabled, CataBull checks on launch and applies repo updates automatically when safe.</span>
              </div>
              <div id="update-status-card" class="update-status-card">
                <span><span class="spinner"></span> Checking update status</span>
              </div>
            </div>
            <div class="settings-action-row">
              <button class="btn btn-outline" type="button" id="check-updates-btn">Check for Updates</button>
              <button class="btn btn-primary" type="button" id="apply-update-btn" disabled>Update</button>
              <button class="btn btn-outline" type="button" id="git-pull-btn" disabled title="Dev installs only: runs git pull --ff-only against origin/main">Pull from git</button>
              <button class="btn btn-outline" type="button" id="restart-dashboard-btn" disabled title="Restart available only when the dashboard was launched through catabull or start.mjs">Restart Dashboard</button>
            </div>
          </section>
        </div>

        <div class="settings-column">
          <section class="settings-section">
            <div class="settings-section-header">
              <div>
                <h2>Scan Defaults</h2>
                <p>These tune scan behavior without changing portals.yml.</p>
              </div>
            </div>
            <div class="settings-grid">
              <label class="settings-field">
                <span class="form-label">WebSearch provider</span>
                <select class="form-select" id="web-search-provider">
                  ${providerOption('auto', 'Auto', settings.webSearchProvider)}
                  ${providerOption('brave', 'Brave', settings.webSearchProvider)}
                  ${providerOption('scrape', 'Scrape fallback', settings.webSearchProvider)}
                  ${providerOption('serper', 'Serper', settings.webSearchProvider)}
                </select>
                <span class="settings-help">Auto follows the provider order below.</span>
              </label>
              <label class="settings-field">
                <span class="form-label">Auto provider order</span>
                <select class="form-select" id="web-search-order">
                  ${providerOrderOption('brave,serper,scrape', 'Brave, Serper, scrape', settings.webSearchOrder)}
                  ${providerOrderOption('serper,brave,scrape', 'Serper, Brave, scrape', settings.webSearchOrder)}
                  ${providerOrderOption('brave,scrape', 'Brave, scrape', settings.webSearchOrder)}
                  ${providerOrderOption('serper,scrape', 'Serper, scrape', settings.webSearchOrder)}
                  ${providerOrderOption('scrape', 'Scrape only', settings.webSearchOrder)}
                </select>
                <span class="settings-help">Used only when provider is Auto.</span>
              </label>
              <label class="settings-field">
                <span class="form-label">Deep Scan max roles</span>
                <input class="form-input" id="deep-scan-limit" type="number" min="0" step="1" value="${scanLimit}">
                <span class="settings-help">Use 0 for no local limit.</span>
              </label>
              <label class="settings-field">
                <span class="form-label">Minimum relevance</span>
                <input class="form-input" id="min-relevance" type="number" min="0" max="5" step="0.5" value="${minRelevance}">
                <span class="settings-help">Filters Quick Scan, WebSearch, and JobSpy roles before they hit Pending. Use 0 to keep everything.</span>
              </label>
              <label class="settings-field">
                <span class="form-label">Freshness window</span>
                <select class="form-select" id="freshness-days">
                  ${freshnessOption(0, 'Any posted date', freshnessDays)}
                  ${freshnessOption(1, 'Last 24 hours', freshnessDays)}
                  ${freshnessOption(7, 'Last 7 days', freshnessDays)}
                  ${freshnessOption(14, 'Last 14 days', freshnessDays)}
                  ${freshnessOption(30, 'Last 30 days', freshnessDays)}
                  ${freshnessOption(60, 'Last 60 days', freshnessDays)}
                </select>
                <span class="settings-help">Roles without posted dates are kept.</span>
              </label>
            </div>
          </section>

          <section class="settings-section settings-section-compact">
            <div class="settings-section-header">
              <div>
                <h2>Backup</h2>
                <p>Export or restore the user-data layer.</p>
              </div>
            </div>
            <div class="settings-action-row">
              <a class="btn btn-outline" href="${api.backupDownloadUrl()}" download>Export Backup</a>
              <button class="btn btn-outline" type="button" id="settings-restore-btn">Import Backup</button>
              <input type="file" id="settings-restore-file" accept=".zip" style="display:none">
            </div>
          </section>

          <section class="settings-section settings-section-compact">
            <div class="settings-section-header">
              <div>
                <h2>Data Maintenance</h2>
                <p>Clean or rebuild scan data when the pipeline gets noisy.</p>
              </div>
            </div>
            <div class="settings-maintenance-stats">
              <span><strong>${maintenance.pendingCount ?? 0}</strong> pending</span>
              <span><strong>${maintenance.scanHistoryRows ?? 0}</strong> scan-history rows</span>
              <span><strong>${maintenance.applicationUrlCount ?? 0}</strong> application URLs</span>
            </div>
            <div class="settings-action-row">
              <button class="btn btn-outline" type="button" id="clear-pending-btn">Clear Pending</button>
              <button class="btn btn-outline" type="button" id="clear-scan-history-btn">Clear Scan History</button>
              <button class="btn btn-outline" type="button" id="rebuild-scan-history-btn">Rebuild Scan History</button>
            </div>
          </section>
        </div>

        <div class="settings-actions">
          <button class="btn btn-primary" id="settings-save" type="submit">Save Settings</button>
        </div>
      </form>
    </div>
  `;

  container.querySelector('#settings-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saveBtn = container.querySelector('#settings-save');
    saveBtn.disabled = true;

    try {
      const limit = Math.max(0, parseInt(container.querySelector('#deep-scan-limit')?.value || '0', 10) || 0);
      localStorage.setItem(SCAN_LIMIT_KEY, String(limit));
      const payload = {
        braveApiKey: container.querySelector('#braveApiKey')?.value || '',
        serperApiKey: container.querySelector('#serperApiKey')?.value || '',
        apolloApiKey: container.querySelector('#apolloApiKey')?.value || '',
        webSearchProvider: container.querySelector('#web-search-provider')?.value || 'auto',
        webSearchOrder: container.querySelector('#web-search-order')?.value || 'brave,serper,scrape',
        deepScanLimit: limit,
        minRelevance: parseFloat(container.querySelector('#min-relevance')?.value || '0') || 0,
        freshnessDays: parseInt(container.querySelector('#freshness-days')?.value || '0', 10) || 0,
        tailscaleMode: container.querySelector('#tailscale-mode')?.value || 'off',
        autoUpdate: Boolean(container.querySelector('#auto-update')?.checked),
        workspacePreference: container.querySelector('#workspace-preference')?.value || 'home',
      };
      const result = await api.updateSettings(payload);
      toast('Settings saved');
      const nextMaintenance = await api.getSettingsMaintenance();
      renderSettings(container, result.settings, nextMaintenance);
    } catch (err) {
      toast(err.message || 'Failed to save settings', 'error');
      saveBtn.disabled = false;
    }
  });

  container.querySelectorAll('[data-clear-secret]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.clearSecret;
      const clearName = `clear${id[0].toUpperCase()}${id.slice(1)}`;
      btn.disabled = true;
      try {
        const result = await api.updateSettings({ [clearName]: true });
        toast('Key cleared');
        const nextMaintenance = await api.getSettingsMaintenance();
        renderSettings(container, result.settings, nextMaintenance);
      } catch (err) {
        toast(err.message || 'Failed to clear key', 'error');
        btn.disabled = false;
      }
    });
  });

  bindBackupControls(container);
  bindUpdateControls(container);
  bindMaintenanceControls(container, settings);
}

function secretField({ id, label, description, secret }) {
  const configured = Boolean(secret?.configured);
  const source = secret?.source ? ` from ${secret.source}` : '';
  return `
    <div class="settings-field settings-secret-field">
      <div class="settings-field-top">
        <label class="form-label" for="${id}">${esc(label)}</label>
        <span class="settings-status ${configured ? 'is-on' : 'is-off'}">${configured ? `Configured${esc(source)}` : 'Not set'}</span>
      </div>
      <div class="settings-secret-input">
        <input class="form-input" id="${id}" type="password" autocomplete="off" spellcheck="false"
          placeholder="${configured ? 'Configured, leave blank to keep' : 'Paste key'}">
        <button class="btn btn-sm btn-outline" type="button" data-clear-secret="${id}" ${configured ? '' : 'disabled'}>Clear</button>
      </div>
      <span class="settings-help">${esc(description)}</span>
    </div>
  `;
}

function providerOption(value, label, current) {
  return `<option value="${value}" ${current === value ? 'selected' : ''}>${esc(label)}</option>`;
}

function providerOrderOption(value, label, current) {
  return `<option value="${value}" ${current === value ? 'selected' : ''}>${esc(label)}</option>`;
}

function freshnessOption(value, label, current) {
  return `<option value="${value}" ${Number(current) === value ? 'selected' : ''}>${esc(label)}</option>`;
}

function tailscaleModeOption(value, label, current) {
  return `<option value="${value}" ${current === value ? 'selected' : ''}>${esc(label)}</option>`;
}

function workspacePreferenceOption(value, label, current) {
  return `<option value="${value}" ${current === value ? 'selected' : ''}>${esc(label)}</option>`;
}

function configuredCount(secrets) {
  return Object.values(secrets || {}).filter((s) => s?.configured).length;
}

function bindBackupControls(container) {
  const restoreBtn = container.querySelector('#settings-restore-btn');
  const restoreInput = container.querySelector('#settings-restore-file');
  if (!restoreBtn || !restoreInput) return;
  restoreBtn.onclick = () => restoreInput.click();
  restoreInput.onchange = async () => {
    const file = restoreInput.files?.[0];
    if (!file) return;
    const ok = await confirmModal({
      title: `Restore from ${esc(file.name)}?`,
      body: `<p style="font-size:14px;color:var(--subtext);margin-bottom:8px">This overwrites user data from the backup zip.</p><p style="font-size:13px;color:var(--subtext0)">System files and code are not touched.</p>`,
      confirmText: 'Restore',
      danger: true,
    });
    if (!ok) { restoreInput.value = ''; return; }
    try {
      const result = await api.restoreBackup(file);
      toast(`Restored ${result.written} files${result.skipped ? `, ${result.skipped} skipped` : ''}`);
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      toast(`Restore failed: ${err.message}`, 'error');
    } finally {
      restoreInput.value = '';
    }
  };
}

function bindUpdateControls(container) {
  const card = container.querySelector('#update-status-card');
  const checkBtn = container.querySelector('#check-updates-btn');
  const applyBtn = container.querySelector('#apply-update-btn');
  const gitPullBtn = container.querySelector('#git-pull-btn');
  const restartBtn = container.querySelector('#restart-dashboard-btn');
  if (!card || !checkBtn || !applyBtn) return;

  const installKindLabel = (kind) => {
    if (kind === 'npm-global') return 'npm install';
    if (kind === 'git-checkout') return 'git clone';
    return 'unknown';
  };

  const renderStatus = (status) => {
    const supported = status.supported !== false;
    const available = Boolean(status.updateAvailable);
    applyBtn.disabled = !supported || !available || status.canUpdate === false;
    if (restartBtn) {
      restartBtn.disabled = !status.restartSupported;
      restartBtn.title = status.restartSupported
        ? 'Restart the dashboard process and reconnect this page'
        : 'Restart available only when the dashboard was launched through catabull or start.mjs';
    }
    if (gitPullBtn) {
      gitPullBtn.disabled = !status.canGitPull;
      gitPullBtn.title = status.installKind === 'git-checkout'
        ? (status.canGitPull
            ? 'Runs git pull --ff-only against origin/main'
            : (status.dirty
                ? 'Local uncommitted changes block git pull — commit or stash first'
                : 'No remote commits ahead of local'))
        : 'Dev installs only: this is greyed out for npm-installed CataBull';
    }

    const headline = !supported ? 'Updates unavailable'
      : available ? 'Update available'
      : 'CataBull is up to date';
    const message = status.message || '';
    const versionLine = status.localVersion || status.remoteVersion
      ? `<span>Local v${esc(status.localVersion || 'unknown')}${status.remoteVersion ? ` · Remote v${esc(status.remoteVersion)}` : ''}</span>`
      : '';
    const commitLine = status.installKind === 'git-checkout' && (status.localCommit || status.remoteCommit)
      ? `<span>Commit ${esc(status.localCommit || '–')} → ${esc(status.remoteCommit || '–')}${status.branch ? ` on ${esc(status.branch)}` : ''}${status.dirty ? ' · dirty tree' : ''}</span>`
      : '';
    const kindLine = status.installKind
      ? `<span class="update-status-kind">Install: ${esc(installKindLabel(status.installKind))}</span>`
      : '';
    const meta = (versionLine || commitLine || kindLine)
      ? `<div class="update-status-meta">${versionLine}${commitLine}${kindLine}</div>`
      : '';
    card.innerHTML = `<strong>${esc(headline)}</strong><span>${esc(message)}</span>${meta}`;
  };

  const check = async () => {
    checkBtn.disabled = true;
    card.innerHTML = '<span><span class="spinner"></span> Checking update status</span>';
    try {
      renderStatus(await api.checkUpdates());
    } catch (err) {
      card.innerHTML = `<strong>Check failed</strong><span>${esc(err.message || 'Could not check for updates')}</span>`;
      toast(err.message || 'Could not check for updates', 'error');
    } finally {
      checkBtn.disabled = false;
    }
  };

  checkBtn.addEventListener('click', check);
  applyBtn.addEventListener('click', async () => {
    applyBtn.disabled = true;
    if (gitPullBtn) gitPullBtn.disabled = true;
    card.innerHTML = '<span><span class="spinner"></span> Running npm install -g github:your-github-user/catabull (this can take a minute)</span>';
    try {
      const result = await api.applyUpdate();
      card.innerHTML = `<strong>Update installed</strong><span>${esc(result.message || 'Restart dashboard to finish.')}</span>`;
      toast(result.message || 'CataBull updated. Restart dashboard to finish.');
    } catch (err) {
      card.innerHTML = `<strong>Update failed</strong><span>${esc(err.message || 'Could not apply update')}</span>`;
      toast(err.message || 'Could not apply update', 'error');
      applyBtn.disabled = false;
    }
  });

  if (gitPullBtn) {
    gitPullBtn.addEventListener('click', async () => {
      gitPullBtn.disabled = true;
      applyBtn.disabled = true;
      card.innerHTML = '<span><span class="spinner"></span> Running git pull --ff-only</span>';
      try {
        const result = await api.gitPullUpdate();
        card.innerHTML = `<strong>Pulled from git</strong><span>${esc(result.message || 'Restart dashboard to finish.')}</span>`;
        toast(result.message || 'CataBull updated via git pull. Restart dashboard to finish.');
      } catch (err) {
        card.innerHTML = `<strong>Git pull failed</strong><span>${esc(err.message || 'Could not run git pull')}</span>`;
        toast(err.message || 'Could not run git pull', 'error');
      } finally {
        // Re-derive button state from a fresh status, since dirty/clean and
        // commit deltas may have shifted after a pull or a failure.
        try { renderStatus(await api.getUpdateStatus()); } catch { /* leave buttons disabled until next manual check */ }
      }
    });
  }

  if (restartBtn) {
    restartBtn.addEventListener('click', async () => {
      restartBtn.disabled = true;
      checkBtn.disabled = true;
      applyBtn.disabled = true;
      if (gitPullBtn) gitPullBtn.disabled = true;
      card.innerHTML = '<span><span class="spinner"></span> Restarting dashboard and waiting for it to come back</span>';
      try {
        const result = await api.restartDashboard();
        toast(result.message || 'Dashboard restarting...');
        await waitForDashboardReload();
      } catch (err) {
        card.innerHTML = `<strong>Restart failed</strong><span>${esc(err.message || 'Could not restart dashboard')}</span>`;
        toast(err.message || 'Could not restart dashboard', 'error');
        try { renderStatus(await api.getUpdateStatus()); } catch {
          checkBtn.disabled = false;
          applyBtn.disabled = false;
          if (gitPullBtn) gitPullBtn.disabled = false;
        }
      }
    });
  }

  api.getUpdateStatus().then(renderStatus).catch(() => check());
}

function bindMaintenanceControls(container) {
  container.querySelector('#clear-pending-btn')?.addEventListener('click', async () => {
    const ok = await confirmModal({
      title: 'Clear all pending roles?',
      body: '<p style="font-size:14px;color:var(--subtext);margin-bottom:8px">This removes unchecked Pending roles from pipeline.md. Evaluated, skipped, expired, and applied records stay in place.</p>',
      confirmText: 'Clear Pending',
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await api.deleteAllPending();
      toast(`Removed ${result.removed || 0} pending role${result.removed === 1 ? '' : 's'}`);
      const [nextSettings, nextMaintenance] = await Promise.all([api.getSettings(), api.getSettingsMaintenance()]);
      renderSettings(container, nextSettings, nextMaintenance);
    } catch (err) {
      toast(`Clear failed: ${err.message}`, 'error');
    }
  });

  container.querySelector('#clear-scan-history-btn')?.addEventListener('click', async () => {
    const ok = await confirmModal({
      title: 'Clear scan history?',
      body: '<p style="font-size:14px;color:var(--subtext);margin-bottom:8px">This resets scan dedupe history. Existing pending and application rows are not removed.</p>',
      confirmText: 'Clear History',
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await api.clearScanHistory();
      toast(`Cleared ${result.removed || 0} scan-history row${result.removed === 1 ? '' : 's'}`);
      const nextSettings = await api.getSettings();
      renderSettings(container, nextSettings, result.maintenance);
    } catch (err) {
      toast(`Clear failed: ${err.message}`, 'error');
    }
  });

  container.querySelector('#rebuild-scan-history-btn')?.addEventListener('click', async () => {
    const ok = await confirmModal({
      title: 'Rebuild scan history?',
      body: '<p style="font-size:14px;color:var(--subtext);margin-bottom:8px">This rebuilds dedupe history from current pipeline and application URLs.</p>',
      confirmText: 'Rebuild',
    });
    if (!ok) return;
    try {
      const result = await api.rebuildScanHistory();
      toast(`Rebuilt ${result.rows || 0} scan-history row${result.rows === 1 ? '' : 's'}`);
      const nextSettings = await api.getSettings();
      renderSettings(container, nextSettings, result.maintenance);
    } catch (err) {
      toast(`Rebuild failed: ${err.message}`, 'error');
    }
  });
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
