const BASE = '/api/v1';

let reloadingForAuth = false;

export function buildAuthRefreshLocation(location = window.location) {
  const pathname = location?.pathname || '/';
  const params = new URLSearchParams(location?.search || '');
  params.set('cb_session_refresh', String(Date.now()));
  const search = params.toString();
  const hash = location?.hash || '';
  return `${pathname}${search ? `?${search}` : ''}${hash}`;
}

export async function waitForDashboardReload({ timeoutMs = 30_000, intervalMs = 500, path } = {}) {
  const target = path || buildAuthRefreshLocation(window.location);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(target, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Cache-Control': 'no-store' },
      });
      if (res.ok) {
        window.location.replace(target);
        return true;
      }
    } catch {
      // Server likely still restarting.
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  window.location.replace(target);
  return false;
}

async function request(path, opts = {}) {
  const headers = { ...opts.headers };
  const body = opts.body ? JSON.stringify(opts.body) : undefined;
  if (body) headers['Content-Type'] = 'application/json';
  // credentials: 'same-origin' is the default for same-origin requests,
  // but be explicit so the session cookie always rides along even if a
  // future caller hands us absolute URLs.
  const res = await fetch(BASE + path, { ...opts, headers, body, credentials: 'same-origin' });
  // If the server restarts mid-session, the cookie's token becomes
  // stale and every subsequent API call returns 401. A plain reload can
  // get a cached 304 for `/`, which does not reissue Set-Cookie and traps
  // the page in a reload loop. Force a one-shot cache-busting navigation
  // instead. Guard with a flag so a flurry of failed requests doesn't
  // trigger a navigation storm.
  if (res.status === 401 && !reloadingForAuth) {
    reloadingForAuth = true;
    try { window.location.replace(buildAuthRefreshLocation(window.location)); } catch {}
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  // Onboarding
  onboardingStatus: () => request('/onboarding/status'),
  onboardingCV: (content) => request('/onboarding/cv', { method: 'POST', body: { content } }),
  onboardingProfile: (data) => request('/onboarding/profile', { method: 'POST', body: data }),
  onboardingPortals: (opts = {}) => request('/onboarding/portals', { method: 'POST', body: opts }),
  onboardingTracker: () => request('/onboarding/tracker', { method: 'POST' }),
  onboardingAgent: (name) => request('/onboarding/agent', { method: 'POST', body: { name } }),
  onboardingCvAnalyze: (text, { signal } = {}) => request('/onboarding/cv-analyze', { method: 'POST', body: { text }, signal }),
  onboardingGenerateProfile: () => request('/onboarding/generate-profile', { method: 'POST', body: {} }),
  onboardingDiscoverCompanies: ({ target } = {}) =>
    request('/onboarding/discover-companies', { method: 'POST', body: { target } }),

  // Applications
  getApplications: () => request('/applications'),
  getContextualScores: (urls = []) => request('/applications/contextual-scores', { method: 'POST', body: { urls } }),
  updateApplication: (num, status) => request(`/applications/${num}`, { method: 'PATCH', body: { status } }),

  // Tailor bundle (PR 1.5)
  tailor: ({ company, role, url, jd, agent } = {}) =>
    request('/tailor', { method: 'POST', body: { company, role, url, jd, agent } }),
  tailorFileUrl: (relPath) => `/api/v1/tailor/file?path=${encodeURIComponent(relPath)}`,

  // Deep Scan via Level 3 Node helper. Returns an EventSource the caller
  // can subscribe to. Spec: Level 3 node-helper design notes.
  scanDeepStream: ({ limit } = {}) => {
    const qs = limit ? `?limit=${encodeURIComponent(limit)}` : '';
    return new EventSource(`${BASE}/scan/deep${qs}`);
  },

  // Pipeline actions
  skipPending: (url) => request('/pipeline/skip', { method: 'POST', body: { url } }),
  unskipPending: (url) => request('/pipeline/unskip', { method: 'POST', body: { url } }),
  applyPending: (url, company, role) => request('/pipeline/apply', { method: 'POST', body: { url, company, role } }),
  deleteAllPending: () => request('/pipeline/delete-pending', { method: 'POST', body: {} }),
  deletePending: (urls) => request('/pipeline/delete', { method: 'POST', body: { urls } }),
  updatePending: ({ url, company, role, postedAt, location } = {}) =>
    request('/pipeline/item', { method: 'PATCH', body: { url, company, role, postedAt, location } }),
  addPending: ({ url, company, role, postedAt, location } = {}) =>
    request('/pipeline/add', { method: 'POST', body: { url, company, role, postedAt, location } }),

  // Reports
  getReports: () => request('/reports'),
  getReport: (filename) => request(`/reports/${encodeURIComponent(filename)}`),
  archiveReport: (filename) => request(`/reports/${encodeURIComponent(filename)}/archive`, { method: 'POST', body: {} }),
  reportExportUrl: (filename) => `/api/v1/reports/${encodeURIComponent(filename)}/export.zip`,

  // Metrics
  getMetrics: () => request('/metrics'),
  getPatternsMetrics: () => request('/metrics/patterns'),
  getFollowupMetrics: () => request('/metrics/followup'),

  // Profile
  getProfile: () => request('/profile'),
  updateProfile: (data) => request('/profile', { method: 'PUT', body: data }),
  patchProfile: (data) => request('/profile', { method: 'PATCH', body: data }),
  getProfileMarkdown: () => request('/profile/markdown'),
  updateProfileMarkdown: (content) => request('/profile/markdown', { method: 'PUT', body: { content } }),

  // Settings
  getSettings: () => request('/settings'),
  updateSettings: (data) => request('/settings', { method: 'PUT', body: data }),
  getSettingsMaintenance: () => request('/settings/maintenance'),
  getUpdateStatus: () => request('/updates/status'),
  checkUpdates: () => request('/updates/check', { method: 'POST', body: {} }),
  applyUpdate: () => request('/updates/apply', { method: 'POST', body: {} }),
  gitPullUpdate: () => request('/updates/git-pull', { method: 'POST', body: {} }),
  restartDashboard: () => request('/updates/restart', { method: 'POST', body: {} }),
  clearScanHistory: () => request('/settings/maintenance/clear-scan-history', { method: 'POST', body: {} }),
  rebuildScanHistory: () => request('/settings/maintenance/rebuild-scan-history', { method: 'POST', body: {} }),

  // Memory
  getMemory: () => request('/memory'),
  updateMemory: (id, data) => request(`/memory/${encodeURIComponent(id)}`, { method: 'PATCH', body: data }),
  deleteMemory: (id) => request(`/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // CV
  getCV: (path) => request(path ? `/cv?path=${encodeURIComponent(path)}` : '/cv'),
  updateCV: (content, path) => request('/cv', { method: 'PUT', body: { content, path: path || 'cv.md' } }),
  listCVs: () => request('/cv/list'),
  cvDownloadUrl: (path) => `/api/v1/cv/download?path=${encodeURIComponent(path)}`,

  // Portals
  getPortals: () => request('/portals'),
  getPortalsProviders: () => request('/portals/providers'),
  updatePortals: (data) => request('/portals', { method: 'PUT', body: data }),
  toggleCompany: (name, enabled) => request(`/portals/companies/${encodeURIComponent(name)}`, { method: 'PATCH', body: { enabled } }),
  addCompany: (company) => request('/portals/companies', { method: 'POST', body: company }),
  updateCompany: (name, company) => request(`/portals/companies/${encodeURIComponent(name)}`, { method: 'PUT', body: company }),
  deleteCompany: (name) => request(`/portals/companies/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  scanCompany: (name, limit = 0) => request(`/portals/companies/${encodeURIComponent(name)}/scan`, { method: 'POST', body: { limit } }),
  getCompanyMetrics: (name) => request(`/portals/companies/${encodeURIComponent(name)}/metrics`),
  getPortalsMetrics: () => request('/portals/metrics'),
  updateFilters: (filters) => request('/portals/filters', { method: 'PATCH', body: filters }),

  // Actions
  runScan: (dryRun = false) => request('/actions/scan', { method: 'POST', body: { dryRun } }),

  // Scan scheduler
  getScanStatus: () => request('/scan/status'),
  getScanRunState: () => request('/scan/run-state'),
  setScanSchedule: (schedule) => request('/scan/schedule', { method: 'PUT', body: { schedule } }),
  runScanNow: (limit) => request('/scan/run', { method: 'POST', body: { limit: limit || 0 } }),
  runQuickScanStream: ({ limit } = {}) => {
    const qs = limit ? `?limit=${encodeURIComponent(limit)}` : '';
    return new EventSource(`${BASE}/scan/run/stream${qs}`);
  },
  runScanDiagnostics: (limit) => request('/scan/diagnose', { method: 'POST', body: { limit: limit || 0 } }),

  // Liveness
  checkLivenessAll: () => request('/liveness/check-all', { method: 'POST', body: {} }),
  expireUrl: (url) => request('/liveness/expire', { method: 'POST', body: { url } }),

  // Terminal agent detection (claude / codex / opencode / gemini on PATH)
  terminalAgents: () => request('/terminal/agents'),
  testAgent: (name) => request('/terminal/test', { method: 'POST', body: { name } }),
  runTerminalPrompt: (agent, prompt, { signal, timeoutMs, continueSession, sessionId } = {}) => request('/terminal/run', { method: 'POST', body: { agent, prompt, timeoutMs, continueSession, sessionId }, signal }),
  deleteUserProfile: (confirmName) => request('/profile', { method: 'DELETE', body: { confirmName } }),

  // Multiple profiles
  listProfiles: () => request('/profiles'),
  archiveCurrentProfile: (label) => request('/profiles/archive-current', { method: 'POST', body: { label } }),
  createNewProfile: (label) => request('/profiles/new', { method: 'POST', body: { label } }),
  switchProfile: (id) => request(`/profiles/${encodeURIComponent(id)}/switch`, { method: 'POST', body: {} }),
  deleteStoredProfile: (id) => request(`/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Scan health
  getHealthStatus: () => request('/health/status'),
  runHealthCheck: ({ includeDisabled = false, company = null } = {}) =>
    request('/health/check', { method: 'POST', body: { includeDisabled, company } }),
  recheckHealthCompany: (name) =>
    request(`/health/check/${encodeURIComponent(name)}`, { method: 'POST', body: {} }),

  // W8 — URL recovery for auto-disabled companies
  recoverHealthCompany: (name) =>
    request(`/health/recover/${encodeURIComponent(name)}`, { method: 'POST', body: {} }),
  acceptHealthRecovery: (name, url) =>
    request(`/health/recover/${encodeURIComponent(name)}/accept`, { method: 'POST', body: { url } }),

  // Backup / restore
  backupDownloadUrl: () => '/api/v1/backup',
  restoreBackup: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/v1/backup/restore', { method: 'POST', body: fd, credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
};
