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
import { classifyLiveness } from '../../lib/liveness-core.mjs';
import { launchChromiumWithRetry } from '../../lib/playwright-launch.mjs';
import { buildTitleClassifier } from '../../lib/title-filter.mjs';
import { loadEnvFile } from '../../lib/load-env.mjs';
import { DEFAULT_MIN_RELEVANCE, hasRelevanceSignals, resolveMinRelevance, scorePostingTitle, rationaleSummary, relevanceInputsFrom } from '../../lib/relevance.mjs';
import { readProfile } from '../lib/writers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, '..', '..');

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

    // SSE headers. Disable nagling so progress events flush immediately.
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    const send = (event, payload) => {
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
      send('progress', { stage: 'quick:done', ...quickResult });

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
        send('complete', { summary: { quick: quickResult, level3: null, level4: null, totalNew: quickResult.added } });
        reply.raw.end();
        return;
      }

      if (enabledQueries.length === 0) {
        send('progress', { stage: 'l3:skipped', reason: 'no enabled search_queries' });
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

      send('complete', {
        summary: {
          quick: quickResult,
          level3: {
            added: l3Added,
            skipped: level3Result.skipped,
            errors: level3Result.errors,
            perQuery: level3Result.perQuery,
          },
          level4: level4Result,
          totalNew: quickResult.added + l3Added + l4Added,
        },
      });
      reply.raw.end();
    } catch (err) {
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
    const args = [join(PACKAGE_ROOT, 'scan.mjs')];
    if (limit > 0) args.push('--limit', String(limit));

    const env = { ...process.env, CATABULL_WORKSPACE_ROOT: root };
    const child = spawn(process.execPath, args, { cwd: root, env });

    let buf = '';
    let added = 0;
    let totalFound = 0;
    let totalFiltered = 0;
    let totalDupes = 0;

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      // Stream summary lines as progress so the dashboard sees activity
      // while a slow scan runs.
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
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
      }
    });
    child.stderr.on('data', () => {/* errors surface in summary */});
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
async function runLevel4({ root, portals, remainingCap, seenUrls, seenCompanyRoles, livenessCheck, send }) {
  send('progress', { stage: 'l4:detect' });
  const runner = await detectJobSpyRunner();
  if (runner.kind === 'none') {
    send('progress', { stage: 'l4:skipped', reason: 'no python runtime (install uv or python3)' });
    return { available: false, added: [], skipped: { title: 0, dup: 0, expired: 0, aggregator: 0 }, errors: [] };
  }

  // Derive the JobSpy query from the user's title filter. We OR the
  // positive keywords so JobSpy returns hits matching any. Capped at 6
  // keywords because most aggregators don't tokenize huge boolean strings
  // sensibly.
  const positives = (portals.title_filter?.positive || []).slice(0, 6);
  if (positives.length === 0) {
    send('progress', { stage: 'l4:skipped', reason: 'no positive keywords in title_filter' });
    return { available: true, added: [], skipped: { title: 0, dup: 0, expired: 0, aggregator: 0 }, errors: [], note: 'no positive keywords' };
  }

  // jobspy expects a plain search_term string; treat each positive keyword
  // as a separate run and aggregate. This avoids weird quoting issues some
  // aggregators have with OR.
  const market = portals.market || {};
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
    send('progress', { stage: 'l4:skipped', reason: 'no enabled JobSpy sites' });
    return { available: true, added: [], skipped: { title: 0, dup: 0, expired: 0, aggregator: 0 }, errors: [], note: 'no enabled JobSpy sites' };
  }
  const resultsPerSite = Number.isFinite(market.results_per_site) ? market.results_per_site : 15;
  const hoursOld = Number.isFinite(market.hours_old) ? market.hours_old : 168;
  const isRemote = market.is_remote !== false; // default true unless explicitly off

  send('progress', { stage: 'l4:start', queries: positives.length, sites: sites.length, runner: runner.kind });

  const allHits = [];
  const errors = [];
  const totalRuns = positives.length * Math.max(1, sites.length);
  let runIndex = 0;
  for (let i = 0; i < positives.length; i++) {
    const kw = positives[i];
    for (const site of sites) {
      const currentRun = runIndex++;
      send('progress', { stage: 'l4:query:start', queryIndex: currentRun, total: totalRuns, query: kw, site });
      const r = await runJobSpy({
        query: kw,
        isRemote,
        sites: [site],
        withLinkedin: site === 'linkedin',
        resultsPerSite,
        hoursOld,
      });
      if (r.error) errors.push({ query: kw, site, error: r.error });
      const got = r.jobs?.length || 0;
      send('progress', { stage: 'l4:query:done', queryIndex: currentRun, total: totalRuns, query: kw, site, hits: got });
      if (got > 0) allHits.push(...r.jobs);
    }
  }

  if (allHits.length === 0) {
    send('progress', { stage: 'l4:done', added: 0, hits: 0 });
    return { available: true, added: [], skipped: { title: 0, dup: 0, expired: 0, aggregator: 0 }, errors };
  }

  // Filter + dedupe pass — mirrors Level 3's logic so the two stages
  // produce identically-shaped pipeline entries.
  const classifyTitle = buildTitleClassifier(portals.title_filter);
  const skipped = { title: 0, dup: 0, expired: 0, aggregator: 0 };
  const candidates = [];
  for (const h of allHits) {
    if (isAggregatorPage({ url: h.url, title: h.title })) { skipped.aggregator++; continue; }
    const match = classifyTitle(h.title);
    if (match.decision === 'skip') { skipped.title++; continue; }
    const normalized = normalizeUrl(h.url);
    if (!normalized || seenUrls.has(normalized)) { skipped.dup++; continue; }
    candidates.push({ ...h, normalizedUrl: normalized, matchTier: match.tier, matchReason: match.reason });
  }

  send('progress', { stage: 'l4:liveness:start', total: candidates.length });

  const added = [];
  for (let i = 0; i < candidates.length; i++) {
    if (remainingCap && added.length >= remainingCap) break;
    const c = candidates[i];
    send('progress', { stage: 'l4:liveness:check', index: i, total: candidates.length, url: c.url });
    let result;
    try { result = await livenessCheck(c.url); }
    catch (err) { result = { result: 'uncertain', reason: 'liveness check threw' }; errors.push({ url: c.url, error: err.message }); }
    if (result?.result === 'expired') { skipped.expired++; continue; }
    const companyKey = `${String(c.company || 'unknown').toLowerCase()}::${String(c.title || '').toLowerCase()}`;
    if (seenCompanyRoles.has(companyKey)) { skipped.dup++; continue; }
    seenCompanyRoles.add(companyKey);
    seenUrls.add(c.normalizedUrl);
    added.push({
      url: c.url,
      title: c.title,
      company: c.company,
      location: c.location || '',
      postedAt: c.postedAt || '',
      source: c.source,
      matchTier: c.matchTier,
      matchReason: c.matchReason,
    });
  }

  send('progress', { stage: 'l4:done', added: added.length, hits: allHits.length });
  return { available: true, added, skipped, errors };
}

// ── Playwright liveness ─────────────────────────────────────────────

async function classifyByPlaywright(page, url) {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const status = response?.status() ?? 0;
    await page.waitForTimeout(1500);
    const finalUrl = page.url();
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
    return classifyLiveness({ status, finalUrl, bodyText, applyControls });
  } catch (err) {
    return { result: 'uncertain', reason: `navigation error: ${(err.message || '').split('\n')[0]}` };
  }
}
