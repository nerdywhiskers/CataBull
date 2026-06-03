import { api } from '../api.mjs';
import { toast } from './toast.mjs';

const DISMISS_KEY = 'catabull-update-dismissed-commit';
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

let bannerEl = null;
let checkTimer = null;
let applying = false;

export async function initUpdateNotifier() {
  await safeCheck({ quiet: true });
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = setInterval(() => safeCheck({ quiet: true }), CHECK_INTERVAL_MS);
}

export async function safeCheck({ quiet = false } = {}) {
  try {
    const settings = await api.getSettings();
    const updates = settings.updates || {};
    const status = await api.checkUpdates();

    if (!status.supported) return hideBanner();
    if (!status.updateAvailable) return hideBanner();
    if (status.showUpdateBanner === false) return hideBanner();

    if (updates.autoUpdate) {
      return applyAvailableUpdate({ auto: true });
    }

    const dismissKey = status.remoteCommit || status.remoteVersion || '';
    const dismissed = localStorage.getItem(DISMISS_KEY);
    if (dismissed && dismissKey && dismissed === dismissKey) return;
    showBanner(status);
  } catch (err) {
    if (!quiet) toast(err.message || 'Could not check for updates', 'error');
  }
}

export async function applyAvailableUpdate({ auto = false } = {}) {
  if (applying) return;
  applying = true;
  showBanner({ status: 'updating', message: auto ? 'Auto update is running…' : 'Updating CataBull…' });
  try {
    const result = await api.applyUpdate();
    showBanner({ status: 'updated', message: result.message || 'CataBull updated. Restart dashboard to finish.' });
    toast(result.message || 'CataBull updated. Restart dashboard to finish.');
  } catch (err) {
    showBanner({ status: 'error', message: err.message || 'Update failed. Check settings for details.' });
    toast(err.message || 'Update failed', 'error');
  } finally {
    applying = false;
  }
}

function showBanner(status) {
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.className = 'update-notification';
    bannerEl.setAttribute('role', 'status');
    document.body.appendChild(bannerEl);
  }

  const isUpdating = status.status === 'updating';
  const isDone = status.status === 'updated';
  const isError = status.status === 'error';
  const title = isDone ? 'Update installed' : isError ? 'Update failed' : isUpdating ? 'Updating CataBull' : 'CataBull update available';
  const remoteLabel = status.remoteVersion ? `v${status.remoteVersion}` : status.remoteCommit ? `build ${status.remoteCommit}` : '';
  const message = status.message || (remoteLabel ? `New ${remoteLabel} is ready.` : 'A new update is ready.');
  const updateDisabled = isUpdating || isDone || isError;

  bannerEl.innerHTML = `
    <div class="update-notification-copy">
      <strong>${esc(title)}</strong>
      <span>${esc(message)}</span>
    </div>
    <div class="update-notification-actions">
      ${updateDisabled ? '' : '<button class="btn btn-primary btn-sm" type="button" data-update-action="apply">Update</button>'}
      <button class="btn btn-outline btn-sm" type="button" data-update-action="dismiss">${isDone || isError ? 'Close' : 'Dismiss'}</button>
    </div>
  `;

  bannerEl.querySelector('[data-update-action="apply"]')?.addEventListener('click', () => applyAvailableUpdate());
  bannerEl.querySelector('[data-update-action="dismiss"]')?.addEventListener('click', () => {
    const dismissKey = status.remoteCommit || status.remoteVersion || '';
    if (dismissKey) localStorage.setItem(DISMISS_KEY, dismissKey);
    hideBanner();
  });
}

function hideBanner() {
  if (bannerEl) bannerEl.remove();
  bannerEl = null;
}

function esc(value) {
  return String(value || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
