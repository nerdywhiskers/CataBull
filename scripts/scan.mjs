#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 *   node scan.mjs --limit 25       # cap new offers added to pipeline at 25
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defaultWorkspace } from '../lib/workspace.mjs';
import yaml from 'js-yaml';
import { resolveProvider } from '../scan/providers/index.mjs';
import { disposeBrowser as disposeWebfetchBrowser } from '../scan/providers/webfetch.mjs';
import { buildTitleClassifier } from '../lib/title-filter.mjs';
import { loadEnvFile } from '../lib/load-env.mjs';
import { encodeScanProgress } from '../lib/scan-progress-stream.mjs';
import {
  DEFAULT_MIN_RELEVANCE,
  hasRelevanceSignals,
  rationaleSummary,
  relevanceInputsFrom,
  resolveMinRelevance,
  scorePostingTitle,
} from '../lib/relevance.mjs';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

// Resolve all data paths relative to the script location, not cwd. Otherwise
// running `node /abs/path/to/scan.mjs` from a different working directory
// would silently read/write the wrong files.
// Data root = the user's workspace. CATABULL_WORKSPACE_ROOT (set by the CLI and
// the dashboard when it spawns scripts) wins; otherwise fall back to the package
// dir so a direct run from a git clone keeps working.
const ROOT = defaultWorkspace(resolve(dirname(fileURLToPath(import.meta.url)), '..')).root;
const PORTALS_PATH = join(ROOT, 'portals.yml');
const PROFILE_PATH = join(ROOT, 'config/profile.yml');
const SCAN_HISTORY_PATH = join(ROOT, 'data/scan-history.tsv');
const PIPELINE_PATH = join(ROOT, 'data/pipeline.md');
const APPLICATIONS_PATH = join(ROOT, 'data/applications.md');

// Ensure required directories exist (fresh setup)
mkdirSync(join(ROOT, 'data'), { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;
const MIN_RELEVANCE_ENV_KEY = 'CATABULL_DEEP_SCAN_MIN_RELEVANCE';
const QUICK_MODE_EXCLUDED_PROVIDERS = new Set(['webfetch']);
const SCAN_EVENT_LOG_PATH = join(ROOT, 'data/scan-events.jsonl');

loadEnvFile(ROOT);

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
    postedAt: (j.updated_at || j.first_published_at || '').slice(0, 10),
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
    postedAt: (j.publishedDate || j.updatedAt || '').slice(0, 10),
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 10) : '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Retry transient failures (5xx, 429, 408, network resets, fetch aborts) with
// exponential backoff. Permanent failures (404, parse errors, programming
// bugs) bubble up immediately so we don't waste time retrying them.
const TRANSIENT_RE = /(?:^|[^\d])(5\d{2}|429|408)(?:[^\d]|$)|timeout|aborted|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|fetch failed/i;

async function withRetry(fn, { retries = 2, baseDelayMs = 400 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const msg = String(err?.message || err || '');
      if (!TRANSIENT_RE.test(msg)) break;
      await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

// ── Title filter ────────────────────────────────────────────────────
// Logic lives in lib/title-filter.mjs so lib/discovery.mjs can reuse it.

// ── Dedup ───────────────────────────────────────────────────────────

// Tracking parameters that don't affect job identity. Stripped before dedup
// so the same posting linked from different referrers collapses to one URL.
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'src', 'source', 'ref', 'referrer', 'fbclid', 'gclid', 'mc_cid', 'mc_eid',
]);

// Canonicalize URLs so that trailing-slash, host case, fragment, query order,
// and tracking params don't make duplicates look distinct.
function normalizeUrl(raw) {
  if (!raw) return '';
  const input = String(raw).trim();
  if (!input) return '';
  try {
    const u = new URL(input);
    u.hostname = u.hostname.toLowerCase();
    u.hash = '';
    const filtered = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()));
    filtered.sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    for (const [k, v] of filtered) u.searchParams.append(k, v);
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return input;
  }
}

function loadSeenUrls() {
  const seen = new Set();
  const add = (url) => {
    const n = normalizeUrl(url);
    if (n) seen.add(n);
  };

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function readProfile() {
  if (!existsSync(PROFILE_PATH)) return {};
  try {
    return parseYaml(readFileSync(PROFILE_PATH, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  // Create a minimal structure if the file doesn't exist yet (fresh install).
  if (!existsSync(PIPELINE_PATH)) {
    writeFileSync(PIPELINE_PATH, '# Pipeline\n\n## Pendientes\n\n## Procesadas\n', 'utf-8');
  }

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      formatPipelineLine(o)
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      formatPipelineLine(o)
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

// Shape a pipeline.md row, including the optional posted-date and location
// fields. Location is stripped of pipes/newlines defensively so a stray
// "Remote | US" value can't corrupt the pipe-delimited row.
function formatPipelineLine(o) {
  const datePart = o.postedAt ? ` | posted:${o.postedAt}` : '';
  const locRaw = (o.location || '').toString().replace(/[\n\r|]/g, '').trim();
  const locPart = locRaw ? ` | loc:${locRaw}` : '';
  const matchPart = o.matchTier && o.matchTier !== 'strong' ? ` | match:${o.matchTier}` : '';
  return `- [ ] ${o.url} | ${o.company} | ${o.title}${datePart}${locPart}${matchPart}`;
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

function emitProgress(enabled, payload) {
  if (!enabled) return;
  process.stdout.write(`${encodeScanProgress({ at: new Date().toISOString(), ...payload })}\n`);
}

function appendScanEvent(enabled, payload) {
  if (!enabled) return;
  appendFileSync(SCAN_EVENT_LOG_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const progressOutput = args.includes('--progress');
  const jsonOutput = args.includes('--json');
  const diagnose = args.includes('--diagnose') || jsonOutput;
  const modeFlag = args.indexOf('--mode');
  const mode = modeFlag !== -1 ? String(args[modeFlag + 1] || 'full').toLowerCase() : 'full';
  if (!['full', 'quick'].includes(mode)) throw new Error(`Unknown scan mode: ${mode}`);
  const originalConsoleLog = console.log;
  if (jsonOutput) console.log = () => {};
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag !== -1 ? Math.max(0, parseInt(args[limitFlag + 1], 10)) || 0 : 0;
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error(`Error: portals.yml not found at ${PORTALS_PATH}.`);
    console.error('To fix:');
    console.error('  1. Run "npm run dashboard" and complete the onboarding wizard, OR');
    console.error('  2. Copy templates/portals.example.yml to portals.yml and edit the company list.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const classifyTitle = buildTitleClassifier(config.title_filter);
  const defaultProvider = config.default_provider || 'webfetch';
  const minRelevance = resolveMinRelevance(process.env[MIN_RELEVANCE_ENV_KEY], DEFAULT_MIN_RELEVANCE);
  const relevanceInputs = minRelevance > 0
    ? relevanceInputsFrom({ profile: readProfile(), portals: config })
    : null;
  const relevanceFilterEnabled = Boolean(relevanceInputs && hasRelevanceSignals(relevanceInputs));

  // 2. Filter to enabled companies with a resolvable provider
  const enabledCompanies = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany));

  const resolvedTargets = enabledCompanies
    .map((company) => {
      try {
        return { ...company, _provider: resolveProvider(company, defaultProvider) };
      } catch {
        return { ...company, _provider: null };
      }
    });
  const noProviderCount = resolvedTargets.filter((c) => c._provider === null).length;
  const modeSkippedCount = resolvedTargets.filter((c) => c._provider && mode === 'quick' && QUICK_MODE_EXCLUDED_PROVIDERS.has(c._provider.name)).length;
  const targets = resolvedTargets
    .filter(c => c._provider !== null)
    .filter(c => mode !== 'quick' || !QUICK_MODE_EXCLUDED_PROVIDERS.has(c._provider.name));

  const skippedCount = noProviderCount + modeSkippedCount;

  console.log(`Scanning ${targets.length} companies via provider registry (${skippedCount} skipped${modeSkippedCount ? `, ${modeSkippedCount} excluded from ${mode} mode` : ' - no provider resolved'})`);
  if (dryRun) console.log('(dry run — no files will be written)\n');
  emitProgress(progressOutput, { type: 'run:start', mode, runId, companies: targets.length });
  appendScanEvent(!dryRun, { event: 'run_start', mode, runId, companies: targets.length });

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalRelevanceFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];
  const companyStats = [];

  // W5 — accumulator for sniff results. When a webfetch scan returns
  // zero jobs but its sniffer finds an outbound ATS link (Phase 1), we
  // record the suggestion here so the run summary surfaces it. When a
  // primary candidate is identified (Phase 2), we additionally retry the
  // scan with the detected URL via the right provider.
  const sniffResults = [];

  // Wrap a provider call so the rest of the scan loop can stay shape-
  // agnostic. Old (array) and new ({ jobs, meta }) shapes both flow
  // through here. parse()-based providers haven't been migrated to the
  // new shape (they don't need it — they return data fine), so we wrap
  // their array result here to give scan.mjs uniform downstream handling.
  async function callProvider(provider, company) {
    if (provider.fetch) {
      const out = await provider.fetch(company);
      if (Array.isArray(out)) return { jobs: out };       // back-compat
      return { jobs: out.jobs || [], meta: out.meta || null };
    }
    const json = await fetchJson(provider.buildUrl(company));
    return { jobs: provider.parse(json, company.name) };
  }

  function intakeJobs(jobs, source, stats = null) {
    for (const job of jobs) {
      // Stop collecting once we've hit the user-requested cap. Concurrent
      // tasks may each add a few more before noticing; the final slice
      // below enforces the exact limit.
      if (limit && newOffers.length >= limit) break;
      const match = classifyTitle(job.title);
      if (match.decision === 'skip') {
        totalFiltered++;
        if (stats) stats.filtered++;
        continue;
      }
      let relevance = null;
      let relevanceFactors = null;
      if (relevanceFilterEnabled) {
        const scored = scorePostingTitle(job.title, relevanceInputs);
        relevance = scored.score;
        relevanceFactors = scored.factors;
        if (scored.score < minRelevance) {
          totalRelevanceFiltered++;
          if (stats) stats.relevanceFiltered++;
          continue;
        }
      }
      const normalizedUrl = normalizeUrl(job.url);
      if (seenUrls.has(normalizedUrl)) {
        totalDupes++;
        if (stats) stats.dupes++;
        continue;
      }
      const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
      if (seenCompanyRoles.has(key)) {
        totalDupes++;
        if (stats) stats.dupes++;
        continue;
      }
      // Mark as seen to avoid intra-scan dupes
      seenUrls.add(normalizedUrl);
      seenCompanyRoles.add(key);
      newOffers.push({
        ...job,
        source,
        matchTier: match.tier,
        matchReason: match.reason,
        ...(relevance != null ? {
          relevance,
          relevanceRationale: rationaleSummary(relevanceFactors),
        } : {}),
      });
      if (stats) stats.added++;
    }
  }

  const tasks = targets.map((company, idx) => async () => {
    const provider = company._provider;
    const startedCompanyAt = Date.now();
    emitProgress(progressOutput, {
      type: 'company:start',
      mode,
      runId,
      company: company.name,
      provider: provider.name,
      index: idx + 1,
      total: targets.length,
    });
    const stats = {
      company: company.name,
      provider: provider.name,
      found: 0,
      filtered: 0,
      relevanceFiltered: 0,
      dupes: 0,
      added: 0,
      error: null,
      sniff: null,
      recovered: null,
      durationMs: 0,
    };
    companyStats.push(stats);
    try {
      const { jobs, meta } = await withRetry(() => callProvider(provider, company));
      totalFound += jobs.length;
      stats.found += jobs.length;
      intakeJobs(jobs, provider.name, stats);

      // W5 — Phase 2 auto-retry. webfetch returned zero jobs but the
      // sniffer found a primary ATS candidate. Re-run the scan once
      // with the detected URL through the right provider. Single retry
      // only — no chaining.
      if (jobs.length === 0 && meta?.sniff) {
        sniffResults.push({ company: company.name, sniff: meta.sniff });
        stats.sniff = {
          matches: meta.sniff.matches.length,
          primary: meta.sniff.primary?.url || null,
          provider: meta.sniff.primary?.provider || null,
        };
        const primary = meta.sniff.primary;
        if (primary) {
          try {
            const retryCompany = { ...company, careers_url: primary.url };
            const retryProvider = resolveProvider(retryCompany, defaultProvider);
            // Guard: if resolveProvider returned webfetch itself, the
            // sniffed URL points back at a marketing-shaped page — don't
            // recurse into the same provider that just returned zero.
            if (retryProvider && retryProvider.name !== 'webfetch') {
              const retryResult = await withRetry(() => callProvider(retryProvider, retryCompany));
              if (retryResult.jobs.length > 0) {
                totalFound += retryResult.jobs.length;
                stats.found += retryResult.jobs.length;
                intakeJobs(retryResult.jobs, `${provider.name}→${retryProvider.name}`, stats);
                // Mark sniff as consumed so the summary distinguishes
                // "suggested only" from "auto-recovered".
                sniffResults[sniffResults.length - 1].recovered = {
                  via: retryProvider.name,
                  url: primary.url,
                  jobCount: retryResult.jobs.length,
                };
                stats.recovered = sniffResults[sniffResults.length - 1].recovered;
              }
            }
          } catch (err) {
            // Retry failure is non-fatal — the original webfetch result
            // (zero jobs) and the sniff suggestion both still surface.
            sniffResults[sniffResults.length - 1].retryError = err.message || String(err);
          }
        }
      }
    } catch (err) {
      errors.push({ company: company.name, error: `${provider.name}: ${err.message}` });
      stats.error = `${provider.name}: ${err.message}`;
    } finally {
      stats.durationMs = Date.now() - startedCompanyAt;
      emitProgress(progressOutput, {
        type: 'company:done',
        mode,
        runId,
        company: company.name,
        provider: provider.name,
        index: idx + 1,
        total: targets.length,
        found: stats.found,
        filtered: stats.filtered,
        relevanceFiltered: stats.relevanceFiltered,
        dupes: stats.dupes,
        added: stats.added,
        error: stats.error,
        durationMs: stats.durationMs,
      });
      appendScanEvent(!dryRun, {
        event: 'company_done',
        mode,
        runId,
        company: company.name,
        provider: provider.name,
        found: stats.found,
        filtered: stats.filtered,
        relevanceFiltered: stats.relevanceFiltered,
        dupes: stats.dupes,
        added: stats.added,
        error: stats.error,
        durationMs: stats.durationMs,
      });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // Enforce the exact --limit cap (tasks run concurrently and may overshoot
  // by a few offers before they notice the early-break condition).
  const capped = limit && newOffers.length > limit;
  if (capped) newOffers.length = limit;

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }
  const persistedRecoveries = !dryRun ? persistRecoveredUrls(config, sniffResults, date) : [];
  const durationMs = Date.now() - startedAt;

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  if (minRelevance > 0) {
    const detail = relevanceFilterEnabled
      ? `${totalRelevanceFiltered} removed (< ${minRelevance}/5)`
      : `not applied (no profile/title signals; default is ${minRelevance}/5)`;
    console.log(`Filtered by relevance: ${detail}`);
  }
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}${capped ? ` (capped at --limit ${limit})` : ''}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  // W5 — surface sniff results. Phase 2 auto-recovered runs are flagged
  // separately from "suggestion only" so the user can see at a glance
  // which companies need a portals.yml update vs. which were already
  // recovered for this scan.
  if (sniffResults.length > 0) {
    const recovered = sniffResults.filter((s) => s.recovered);
    const suggestionsOnly = sniffResults.filter((s) => !s.recovered);
    if (recovered.length > 0) {
      console.log(`\nAuto-recovered via outbound ATS link (${recovered.length}):`);
      for (const s of recovered) {
        console.log(`  ↪ ${s.company}: ${s.recovered.jobCount} jobs via ${s.recovered.via} (${s.recovered.url})`);
      }
      if (dryRun) {
        console.log('  Dry run: run without --dry-run to persist recovered careers_url values.');
      } else if (persistedRecoveries.length > 0) {
        console.log(`  Persisted ${persistedRecoveries.length} recovered careers_url value${persistedRecoveries.length === 1 ? '' : 's'} to portals.yml.`);
      }
    }
    if (suggestionsOnly.length > 0) {
      console.log(`\nSniffer found ATS candidates but no jobs to import (${suggestionsOnly.length}):`);
      for (const s of suggestionsOnly) {
        const top = s.sniff.matches[0];
        if (!top) continue;
        const ambiguity = s.sniff.matches.length > 1 ? ` [+${s.sniff.matches.length - 1} more]` : '';
        const why = s.sniff.primary ? '' : ' (primary unclear — review manually)';
        console.log(`  ? ${s.company}: ${top.url} [${top.provider}]${ambiguity}${why}`);
      }
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  const diagnostics = diagnose ? buildDiagnostics(companyStats, sniffResults) : null;
  if (diagnostics && !jsonOutput) {
    console.log('\nProvider diagnostics:');
    for (const p of diagnostics.byProvider) {
      console.log(`  ${p.provider}: ${p.companies} companies, ${p.found} found, ${p.filtered} title-filtered, ${p.relevanceFiltered} relevance-filtered, ${p.dupes} dupes, ${p.added} added, ${p.errors} errors`);
    }
    if (diagnostics.sniffSuggestions.length > 0) {
      console.log(`  Sniff suggestions: ${diagnostics.sniffSuggestions.length}`);
    }
  }

  const summary = {
    success: true,
    runId,
    mode,
    date,
    dryRun,
    durationMs,
    companiesScanned: targets.length,
    skippedNoProvider: noProviderCount,
    skippedByMode: modeSkippedCount,
    totalJobsFound: totalFound,
    filteredByTitle: totalFiltered,
    filteredByRelevance: totalRelevanceFiltered,
    minRelevance,
    relevanceFilterApplied: relevanceFilterEnabled,
    duplicates: totalDupes,
    newOffersAdded: newOffers.length,
    capped,
    limit,
    errors,
    sniffResults,
    persistedRecoveries,
    newOffers,
    ...(diagnostics ? { diagnostics } : {}),
  };

  emitProgress(progressOutput, {
    type: 'run:complete',
    runId,
    mode,
    companies: targets.length,
    totalFound,
    filteredByTitle: totalFiltered,
    filteredByRelevance: totalRelevanceFiltered,
    duplicates: totalDupes,
    added: newOffers.length,
    errors: errors.length,
    durationMs,
  });
  appendScanEvent(!dryRun, {
    event: 'run_complete',
    runId,
    mode,
    companies: targets.length,
    totalFound,
    filteredByTitle: totalFiltered,
    filteredByRelevance: totalRelevanceFiltered,
    duplicates: totalDupes,
    added: newOffers.length,
    errors: errors.length,
    durationMs,
  });

  if (jsonOutput) {
    originalConsoleLog(JSON.stringify(summary, null, 2));
  }

  console.log(`\n→ Run /catabull pipeline to evaluate new offers.`);
}

function buildDiagnostics(companyStats, sniffResults) {
  const byProvider = {};
  for (const s of companyStats) {
    const key = s.provider || 'unknown';
    byProvider[key] ||= { provider: key, companies: 0, found: 0, filtered: 0, relevanceFiltered: 0, dupes: 0, added: 0, errors: 0, sniffed: 0, recovered: 0 };
    byProvider[key].companies++;
    byProvider[key].found += s.found;
    byProvider[key].filtered += s.filtered;
    byProvider[key].relevanceFiltered += s.relevanceFiltered || 0;
    byProvider[key].dupes += s.dupes;
    byProvider[key].added += s.added;
    if (s.error) byProvider[key].errors++;
    if (s.sniff) byProvider[key].sniffed++;
    if (s.recovered) byProvider[key].recovered++;
  }

  return {
    byProvider: Object.values(byProvider).sort((a, b) => b.found - a.found || a.provider.localeCompare(b.provider)),
    companies: companyStats
      .map((s) => ({ ...s }))
      .sort((a, b) => b.added - a.added || b.found - a.found || a.company.localeCompare(b.company)),
    zeroResultCompanies: companyStats
      .filter((s) => s.found === 0 && !s.error)
      .map((s) => s.company)
      .sort((a, b) => a.localeCompare(b)),
    sniffSuggestions: sniffResults.map((s) => ({
      company: s.company,
      primary: s.sniff.primary?.url || null,
      provider: s.sniff.primary?.provider || null,
      matches: s.sniff.matches.length,
      recovered: s.recovered || null,
      retryError: s.retryError || null,
    })),
  };
}

function persistRecoveredUrls(config, sniffResults, date) {
  const recovered = sniffResults.filter((s) => s.recovered?.url);
  if (recovered.length === 0 || !Array.isArray(config.tracked_companies)) return [];

  const persisted = [];
  for (const result of recovered) {
    const company = config.tracked_companies.find((c) => String(c.name || '').toLowerCase() === String(result.company || '').toLowerCase());
    if (!company) continue;
    if (company.careers_url === result.recovered.url) continue;

    const previousUrl = company.careers_url || '';
    company.careers_url = result.recovered.url;
    if (company.provider === 'auto') delete company.provider;
    if (company.scan_method === 'websearch' || company.scan_method === 'webfetch') delete company.scan_method;

    const note = `Auto-updated ${date} from scan sniffer (${result.recovered.via}); previous URL: ${previousUrl || 'none'}`;
    company.notes = [company.notes, note].filter(Boolean).join(' | ');
    persisted.push({ company: company.name, previousUrl, careersUrl: result.recovered.url, provider: result.recovered.via });
  }

  if (persisted.length > 0) {
    writeFileSync(PORTALS_PATH, yaml.dump(config, { lineWidth: -1, noRefs: true }), 'utf-8');
  }
  return persisted;
}

main()
  .catch(err => {
    console.error('Fatal:', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    // Close the pooled chromium instance so the process can exit cleanly
    // (relevant when scan.mjs is spawned by the dashboard rather than from
    // a TTY). If no webfetch fetches ran, this is a no-op.
    return disposeWebfetchBrowser();
  });
