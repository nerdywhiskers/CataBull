/**
 * scan/health.mjs — Per-company portal health check
 *
 * Pure HTTP + Playwright probe that classifies each tracked company
 * into a health status without burning agent credits. Designed to
 * run before scans (or weekly) so dead URLs / bot blocks / unsupported
 * ATS platforms surface as actionable warnings instead of mid-scan
 * errors.
 *
 * See docs/archive/SCAN_RELIABILITY.md (workstream W1) for the design.
 */

import { resolveProvider } from './providers/index.mjs';
import { disposeBrowser as disposeWebfetchBrowser } from './providers/webfetch.mjs';

const FETCH_TIMEOUT_MS = 8000;
const HEALTH_CONCURRENCY = 8;

// W4 — auto-recovery threshold. After this many consecutive non-OK
// health checks, the company is auto-disabled and an entry is logged
// to data/scan-health.log. The user can flip enabled back to true to
// reset the counter.
export const AUTO_DISABLE_THRESHOLD = 3;

// Statuses that count as "ok" for the consecutive_failures counter.
// `empty` is treated as ok because zero open postings is a valid state
// (paused hiring), not a portal failure.
const OK_STATUSES = new Set(['healthy', 'empty']);

export function isHealthyStatus(status) {
  return OK_STATUSES.has(status);
}

// Status taxonomy. Order matches the archived SCAN_RELIABILITY.md design doc.
export const HEALTH_STATUSES = [
  'healthy',        // 2xx + parseable jobs
  'empty',          // 2xx but zero jobs (paused hiring? selector miss?)
  'not_found',      // 4xx 404/410 — slug likely dead, propose new URL
  'redirected',     // 3xx to a different host
  'bot_blocked',    // anti-bot block (HTTP/2 errors, Cloudflare, captcha)
  'unknown_ats',    // careers_url loads but webfetch found nothing
  'network_error',  // timeout / DNS / 5xx — usually transient
  'no_provider',    // company config doesn't resolve to any provider
];

// Patterns we treat as bot-blocking signals. These are checked against
// the error message string from fetch / Playwright.
const BOT_BLOCKED_PATTERNS = [
  /ERR_HTTP2_PROTOCOL_ERROR/i,
  /ERR_SSL_PROTOCOL_ERROR/i,
  /403/, // Cloudflare often returns 403 to bots
  /cloudflare/i,
  /access denied/i,
  /captcha/i,
  /attention required/i,
];

const NOT_FOUND_PATTERNS = [
  /HTTP 404/,
  /HTTP 410/,
  /\b404\b/,
  /\b410\b/,
];

const NETWORK_ERROR_PATTERNS = [
  /timeout/i,
  /aborted/i,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ENETUNREACH/,
  /EAI_AGAIN/,
  /fetch failed/i,
  /HTTP 5\d{2}/,
];

function classifyError(message) {
  const m = String(message || '');
  if (BOT_BLOCKED_PATTERNS.some((re) => re.test(m))) return 'bot_blocked';
  if (NOT_FOUND_PATTERNS.some((re) => re.test(m))) return 'not_found';
  if (NETWORK_ERROR_PATTERNS.some((re) => re.test(m))) return 'network_error';
  // Catch-all: anything we don't recognize gets logged as unknown_ats so
  // it surfaces for review rather than silently going to network_error.
  return 'unknown_ats';
}

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// API providers (greenhouse / ashby / lever) — quick HTTP probe.
async function checkApiProvider(company, provider) {
  const url = provider.buildUrl(company);
  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch (err) {
    return {
      status: classifyError(err.message),
      provider: provider.name,
      probedUrl: url,
      error: err.message,
    };
  }

  // Treat manual redirects as redirected; if the destination matches the
  // same host we accept it (some boards 301 to themselves).
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') || '';
    let crossHost = false;
    try {
      const target = new URL(location, url);
      const original = new URL(url);
      crossHost = target.hostname !== original.hostname;
    } catch { /* malformed */ }
    return {
      status: crossHost ? 'redirected' : 'healthy',
      provider: provider.name,
      probedUrl: url,
      httpStatus: res.status,
      redirectTo: location,
    };
  }

  if (res.status === 404 || res.status === 410) {
    return {
      status: 'not_found',
      provider: provider.name,
      probedUrl: url,
      httpStatus: res.status,
      error: `${provider.name}: HTTP ${res.status}`,
    };
  }

  if (res.status === 403) {
    return {
      status: 'bot_blocked',
      provider: provider.name,
      probedUrl: url,
      httpStatus: res.status,
      error: `${provider.name}: HTTP 403`,
    };
  }

  if (res.status >= 500) {
    return {
      status: 'network_error',
      provider: provider.name,
      probedUrl: url,
      httpStatus: res.status,
      error: `${provider.name}: HTTP ${res.status}`,
    };
  }

  if (!res.ok) {
    return {
      status: classifyError(`HTTP ${res.status}`),
      provider: provider.name,
      probedUrl: url,
      httpStatus: res.status,
      error: `${provider.name}: HTTP ${res.status}`,
    };
  }

  // Parse and count jobs to distinguish healthy from empty.
  let json;
  try {
    json = await res.json();
  } catch (err) {
    return {
      status: 'unknown_ats',
      provider: provider.name,
      probedUrl: url,
      httpStatus: res.status,
      error: `Parse failed: ${err.message}`,
    };
  }

  const jobs = provider.parse ? provider.parse(json, company.name) : [];
  return {
    status: jobs.length > 0 ? 'healthy' : 'empty',
    provider: provider.name,
    probedUrl: url,
    httpStatus: res.status,
    jobCount: jobs.length,
    sampleJobs: jobs.slice(0, 10),
  };
}

// Custom-fetch provider — Playwright (webfetch) or POST-based APIs
// (Workday, BambooHR, Teamtailor) all expose a `fetch(company)` method.
// We share the chromium pool with scan.mjs via providers/webfetch.mjs
// so health checks don't spawn an extra browser instance for webfetch.
//
// Zero-job classification differs by provider kind:
//  - Playwright (needsPlaywright: true) → unknown_ats by default; if the
//    sniffer (W5) found ATS candidates in the rendered HTML, we flip to
//    `unknown_ats` but attach `sniffedCandidates` so the dashboard can
//    surface them as "suggested careers_url" pills.
//  - API providers → empty (API succeeded, just no postings)
async function checkCustomFetchProvider(company, provider) {
  const isPlaywright = Boolean(provider.needsPlaywright);
  const probedUrl = company.careers_url || company.api || '';
  try {
    // Providers now return { jobs, meta? }. Old code paths that returned
    // a bare array still work via the back-compat unwrap below.
    const out = await provider.fetch(company);
    const jobs = Array.isArray(out) ? out : (out?.jobs || []);
    const meta = Array.isArray(out) ? null : (out?.meta || null);

    if (jobs.length > 0) {
      return {
        status: 'healthy',
        provider: provider.name,
        probedUrl,
        jobCount: jobs.length,
        sampleJobs: jobs.slice(0, 10),
      };
    }

    // Bot block detected in the rendered HTML (Akamai "Access Denied",
    // Cloudflare challenge, etc.) — surface as bot_blocked so the user
    // knows changing careers_url won't help. Takes precedence over the
    // sniffer because a block page won't have legitimate ATS links to
    // sniff anyway.
    if (meta?.botBlocked) {
      const vendor = meta.botBlocked.vendor || 'WAF';
      return {
        status: 'bot_blocked',
        provider: provider.name,
        probedUrl,
        jobCount: 0,
        sampleJobs: [],
        error: `Blocked by ${vendor} — the host serves a bot-mitigation interstitial instead of the careers page. Changing the URL won't help; try scan_method: jobspy.`,
      };
    }

    // W5 — sniffer found outbound ATS link(s). Status stays unknown_ats
    // so it surfaces as "needs attention", but the candidates ride along
    // for the dashboard's "suggested careers_url" affordance.
    const sniffed = meta?.sniff?.matches?.length ? meta.sniff : null;

    return {
      status: isPlaywright ? 'unknown_ats' : 'empty',
      provider: provider.name,
      probedUrl,
      jobCount: 0,
      sampleJobs: [],
      error: isPlaywright ? 'Page loaded but no recognizable job links found' : undefined,
      ...(sniffed
        ? {
          sniffedCandidates: sniffed.matches,
          suggestedCareersUrl: sniffed.primary?.url || null,
          suggestedProvider: sniffed.primary?.provider || null,
        }
        : {}),
    };
  } catch (err) {
    return {
      status: classifyError(err.message),
      provider: provider.name,
      probedUrl,
      error: err.message,
    };
  }
}

/**
 * Check a single company. Returns a health record:
 *   {
 *     name, status, provider, probedUrl,
 *     httpStatus?, jobCount?, error?, redirectTo?,
 *     checkedAt: ISO timestamp,
 *   }
 */
export async function checkCompany(company) {
  const checkedAt = new Date().toISOString();

  // resolveProvider falls back to webfetch even when the company has no
  // careers_url, which would then crash Playwright on a missing URL.
  // Catch that case explicitly so it surfaces as no_provider.
  if (!company.careers_url && !company.api) {
    return {
      name: company.name,
      status: 'no_provider',
      provider: null,
      probedUrl: '',
      error: 'No careers_url or api configured',
      checkedAt,
    };
  }

  let provider;
  try {
    provider = resolveProvider(company, 'webfetch');
  } catch (err) {
    return {
      name: company.name,
      status: 'no_provider',
      provider: null,
      probedUrl: company.careers_url || company.api || '',
      error: err.message,
      checkedAt,
    };
  }

  if (!provider) {
    return {
      name: company.name,
      status: 'no_provider',
      provider: null,
      probedUrl: company.careers_url || company.api || '',
      error: 'No provider could be resolved for this company',
      checkedAt,
    };
  }

  const result = provider.fetch
    ? await checkCustomFetchProvider(company, provider)
    : await checkApiProvider(company, provider);

  return {
    name: company.name,
    enabled: company.enabled !== false,
    industries: Array.isArray(company.industries) ? company.industries : [],
    checkedAt,
    ...result,
  };
}

/**
 * Check many companies in parallel with a small concurrency cap.
 * Returns { startedAt, finishedAt, summary, companies }.
 */
export async function checkCompanies(companies, { concurrency = HEALTH_CONCURRENCY, onProgress } = {}) {
  const startedAt = new Date().toISOString();
  const results = new Array(companies.length);
  let i = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= companies.length) return;
      const company = companies[idx];
      try {
        results[idx] = await checkCompany(company);
      } catch (err) {
        // Defensive — checkCompany should already have caught everything,
        // but if anything escapes, surface it as network_error.
        results[idx] = {
          name: company.name,
          status: 'network_error',
          provider: null,
          probedUrl: company.careers_url || '',
          error: err.message || 'Unknown error',
          checkedAt: new Date().toISOString(),
        };
      }
      done++;
      if (onProgress) onProgress({ done, total: companies.length, latest: results[idx] });
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, companies.length) },
    () => worker(),
  );
  await Promise.all(workers);

  // Tear down the shared browser if any webfetch checks ran.
  await disposeWebfetchBrowser().catch(() => {});

  const finishedAt = new Date().toISOString();
  const summary = HEALTH_STATUSES.reduce((acc, status) => {
    acc[status] = results.filter((r) => r.status === status).length;
    return acc;
  }, {});

  return { startedAt, finishedAt, summary, companies: results };
}

/**
 * Apply a health check result to a company's prior `health:` block,
 * returning the updated block. Pure function — caller decides whether
 * to write it back to portals.yml.
 *
 * Counter rules:
 *  - status in {healthy, empty} → reset consecutive_failures to 0,
 *    update last_ok to today, clear last_error.
 *  - any other status → increment consecutive_failures, update
 *    last_error.
 *  - last_check is always updated.
 *
 * Auto-disable: when consecutive_failures crosses AUTO_DISABLE_THRESHOLD
 * the caller (W4 dashboard route) flips enabled to false and sets
 * auto_disabled: true on the company. We track that flag here in
 * health so re-enabling clears it cleanly.
 *
 * Exported for testing.
 */
export function applyHealthResult(prior, result) {
  const previous = (prior && typeof prior === 'object') ? prior : {};
  const today = new Date().toISOString().slice(0, 10);
  const ok = isHealthyStatus(result.status);
  const next = {
    ...previous,
    last_check: today,
    last_status: result.status,
    last_error: ok ? null : (result.error || null),
  };
  if (ok) {
    next.last_ok = today;
    next.consecutive_failures = 0;
  } else {
    next.consecutive_failures = (Number(previous.consecutive_failures) || 0) + 1;
  }

  // W5 — preserve sniffed ATS candidates alongside the failure record.
  // When the user adopts the suggestion (or webfetch starts returning
  // jobs again), these get cleared by `clearSniffMetadata`.
  if (result.sniffedCandidates && result.sniffedCandidates.length > 0) {
    next.sniffed_candidates = result.sniffedCandidates.map((c) => ({
      provider: c.provider,
      slug: c.slug,
      url: c.url,
      score: c.score,
    }));
    next.suggested_careers_url = result.suggestedCareersUrl || null;
    next.suggested_provider = result.suggestedProvider || null;
  } else if (ok) {
    // Healthy status clears stale suggestions — the user fixed the URL
    // (or hiring resumed) and the marketing-page sniff is no longer
    // relevant.
    next.sniffed_candidates = null;
    next.suggested_careers_url = null;
    next.suggested_provider = null;
  }

  // Strip null fields for tidier YAML output.
  for (const k of Object.keys(next)) {
    if (next[k] === null || next[k] === undefined) delete next[k];
  }
  return next;
}

/**
 * Decide whether a company should be auto-disabled given its updated
 * health block. Returns { disable: boolean, threshold }.
 *
 * Exported for testing.
 */
export function shouldAutoDisable(health) {
  const failures = Number(health?.consecutive_failures) || 0;
  // W5 — companies with a sniffed ATS candidate are recoverable; the
  // user just needs to update careers_url. Don't auto-disable while a
  // suggestion is pending review — disabling silently would hide the
  // fix from the dashboard.
  const hasSuggestion = Array.isArray(health?.sniffed_candidates) && health.sniffed_candidates.length > 0;
  return {
    disable: failures >= AUTO_DISABLE_THRESHOLD && !hasSuggestion,
    threshold: AUTO_DISABLE_THRESHOLD,
    skippedDueToSuggestion: failures >= AUTO_DISABLE_THRESHOLD && hasSuggestion,
  };
}

/**
 * Suggested action for each status. The dashboard uses these to render
 * the "what should I do about this?" affordance per company.
 */
export function suggestedAction(status) {
  switch (status) {
    case 'healthy': return 'No action needed';
    case 'empty': return 'Manual review — the API returned zero jobs. Hiring paused, or selector mismatch.';
    case 'not_found': return 'Find new careers URL — the slug is dead. Run a WebSearch for the company\'s current careers page.';
    case 'redirected': return 'Update careers_url — the host changed.';
    case 'bot_blocked': return 'WAF blocked the scraper (Akamai/Cloudflare/etc.). Changing careers_url won\'t help — set scan_method: jobspy in portals.yml to scrape via Indeed/LinkedIn instead.';
    case 'unknown_ats': return 'careers_url loads but no job links matched. Run scan to surface sniffed ATS candidates, or switch the URL manually.';
    case 'network_error': return 'Transient — will recheck on next health run. Disable after 3 consecutive failures.';
    case 'no_provider': return 'Add careers_url or api to portals.yml so a provider can be resolved.';
    default: return 'Unknown status';
  }
}
