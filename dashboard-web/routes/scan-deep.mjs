/**
 * routes/scan-deep.mjs — Deep Scan via Level 3 Node helper (PR 2026-05-15).
 *
 * Replaces the agent-driven Deep Scan flow (modes/scan.md prose spec) with
 * an in-process pipeline that the dashboard runs directly. Runs Quick Scan
 * (Levels 1 + 2, via `node scan.mjs`) first, then Level 3 (`scan/level3.mjs`),
 * streaming progress to the client via Server-Sent Events.
 *
 * GET /scan/deep
 *   query: ?limit=<int>  optional cap on Level 3 survivors
 *   Server-Sent Events stream, one event per JSON payload:
 *     { event: 'progress', stage: 'quick:start'|'quick:done'|'l3:search:start'|... }
 *     { event: 'complete', summary: { ... } }
 *     { event: 'error',    message }
 *
 * Spec: Level 3 node-helper design notes.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { runLevel3, normalizeUrl, extractCompany, extractRole, isAggregatorPage } from '../../scan/level3.mjs';
import { searchWeb, WebSearchError } from '../../scan/websearch.mjs';
import { runJobSpy, detectRunner as detectJobSpyRunner, DEFAULT_SITES as JOBSPY_DEFAULT_SITES } from '../../scan/market/jobspy.mjs';
import { getMarketProvider, listMarketProviders, normalizeMarketProviderName } from '../../scan/market/providers/index.mjs';
import { classifyLiveness } from '../../lib/liveness-core.mjs';
import { isActiveLiveness, normalizeJobBoardLiveness } from '../../lib/job-board-liveness.mjs';
import { checkLinkedInGuestPosting } from '../../lib/linkedin-liveness.mjs';
import { launchChromiumWithRetry } from '../../lib/playwright-launch.mjs';
import { createLineBuffer, parseProgressLine } from '../../lib/scan-progress-stream.mjs';
import { buildTitleClassifier } from '../../lib/title-filter.mjs';
import { loadEnvFile } from '../../lib/load-env.mjs';
import { DEFAULT_MIN_RELEVANCE, hasRelevanceSignals, resolveMinRelevance, scorePostingTitle, rationaleSummary, relevanceInputsFrom } from '../../lib/relevance.mjs';
import { readProfile } from '../lib/writers.mjs';
import { finishScanRun, startScanRun, updateScanRun } from '../lib/scan-run-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, '..', '..');
const DEFAULT_LEVEL4_PROVIDERS = ['jobspy', 'remotive', 'himalayas', 'workingnomads', 'remoteok', 'weworkremotely'];
const DEFAULT_MARKET_PROVIDER_LIMIT = 25;

export function buildDeepScanQueries(portals = {}) {
  const queries = [];
  const add = (query, fallbackName, extra = {}) => {
    const text = String(query?.query || query || '').trim();
    if (!text) return;
    queries.push({
      name: String(query?.name || fallbackName || 'Search query').trim(),
      query: text,
      enabled: query?.enabled !== false,
      ...extra,
    });
  };

  const globalQueries = portals.title_filter?.search_queries || portals.search_queries || [];
  for (const q of globalQueries) add(q, q?.name || 'Search query');

  for (const company of portals.tracked_companies || []) {
    if (!company || company.enabled === false) continue;
    const scanQuery = String(company.scan_query || '').trim();
    if (!scanQuery) continue;
    add(
      { name: `${company.name} - scan_query`, query: scanQuery, enabled: true },
      `${company.name} - scan_query`,
      { companyName: company.name },
    );
  }

  return queries;
}

export default async function (app) {
  const root = app.cataBullRoot;

  app.get('/scan/deep', async (req, reply) => {
    const queryLimit = Math.max(0, parseInt(req.query?.limit, 10) || 0);
    startScanRun(root, {
      mode: 'deep',
      stage: 'quick:start',
      progress: { stage: 'quick:start' },
    });

    // SSE headers. Disable nagling so progress events flush immediately.
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    const send = (event, payload) => {
      if (event === 'progress' && payload?.stage) {
        updateScanRun(root, { stage: payload.stage, progress: payload });
      }
      try {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        // Client disconnected — abort handled by the close listener below.
      }
    };

    let aborted = false;
    reply.raw.on('close', () => { aborted = true; });

    try {
      loadEnvFile(root);
      const scanSettings = readDeepScanSettings(process.env);
      const limit = queryLimit || scanSettings.deepScanLimit;

      // ── Phase 1: Quick Scan (Levels 1 + 2) ──────────────────────────
      send('progress', { stage: 'quick:start' });
      const quickResult = await runQuickScan({ root, limit, onProgress: (p) => send('progress', p) });

      if (aborted) { reply.raw.end(); return; }

      // ── Phase 2: Level 3 (WebSearch + liveness) ────────────────────
      const portals = readPortals(root);
      if (!portals) {
        send('error', { message: 'portals.yml not found — onboarding incomplete?' });
        reply.raw.end();
        return;
      }

      const searchQueries = buildDeepScanQueries(portals);
      const enabledQueries = searchQueries.filter((q) => q?.enabled !== false && q?.query);
      const remainingAfterQuick = limit ? Math.max(0, limit - (quickResult.added || 0)) : 0;

      if (limit && remainingAfterQuick <= 0) {
        send('progress', { stage: 'l3:skipped', reason: 'max roles reached by Quick Scan' });
        finishScanRun(root, { mode: 'deep', status: 'completed', summary: { quick: quickResult, level3: null, level4: null, totalNew: quickResult.added } });
        send('complete', { summary: { quick: quickResult, level3: null, level4: null, totalNew: quickResult.added } });
        reply.raw.end();
        return;
      }

      if (enabledQueries.length === 0) {
        send('progress', { stage: 'l3:skipped', reason: 'no enabled search_queries' });
        finishScanRun(root, { mode: 'deep', status: 'completed', summary: { quick: quickResult, level3: null, totalNew: quickResult.added } });
        send('complete', { summary: { quick: quickResult, level3: null, totalNew: quickResult.added } });
        reply.raw.end();
        return;
      }

      send('progress', { stage: 'l3:start', enabled_queries: enabledQueries.length });

      const { seenUrls, seenCompanyRoles } = loadDedupSets({
        root,
        addedNow: quickResult.addedItems || [],
      });

      // Reuse one chromium for all liveness checks. Closed in the finally.
      let browser = null;
      let page = null;
      const livenessCheck = async (url) => {
        if (!browser) {
          browser = await launchChromiumWithRetry({ headless: true });
          page = await browser.newPage();
        }
        return await classifyByPlaywright(page, url);
      };

      let level3Result;
      let level4Result = null;
      try {
        level3Result = await runLevel3({
          searchQueries,
          titleFilter: portals.title_filter,
          seenUrls,
          seenCompanyRoles,
          totalCap: remainingAfterQuick,
          onProgress: (p) => send('progress', { stage: `l3:${p.stage}`, ...p }),
          webSearch: searchWeb,
          livenessCheck,
        });

        const l3Filter = filterOffersByScanSettings({ root, portals, offers: level3Result.added, settings: scanSettings });
        level3Result.added = l3Filter.kept;
        mergeSkipped(level3Result.skipped, l3Filter.skipped);
        if (l3Filter.skipped.relevance || l3Filter.skipped.stale) {
          send('progress', { stage: 'l3:filtered', kept: l3Filter.kept.length, skipped: l3Filter.skipped });
        }

        // Persist L3 survivors before L4 runs so L4's dedup (against
        // seenUrls + seenCompanyRoles, which are mutated by runLevel3)
        // catches anything L3 just added.
        if (level3Result.added.length > 0) {
          appendToPipeline(root, level3Result.added);
          appendToScanHistory(root, level3Result.added);
        }

        send('progress', {
          stage: 'l3:done',
          added: level3Result.added.length,
          skipped: level3Result.skipped,
          errors: level3Result.errors.length,
        });

        // ── Phase 3: Level 4 (JobSpy aggregator scrape) ───────────────
        // Indeed / Wellfound / ZipRecruiter / Glassdoor / Google Jobs
        // via the Python sidecar. Skips silently if jobspy isn't installed
        // (detected at the wrapper level via runner detection).
        level4Result = await runLevel4({
          root,
          portals,
          remainingCap: limit ? Math.max(0, limit - quickResult.added - level3Result.added.length) : 0,
          seenUrls,
          seenCompanyRoles,
          livenessCheck,
          send,
        });

        if (level4Result?.added?.length > 0) {
          const l4Filter = filterOffersByScanSettings({ root, portals, offers: level4Result.added, settings: scanSettings });
          level4Result.added = l4Filter.kept;
          mergeSkipped(level4Result.skipped, l4Filter.skipped);
          if (l4Filter.skipped.relevance || l4Filter.skipped.stale) {
            send('progress', { stage: 'l4:filtered', kept: l4Filter.kept.length, skipped: l4Filter.skipped });
          }
        }

        if (level4Result?.added?.length > 0) {
          appendToPipeline(root, level4Result.added);
          appendToScanHistory(root, level4Result.added);
        }
      } catch (err) {
        finishScanRun(root, { mode: 'deep', status: 'failed', error: err instanceof WebSearchError ? `WebSearch (${err.provider}): ${err.message}` : (err.message || String(err)) });
        if (err instanceof WebSearchError) {
          send('error', { message: `WebSearch (${err.provider}): ${err.message}`, code: err.code });
        } else {
          send('error', { message: err.message || String(err) });
        }
        reply.raw.end();
        return;
      } finally {
        try { if (page) await page.close(); } catch {}
        try { if (browser) await browser.close(); } catch {}
      }

      const l3Added = level3Result.added.length;
      const l4Added = level4Result?.added?.length || 0;

      const summary = {
        quick: quickResult,
        level3: {
          added: l3Added,
          skipped: level3Result.skipped,
          errors: level3Result.errors,
          perQuery: level3Result.perQuery,
        },
        level4: level4Result,
        totalNew: quickResult.added + l3Added + l4Added,
      };
      send('complete', { summary });
      finishScanRun(root, { mode: 'deep', status: 'completed', summary });
      reply.raw.end();
    } catch (err) {
      finishScanRun(root, { mode: 'deep', status: 'failed', error: err.message || String(err) });
      send('error', { message: err.message || String(err) });
      reply.raw.end();
    }
  });
}

// ── Quick Scan wrapper ──────────────────────────────────────────────

/**
 * Spawn the existing `node scan.mjs` and parse its output. We keep using
 * a subprocess rather than refactoring scan.mjs into a callable so that
 * this PR stays additive — Quick Scan's behavior is unchanged.
 */
function readDeepScanSettings(env = process.env) {
  return {
    deepScanLimit: clampInt(env.CATABULL_DEEP_SCAN_LIMIT, 0, 1000),
    minRelevance: resolveMinRelevance(env.CATABULL_DEEP_SCAN_MIN_RELEVANCE, DEFAULT_MIN_RELEVANCE),
    freshnessDays: clampInt(env.CATABULL_SCAN_FRESHNESS_DAYS, 0, 365),
  };
}

function clampInt(value, min, max) {
  const n = Number(value || 0);
  if (!Number.isInteger(n) || n < min || n > max) return 0;
  return n;
}

function filterOffersByScanSettings({ root, portals, offers, settings }) {
  const minRelevance = Number(settings?.minRelevance || 0);
  const freshnessDays = Number(settings?.freshnessDays || 0);
  const cutoff = freshnessDays > 0 ? isoDaysAgo(freshnessDays) : null;
  const relevanceInputs = minRelevance > 0
    ? relevanceInputsFrom({ profile: readProfile(root), portals })
    : null;
  const inputs = relevanceInputs && hasRelevanceSignals(relevanceInputs) ? relevanceInputs : null;
  const kept = [];
  const skipped = { relevance: 0, stale: 0 };

  for (const offer of offers || []) {
    if (cutoff && offer.postedAt && offer.postedAt < cutoff) {
      skipped.stale++;
      continue;
    }

    if (inputs && minRelevance > 0) {
      const { score, factors } = scorePostingTitle(offer.title || '', inputs);
      if (score < minRelevance) {
        skipped.relevance++;
        continue;
      }
      offer.relevance = score;
      offer.relevanceRationale = rationaleSummary(factors);
    }

    kept.push(offer);
  }

  return { kept, skipped };
}

function isoDaysAgo(days) {
  const dt = new Date();
  dt.setDate(dt.getDate() - days);
  return dt.toISOString().slice(0, 10);
}

function mergeSkipped(target = {}, add = {}) {
  for (const [key, value] of Object.entries(add || {})) {
    target[key] = (target[key] || 0) + (value || 0);
  }
  return target;
}

function runQuickScan({ root, limit, onProgress = () => {} }) {
  return new Promise((resolve) => {
    const args = [join(PACKAGE_ROOT, 'scan.mjs'), '--mode', 'quick', '--progress'];
    if (limit > 0) args.push('--limit', String(limit));

    const env = { ...process.env, CATABULL_WORKSPACE_ROOT: root };
    const child = spawn(process.execPath, args, { cwd: root, env });

    let stdout = '';
    let added = 0;
    let totalFound = 0;
    let totalFiltered = 0;
    let totalDupes = 0;

    const handleLine = (line) => {
      const payload = parseProgressLine(line);
      if (payload?.type === 'run:start') {
        onProgress({ stage: 'quick:scanning', companies: payload.companies || 0 });
      } else if (payload?.type === 'company:start') {
        onProgress({ stage: 'quick:company:start', company: payload.company, provider: payload.provider, index: payload.index, total: payload.total });
      } else if (payload?.type === 'company:done') {
        onProgress({ stage: 'quick:company:done', company: payload.company, provider: payload.provider, index: payload.index, total: payload.total, found: payload.found, added: payload.added, error: payload.error, durationMs: payload.durationMs });
      } else if (payload?.type === 'run:complete') {
        totalFound = payload.totalFound || 0;
        totalDupes = payload.duplicates || 0;
        added = payload.added || 0;
        onProgress({ stage: 'quick:done', companies: payload.companies, totalFound, added, errors: payload.errors || 0, durationMs: payload.durationMs || 0 });
      }

      const m = line.match(/^Scanning (\d+) companies/);
      if (m) onProgress({ stage: 'quick:scanning', companies: parseInt(m[1], 10) });
      const af = line.match(/^Total jobs found:\s+(\d+)/);
      if (af) totalFound = parseInt(af[1], 10);
      const fb = line.match(/^Filtered by title:\s+(\d+)/);
      if (fb) totalFiltered = parseInt(fb[1], 10);
      const db = line.match(/^Duplicates:\s+(\d+)/);
      if (db) totalDupes = parseInt(db[1], 10);
      const nb = line.match(/^New offers added:\s+(\d+)/);
      if (nb) added = parseInt(nb[1], 10);
    };

    const onStdout = createLineBuffer((line) => {
      stdout += `${line}\n`;
      handleLine(line);
    });
    child.stdout.on('data', onStdout);
    child.stderr.on('data', createLineBuffer(handleLine));

    child.on('error', () => resolve({ added: 0, totalFound, totalFiltered, totalDupes, addedItems: [] }));
    child.on('close', () => resolve({ added, totalFound, totalFiltered, totalDupes, addedItems: [] }));
  });
}

// ── Portals + dedup loaders ─────────────────────────────────────────

function readPortals(root) {
  const path = join(root, 'portals.yml');
  if (!existsSync(path)) return null;
  try { return yaml.load(readFileSync(path, 'utf-8')); } catch { return null; }
}

function loadDedupSets({ root, addedNow = [] }) {
  const seenUrls = new Set();
  const seenCompanyRoles = new Set();

  const SCAN_HISTORY_PATH = join(root, 'data', 'scan-history.tsv');
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) {
      const url = line.split('\t')[0];
      if (url) seenUrls.add(normalizeUrl(url));
    }
  }

  const PIPELINE_PATH = join(root, 'data', 'pipeline.md');
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seenUrls.add(normalizeUrl(match[1]));
    }
  }

  const APPLICATIONS_PATH = join(root, 'data', 'applications.md');
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seenUrls.add(normalizeUrl(match[0]));
    }
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seenCompanyRoles.add(`${company}::${role}`);
      }
    }
  }

  // Items added by the Quick Scan we just ran would be in pipeline.md
  // already if scan.mjs ran to completion — covered above. The arg is
  // here for forward-compat in case we ever stream Level 1+2 results
  // through this route directly.
  for (const item of addedNow) {
    seenUrls.add(normalizeUrl(item.url));
    if (item.company && item.title) {
      seenCompanyRoles.add(`${String(item.company).toLowerCase()}::${String(item.title).toLowerCase()}`);
    }
  }

  return { seenUrls, seenCompanyRoles };
}

// ── Writers (mirror scan.mjs so Level 3 survivors land in the same place) ──

function appendToPipeline(root, offers) {
  const PIPELINE_PATH = join(root, 'data', 'pipeline.md');
  if (offers.length === 0) return;

  if (!existsSync(PIPELINE_PATH)) {
    writeFileSync(PIPELINE_PATH, '# Pipeline\n\n## Pendientes\n\n## Procesadas\n', 'utf-8');
  }

  let text = readFileSync(PIPELINE_PATH, 'utf-8');
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  const block = offers.map((o) => {
    const datePart = o.postedAt ? ` | posted:${o.postedAt}` : '';
    const locRaw = (o.location || '').toString().replace(/[\n\r|]/g, '').trim();
    const locPart = locRaw ? ` | loc:${locRaw}` : '';
    const matchPart = o.matchTier && o.matchTier !== 'strong' ? ` | match:${o.matchTier}` : '';
    return `- [ ] ${o.url} | ${o.company} | ${o.title}${datePart}${locPart}${matchPart}`;
  }).join('\n');

  if (idx === -1) {
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    text = text.slice(0, insertAt) + `\n${marker}\n\n${block}\n\n` + text.slice(insertAt);
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    text = text.slice(0, insertAt) + '\n' + block + '\n' + text.slice(insertAt);
  }
  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(root, offers) {
  const SCAN_HISTORY_PATH = join(root, 'data', 'scan-history.tsv');
  const date = new Date().toISOString().slice(0, 10);
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }
  const lines = offers.map((o) =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Level 4: JobSpy aggregator scrape ───────────────────────────────
//
// Runs the JobSpy Python sidecar against Indeed / Wellfound / ZipRecruiter
// / Google Jobs / Glassdoor (LinkedIn opt-in). Results flow through the
// same title-filter + aggregator-filter + dedupe + liveness pipeline that
// Level 3 uses, so JobSpy hits land in pipeline.md with `source: jobspy:<board>`.
//
// Silently skips (returns { available: false }) when neither `uv` nor
// `python3` resolves on PATH — JobSpy is opt-in via install.
export async function runLevel4({
  root,
  portals,
  remainingCap,
  seenUrls,
  seenCompanyRoles,
  livenessCheck,
  send,
  detectRunnerImpl = detectJobSpyRunner,
  runJobSpyImpl = runJobSpy,
  getMarketProviderImpl = getMarketProvider,
  listMarketProvidersImpl = listMarketProviders,
}) {
  send('progress', { stage: 'l4:detect' });

  const queries = buildLevel4Queries(portals);
  if (queries.length === 0) {
    send('progress', { stage: 'l4:skipped', reason: 'no positive keywords in title_filter' });
    return { available: true, added: [], skipped: zeroLevel4Skipped(), errors: [], note: 'no positive keywords' };
  }

  const market = readMarketSettings(root, portals);
  if (market.enabled === false) {
    send('progress', { stage: 'l4:skipped', reason: 'market discovery disabled in profile config' });
    return { available: true, added: [], skipped: zeroLevel4Skipped(), errors: [], note: 'market discovery disabled' };
  }
  const providerNames = resolveLevel4ProviderNames(market, { listMarketProvidersImpl });
  if (providerNames.length === 0) {
    send('progress', { stage: 'l4:skipped', reason: 'no enabled market providers' });
    return { available: true, added: [], skipped: zeroLevel4Skipped(), errors: [], note: 'no enabled market providers' };
  }

  send('progress', { stage: 'l4:start', queries: queries.length, providers: providerNames.length });

  const allHits = [];
  const errors = [];
  const providerLimits = resolveMarketProviderLimits(market);

  for (const providerName of providerNames) {
    if (providerName === 'jobspy') {
      await collectJobSpyHits({ market, queries, send, errors, allHits, detectRunnerImpl, runJobSpyImpl, limit: providerLimits.jobspy });
      continue;
    }

    const provider = getMarketProviderImpl(providerName);
    if (!provider) {
      errors.push({ provider: providerName, error: 'provider not found' });
      send('progress', { stage: 'l4:provider:error', provider: providerName, error: 'provider not found' });
      continue;
    }

    send('progress', { stage: 'l4:provider:start', provider: provider.name, totalQueries: queries.length });
    let providerHits = 0;
    for (let index = 0; index < queries.length; index++) {
      const query = queries[index];
      send('progress', { stage: 'l4:query:start', provider: provider.name, queryIndex: index, total: queries.length, query });
      try {
        const result = await provider.fetch({ query, limit: providerLimits[provider.name] || DEFAULT_MARKET_PROVIDER_LIMIT });
        if (result?.error) errors.push({ provider: provider.name, query, error: result.error });
        const jobs = result?.jobs || [];
        providerHits += jobs.length;
        if (jobs.length > 0) allHits.push(...jobs);
        send('progress', { stage: 'l4:query:done', provider: provider.name, queryIndex: index, total: queries.length, query, hits: jobs.length });
      } catch (err) {
        const message = err?.message || String(err);
        errors.push({ provider: provider.name, query, error: message });
        send('progress', { stage: 'l4:provider:error', provider: provider.name, query, error: message });
      }
    }
    send('progress', { stage: 'l4:provider:done', provider: provider.name, hits: providerHits });
  }

  if (allHits.length === 0) {
    send('progress', { stage: 'l4:done', added: 0, hits: 0 });
    return { available: true, added: [], skipped: zeroLevel4Skipped(), errors };
  }

  const { added, skipped } = await filterLevel4Hits({
    portals,
    hits: allHits,
    remainingCap,
    seenUrls,
    seenCompanyRoles,
    livenessCheck,
    send,
    errors,
  });

  send('progress', { stage: 'l4:done', added: added.length, hits: allHits.length });
  return { available: true, added, skipped, errors };
}

function buildLevel4Queries(portals = {}) {
  return (portals.title_filter?.positive || [])
    .slice(0, 6)
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function resolveLevel4ProviderNames(market = {}, { listMarketProvidersImpl = listMarketProviders } = {}) {
  const configured = Array.isArray(market.providers) && market.providers.length
    ? market.providers
    : DEFAULT_LEVEL4_PROVIDERS;
  const available = new Set((listMarketProvidersImpl() || []).map((provider) => provider.name));
  const seen = new Set();
  const names = [];
  for (const raw of configured) {
    const name = normalizeMarketProviderName(raw);
    if (!name || seen.has(name)) continue;
    if (name !== 'jobspy' && !available.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function resolveMarketProviderLimits(market = {}) {
  const out = { jobspy: normalizeProviderLimit(market.results_per_site, 15) };
  for (const [name, value] of Object.entries(market.provider_limits || {})) {
    const normalized = normalizeMarketProviderName(name);
    if (!normalized) continue;
    out[normalized] = normalizeProviderLimit(value, DEFAULT_MARKET_PROVIDER_LIMIT);
  }
  return out;
}

function normalizeProviderLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : fallback;
}

async function collectJobSpyHits({ market, queries, send, errors, allHits, detectRunnerImpl, runJobSpyImpl, limit }) {
  let runner;
  try {
    runner = await detectRunnerImpl();
  } catch (err) {
    const message = err?.message || String(err);
    errors.push({ provider: 'jobspy', error: message });
    send('progress', { stage: 'l4:provider:error', provider: 'jobspy', error: message });
    return;
  }
  if (runner.kind === 'none') {
    send('progress', { stage: 'l4:provider:skip', provider: 'jobspy', reason: 'no python runtime (install uv or python3)' });
    return;
  }

  const configuredSites = Array.isArray(market.sites) && market.sites.length
    ? market.sites
    : JOBSPY_DEFAULT_SITES;
  const withLinkedin = Boolean(market.with_linkedin);
  const sites = configuredSites
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .filter((s) => withLinkedin || s !== 'linkedin');
  if (withLinkedin && !sites.includes('linkedin')) sites.push('linkedin');
  if (sites.length === 0) {
    send('progress', { stage: 'l4:provider:skip', provider: 'jobspy', reason: 'no enabled JobSpy sites' });
    return;
  }

  const resultsPerSite = limit || normalizeProviderLimit(market.results_per_site, 15);
  const hoursOld = Number.isFinite(market.hours_old) ? market.hours_old : 168;
  const isRemote = market.is_remote !== false;
  const totalRuns = queries.length * Math.max(1, sites.length);
  let runIndex = 0;

  send('progress', { stage: 'l4:provider:start', provider: 'jobspy', runner: runner.kind, totalQueries: totalRuns });
  for (const query of queries) {
    for (const site of sites) {
      const currentRun = runIndex++;
      send('progress', { stage: 'l4:query:start', provider: 'jobspy', queryIndex: currentRun, total: totalRuns, query, site });
      try {
        const result = await runJobSpyImpl({
          query,
          isRemote,
          sites: [site],
          withLinkedin: site === 'linkedin',
          resultsPerSite,
          hoursOld,
        });
        if (result?.error) errors.push({ provider: 'jobspy', query, site, error: result.error });
        const jobs = result?.jobs || [];
        if (jobs.length > 0) allHits.push(...jobs);
        send('progress', { stage: 'l4:query:done', provider: 'jobspy', queryIndex: currentRun, total: totalRuns, query, site, hits: jobs.length });
      } catch (err) {
        const message = err?.message || String(err);
        errors.push({ provider: 'jobspy', query, site, error: message });
        send('progress', { stage: 'l4:provider:error', provider: 'jobspy', query, site, error: message });
      }
    }
  }
  send('progress', { stage: 'l4:provider:done', provider: 'jobspy', hits: allHits.filter((job) => String(job.source || '').startsWith('jobspy:')).length });
}

async function filterLevel4Hits({ portals, hits, remainingCap, seenUrls, seenCompanyRoles, livenessCheck, send, errors }) {
  const classifyTitle = buildTitleClassifier(portals.title_filter);
  const skipped = zeroLevel4Skipped();
  const candidates = [];
  const batchUrls = new Set();
  for (const hit of hits) {
    if (isAggregatorPage({ url: hit.url, title: hit.title })) { skipped.aggregator++; continue; }
    const match = classifyTitle(hit.title);
    if (match.decision === 'skip') { skipped.title++; continue; }
    const normalized = normalizeUrl(hit.url);
    if (!normalized || seenUrls.has(normalized) || batchUrls.has(normalized)) { skipped.dup++; continue; }
    batchUrls.add(normalized);
    candidates.push({ ...hit, normalizedUrl: normalized, matchTier: match.tier, matchReason: match.reason });
  }

  send('progress', { stage: 'l4:liveness:start', total: candidates.length });

  const added = [];
  for (let index = 0; index < candidates.length; index++) {
    if (remainingCap && added.length >= remainingCap) break;
    const candidate = candidates[index];
    send('progress', { stage: 'l4:liveness:check', index, total: candidates.length, url: candidate.url, provider: candidate.source });
    let result;
    try {
      result = await livenessCheck(candidate.url);
    } catch (err) {
      result = { result: 'uncertain', reason: 'liveness check threw' };
      errors.push({ url: candidate.url, error: err.message });
    }
    if (result?.result === 'expired') { skipped.expired++; continue; }
    if (!isActiveLiveness(result)) { skipped.unverified++; continue; }
    if (seenUrls.has(candidate.normalizedUrl)) { skipped.dup++; continue; }
    const companyKey = `${String(candidate.company || 'unknown').toLowerCase()}::${String(candidate.title || '').toLowerCase()}`;
    if (seenCompanyRoles.has(companyKey)) { skipped.dup++; continue; }
    seenCompanyRoles.add(companyKey);
    seenUrls.add(candidate.normalizedUrl);
    added.push({
      url: candidate.url,
      title: candidate.title,
      company: candidate.company,
      location: candidate.location || '',
      postedAt: candidate.postedAt || '',
      source: candidate.source,
      matchTier: candidate.matchTier,
      matchReason: candidate.matchReason,
    });
  }

  return { added, skipped };
}

function zeroLevel4Skipped() {
  return { title: 0, dup: 0, expired: 0, aggregator: 0, unverified: 0 };
}

function readMarketSettings(root, portals = {}) {
  const profileMarket = readProfile(root)?.preferences?.market || {};
  const legacyMarket = portals.market || {};
  return {
    ...legacyMarket,
    ...profileMarket,
    provider_limits: {
      ...(legacyMarket.provider_limits || {}),
      ...(profileMarket.provider_limits || {}),
    },
  };
}

// ── Playwright liveness ─────────────────────────────────────────────

async function classifyByPlaywright(page, url) {
  try {
    const linkedInGuestResult = await checkLinkedInGuestPosting(url);
    if (linkedInGuestResult?.result === 'expired') return linkedInGuestResult;

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const status = response?.status() ?? 0;
    await page.waitForTimeout(1500);
    const finalUrl = page.url();
    const titleText = await page.title().catch(() => '');
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
    const applyControls = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('a, button, input[type="submit"], [role="button"]'));
      return els
        .filter((el) => {
          if (el.closest('nav, header, footer')) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          return Array.from(el.getClientRects()).some((r) => r.width > 0 && r.height > 0);
        })
        .map((el) => [el.innerText, el.value, el.getAttribute('aria-label'), el.getAttribute('title')]
          .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    });
    return normalizeJobBoardLiveness(
      url,
      classifyLiveness({ status, finalUrl, bodyText, titleText, applyControls }),
    );
  } catch (err) {
    return normalizeJobBoardLiveness(url, { result: 'uncertain', reason: `navigation error: ${(err.message || '').split('\n')[0]}` });
  }
}
