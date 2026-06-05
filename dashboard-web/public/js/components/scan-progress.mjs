function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderScanProgress(progress) {
  if (!progress?.visible) return '';
  const tone = progress.tone || 'running';
  const eyebrow = progress.eyebrow ? `<span class="scan-progress-eyebrow">${esc(progress.eyebrow)}</span>` : '';
  const title = progress.title ? `<strong class="scan-progress-title">${esc(progress.title)}</strong>` : '';
  const detail = progress.detail ? `<span class="scan-progress-detail">${esc(progress.detail)}</span>` : '';
  const meta = progress.meta ? `<span class="scan-progress-meta">${esc(progress.meta)}</span>` : '';
  return `
    <div class="scan-progress scan-progress-${esc(tone)}" aria-live="polite">
      <div class="scan-progress-icon">${tone === 'running' ? '<span class="spinner"></span>' : '<span class="scan-progress-dot"></span>'}</div>
      <div class="scan-progress-copy">
        ${eyebrow}
        ${title}
        ${detail}
        ${meta}
      </div>
    </div>
  `;
}

export function quickProgressFromEvent(data = {}, { mode = 'Quick Scan' } = {}) {
  const stage = String(data.stage || '');
  if (stage === 'quick:start') {
    return {
      visible: true,
      tone: 'running',
      eyebrow: mode,
      title: 'Starting ATS sweep…',
      detail: 'Fast path only. Direct ATS providers, no branded-page scraping.',
      meta: '',
    };
  }
  if (stage === 'quick:scanning') {
    return {
      visible: true,
      tone: 'running',
      eyebrow: mode,
      title: `Scanning ${Number(data.companies) || 0} ATS portals…`,
      detail: 'Direct ATS APIs only. Faster, lower-risk quick path.',
      meta: '',
    };
  }
  if (stage === 'quick:company:start') {
    const idx = Number(data.index) || 0;
    const total = Number(data.total) || 0;
    const provider = data.provider ? ` via ${data.provider}` : '';
    return {
      visible: true,
      tone: 'running',
      eyebrow: mode,
      title: `${data.company || 'Scanning'}${provider}`,
      detail: total ? `Company ${idx}/${total}` : 'Checking next ATS board…',
      meta: '',
    };
  }
  if (stage === 'quick:company:done') {
    const idx = Number(data.index) || 0;
    const total = Number(data.total) || 0;
    const outcome = data.error
      ? `Error: ${data.error}`
      : `${Number(data.found) || 0} found · ${Number(data.added) || 0} added`;
    return {
      visible: true,
      tone: 'running',
      eyebrow: mode,
      title: `${data.company || 'Company'} done`,
      detail: outcome,
      meta: total ? `${idx}/${total} complete` : '',
    };
  }
  if (stage === 'quick:done') {
    return {
      visible: true,
      tone: 'running',
      eyebrow: mode,
      title: 'ATS sweep complete',
      detail: `${Number(data.added) || 0} new roles · ${Number(data.errors) || 0} errors`,
      meta: `${Number(data.totalFound) || 0} jobs found before filtering`,
    };
  }
  return null;
}

export function deepProgressFromEvent(data = {}) {
  const stage = String(data.stage || '');
  const quick = quickProgressFromEvent(data, { mode: 'Deep Scan · Quick phase' });
  if (quick) return quick;
  if (stage === 'l3:start') return { visible: true, tone: 'running', eyebrow: 'Deep Scan · Level 3', title: `Running ${Number(data.enabled_queries) || 0} search queries…`, detail: 'Searching broader job boards beyond tracked portals.', meta: '' };
  if (stage === 'l3:search:start') return { visible: true, tone: 'running', eyebrow: 'Deep Scan · Level 3', title: `${data.queryName || 'Search query'}`, detail: `Query ${Number(data.queryIndex) + 1}/${Number(data.total) || 0}`, meta: 'Collecting candidate postings…' };
  if (stage === 'l3:search:done') return { visible: true, tone: 'running', eyebrow: 'Deep Scan · Level 3', title: `${data.queryName || 'Search query'} done`, detail: `${Number(data.kept) || 0} kept of ${Number(data.hits) || 0} hits`, meta: '' };
  if (stage === 'l3:liveness:start') return { visible: true, tone: 'running', eyebrow: 'Deep Scan · Level 3', title: `Verifying ${Number(data.total) || 0} candidates…`, detail: 'Playwright liveness checks in progress.', meta: '' };
  if (stage === 'l3:liveness:check') return { visible: true, tone: 'running', eyebrow: 'Deep Scan · Level 3', title: `Verifying candidate ${Number(data.index) + 1}/${Number(data.total) || 0}`, detail: data.url || 'Checking role page…', meta: '' };
  if (stage === 'l3:done') return { visible: true, tone: 'running', eyebrow: 'Deep Scan · Level 3', title: 'WebSearch phase complete', detail: `${Number(data.added) || 0} new roles kept`, meta: 'Starting aggregator sweep…' };
  if (stage === 'l4:detect') return { visible: true, tone: 'running', eyebrow: 'Deep Scan · Level 4', title: 'Checking aggregator runtime…', detail: 'Looking for JobSpy support.', meta: '' };
  if (stage === 'l4:skipped') return { visible: true, tone: 'running', eyebrow: 'Deep Scan · Level 4', title: 'Aggregator phase skipped', detail: data.reason || 'Not available', meta: 'Finalizing scan…' };
  if (stage === 'l4:start') return { visible: true, tone: 'running', eyebrow: 'Deep Scan · Level 4', title: `JobSpy across ${Number(data.queries) || 0} queries`, detail: data.runner ? `Runner: ${data.runner}` : 'Aggregator sweep in progress.', meta: '' };
  if (stage === 'l4:query:start') return { visible: true, tone: 'running', eyebrow: 'Deep Scan · Level 4', title: data.query || 'Aggregator query', detail: `Query ${Number(data.queryIndex) + 1}/${Number(data.total) || 0}`, meta: '' };
  if (stage === 'l4:query:done') return { visible: true, tone: 'running', eyebrow: 'Deep Scan · Level 4', title: data.query || 'Aggregator query done', detail: `${Number(data.hits) || 0} hits`, meta: '' };
  if (stage === 'l4:liveness:start') return { visible: true, tone: 'running', eyebrow: 'Deep Scan · Level 4', title: `Verifying ${Number(data.total) || 0} aggregator hits…`, detail: 'Playwright checks in progress.', meta: '' };
  if (stage === 'l4:liveness:check') return { visible: true, tone: 'running', eyebrow: 'Deep Scan · Level 4', title: `Verifying hit ${Number(data.index) + 1}/${Number(data.total) || 0}`, detail: data.url || 'Checking role page…', meta: '' };
  if (stage === 'l4:done') return { visible: true, tone: 'running', eyebrow: 'Deep Scan · Level 4', title: 'Aggregator phase complete', detail: `${Number(data.added) || 0} new roles kept`, meta: 'Finalizing scan…' };
  return null;
}

export function pendingRefreshProgressFromState(state = {}) {
  if (!state?.active) return { visible: false };
  const pendingCount = Number(state.pendingCount) || 0;
  const mode = state.source === 'manual' ? 'Manual Refresh' : 'Auto Refresh';
  const since = Number(state.startedAt) || 0;
  const elapsedSeconds = since ? Math.max(0, Math.round((Date.now() - since) / 1000)) : 0;
  return {
    visible: true,
    tone: 'running',
    eyebrow: mode,
    title: `Verifying ${pendingCount} pending posting${pendingCount === 1 ? '' : 's'}…`,
    detail: 'Playwright checks run one job page at a time. This can take a few minutes.',
    meta: elapsedSeconds > 0 ? `${elapsedSeconds}s elapsed` : '',
  };
}
