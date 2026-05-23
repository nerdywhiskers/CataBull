#!/usr/bin/env node

/**
 * healthcheck.mjs — Tracked-company portal healthcheck + auto-recovery
 *
 * Subcommands:
 *   baseline    Re-run scan-health.mjs --all and refresh data/scan-health.json
 *   recover     Read scan-health.json, try to fix broken companies, write proposals
 *   apply       Apply recovery proposals to portals.yml (use --dry-run to preview)
 *   report      Write a markdown summary at data/healthcheck-{date}.md
 *   all         Run baseline → recover → report (does NOT apply automatically)
 *
 * Flags:
 *   --dry-run             For `apply` — print changes without writing portals.yml
 *   --include healthy     For `recover` — also re-check healthy entries (slow)
 *   --providers gh,ashby  Limit slug-variant probing to specific providers
 *   --concurrency N       Override default HTTP concurrency (10)
 *
 * Status taxonomy (from data/scan-health.json):
 *   not_found     Wrong ATS slug at a known provider          → Phase 1: slug variants
 *   unknown_ats   Page loads but no recognizable job links    → Phase 2: smart Playwright probe
 *   bot_blocked   Hard block on initial fetch                 → Phase 2: UA + retry
 *   no_provider   No careers_url configured                   → Phase 3: manual / JobSpy
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { probeWithNetworkCapture, disposeBrowser } from './healthcheck-phase2.mjs';
import { fetchJobspyForCompany } from '../scan/providers/jobspy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORTALS_PATH = join(ROOT, 'portals.yml');
const HEALTH_PATH = join(ROOT, 'data', 'scan-health.json');
const PROPOSALS_PATH = join(ROOT, 'data', 'healthcheck-proposals.json');
const ACTIVE_PROFILE_PATH = join(ROOT, '.profiles', 'active.json');

// Stamp recovery proposals with the active profile ID. Profile switches
// swap portals.yml without touching scan-health.json, so a proposal
// generated under one profile must NOT be applied to another's portals
// or it'll silently no-op on companies the new profile doesn't track.
function getActiveProfile() {
  if (!existsSync(ACTIVE_PROFILE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(ACTIVE_PROFILE_PATH, 'utf-8')).id || null;
  } catch {
    return null;
  }
}
const DEFAULT_CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

mkdirSync(join(ROOT, 'data'), { recursive: true });

// ── Slug-variant probing (Phase 1) ──────────────────────────────────

function normalizeCompanyName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|gmbh|ag|plc|co)\b\.?/gi, '')
    .replace(/[^a-z0-9]/g, '');
}

function slugVariants(company) {
  const base = normalizeCompanyName(company.name);
  if (!base) return [];

  const variants = new Set([base]);

  // Try the current slug if any (it might be right but at the wrong provider)
  const currentSlug = extractCurrentSlug(company);
  if (currentSlug) variants.add(currentSlug.toLowerCase());

  // Common suffix patterns
  variants.add(`${base}careers`);
  variants.add(`${base}-careers`);

  // NOTE: Deliberately do NOT try first-word-only as a variant for multi-word
  // names. "Blue Origin" → "blue" matched a totally unrelated Eastern-European
  // lever board with 3 jobs. A slug must come from the full normalized name
  // (or known suffix patterns) to count as a confident match.

  return Array.from(variants).filter(Boolean);
}

function extractCurrentSlug(company) {
  const url = company.careers_url || company.api || '';
  const patterns = [
    /boards\/([^/?#]+)\/jobs/i,
    /(?:boards|job-boards(?:\.eu)?)\.greenhouse\.io\/([^/?#]+)/i,
    /jobs\.ashbyhq\.com\/([^/?#]+)/i,
    /jobs\.lever\.co\/([^/?#]+)/i,
    /apply\.workable\.com\/([^/?#]+)/i,
  ];
  for (const re of patterns) {
    const m = String(url).match(re);
    if (m) return m[1];
  }
  return null;
}

async function probeUrl(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'catabull-healthcheck/1.0' },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json();
    return { ok: true, status: res.status, json };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

function countJobs(provider, json) {
  if (!json) return 0;
  if (provider === 'greenhouse') return Array.isArray(json.jobs) ? json.jobs.length : 0;
  if (provider === 'ashby') return Array.isArray(json.jobs) ? json.jobs.length : 0;
  if (provider === 'lever') return Array.isArray(json) ? json.length : 0;
  return 0;
}

const PROVIDER_PROBES = {
  greenhouse: (slug) => ({
    api: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    careers_url: `https://job-boards.greenhouse.io/${slug}`,
  }),
  ashby: (slug) => ({
    api: null,
    careers_url: `https://jobs.ashbyhq.com/${slug}`,
    probeApi: `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
  }),
  lever: (slug) => ({
    api: null,
    careers_url: `https://jobs.lever.co/${slug}`,
    probeApi: `https://api.lever.co/v0/postings/${slug}`,
  }),
};

async function tryRecoverSlug(company, providers = ['greenhouse', 'ashby', 'lever']) {
  const variants = slugVariants(company);
  if (variants.length === 0) return null;

  for (const provider of providers) {
    const cfg = PROVIDER_PROBES[provider];
    if (!cfg) continue;
    for (const slug of variants) {
      const probe = cfg(slug);
      const url = probe.probeApi || probe.api;
      const result = await probeUrl(url);
      const jobs = countJobs(provider, result.json);
      if (result.ok && jobs > 0) {
        return {
          provider,
          slug,
          jobs,
          patch: {
            careers_url: probe.careers_url,
            ...(probe.api ? { api: probe.api } : {}),
          },
        };
      }
    }
  }
  return null;
}

// ── Concurrency helper ──────────────────────────────────────────────

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Subcommands ─────────────────────────────────────────────────────

async function cmdBaseline() {
  console.log('Running scan-health.mjs --all (this can take 15-30 min for 508 companies)...\n');
  return new Promise((res, rej) => {
    const child = spawn('node', ['scripts/scan-health.mjs', '--all', '--quiet'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`scan-health exited ${code}`))));
  });
}

async function cmdRecover(opts) {
  if (!existsSync(HEALTH_PATH)) {
    console.error(`No baseline at ${HEALTH_PATH}. Run: node scripts/healthcheck.mjs baseline`);
    process.exit(1);
  }
  const health = JSON.parse(readFileSync(HEALTH_PATH, 'utf-8'));
  const broken = health.companies.filter((c) => !['healthy', 'empty'].includes(c.status));
  console.log(`${broken.length} broken companies in baseline. Attempting recovery...\n`);

  const targets = broken.filter((c) => ['not_found', 'unknown_ats', 'bot_blocked'].includes(c.status));
  const providers = opts.providers || ['greenhouse', 'ashby', 'lever'];

  const proposals = [];
  const phaseSelection = opts.phase || 'both';

  // When skipping Phase 1 but a prior run is on disk, preserve those
  // proposals so a `--phase 1` followup doesn't blow away Phase 2 results
  // (and vice versa). Symmetric with the Phase 2 branch below.
  if (phaseSelection === '1' && existsSync(PROPOSALS_PATH)) {
    const prior = JSON.parse(readFileSync(PROPOSALS_PATH, 'utf-8')).proposals || [];
    for (const p of prior) if (p.recovery?.phase !== 1) proposals.push(p);
  }

  // ── Phase 1: slug-variant probing ────────────────────────────────
  if (phaseSelection === '1' || phaseSelection === 'both') {
    console.log(`Phase 1 — slug-variant probing (${targets.length} candidates):`);
    let done = 0;
    await mapWithConcurrency(targets, opts.concurrency, async (c) => {
      const found = await tryRecoverSlug(c, providers);
      done += 1;
      const tag = found ? `✓ ${found.provider}/${found.slug} (${found.jobs} jobs)` : '·';
      console.log(`[${String(done).padStart(3)}/${targets.length}] ${c.name.padEnd(30)} ${tag}`);
      if (found) {
        proposals.push({
          name: c.name,
          previousStatus: c.status,
          previousUrl: c.probedUrl,
          recovery: { ...found, phase: 1 },
        });
      }
    });
    console.log(`Phase 1 recovered ${proposals.length} of ${targets.length}.\n`);
  }

  // ── Phase 2: Playwright network capture for stragglers ──────────
  if (phaseSelection === '2' || phaseSelection === 'both') {
    // When `--phase 2` runs alone (Phase 1 was skipped), still respect any
    // proposals already on disk from a prior run so we don't waste time
    // re-probing companies we already recovered.
    if (phaseSelection === '2' && existsSync(PROPOSALS_PATH)) {
      const prior = JSON.parse(readFileSync(PROPOSALS_PATH, 'utf-8')).proposals || [];
      for (const p of prior) if (!proposals.find((x) => x.name === p.name)) proposals.push(p);
    }
    const recoveredNames = new Set(proposals.map((p) => p.name));
    const phase2Targets = targets.filter(
      (c) => !recoveredNames.has(c.name) && c.probedUrl && /^https?:/.test(c.probedUrl || ''),
    );
    console.log(`Phase 2 — Playwright network capture (${phase2Targets.length} candidates, this is slower):`);
    const phase2Concurrency = Math.min(opts.concurrency, 4); // Playwright is heavy
    let done = 0;
    let recovered = 0;
    await mapWithConcurrency(phase2Targets, phase2Concurrency, async (c) => {
      // Build a probe-target shape — the careers_url from portals may
      // differ from what scan-health.json captured, so prefer the latter.
      const probeCompany = { name: c.name, careers_url: c.probedUrl };
      let found = null;
      try {
        found = await probeWithNetworkCapture(probeCompany);
      } catch (err) {
        // Per-company failure is non-fatal; log and continue.
      }
      done += 1;
      const tag = found ? `✓ ${found.provider}/${found.slug} (${found.jobs} jobs)` : '·';
      console.log(`[${String(done).padStart(3)}/${phase2Targets.length}] ${c.name.padEnd(30)} ${tag}`);
      if (found) {
        recovered += 1;
        proposals.push({
          name: c.name,
          previousStatus: c.status,
          previousUrl: c.probedUrl,
          recovery: { ...found, phase: 2 },
        });
      }
    });
    console.log(`Phase 2 recovered ${recovered} of ${phase2Targets.length}.\n`);
    await disposeBrowser().catch(() => {});
  }

  // Dedupe — when both phases recover the same company (which is common,
  // since Phase 2's network-capture often confirms what Phase 1 found via
  // slug variants), keep the Phase 1 entry. Phase 1 is HTTP-only so it
  // trusts the public API as the verification authority, same as Phase 2.
  const deduped = [];
  const seenNames = new Set();
  // Sort Phase 1 first so it wins ties.
  proposals.sort((a, b) => (a.recovery.phase || 0) - (b.recovery.phase || 0));
  for (const p of proposals) {
    if (seenNames.has(p.name)) continue;
    seenNames.add(p.name);
    deduped.push(p);
  }

  const stillBroken = targets.length - deduped.length;
  console.log(`Total recovered: ${deduped.length} of ${targets.length}. Still broken: ${stillBroken}.`);

  writeFileSync(
    PROPOSALS_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), profile: getActiveProfile(), proposals: deduped }, null, 2),
  );
  console.log(`Proposals written to ${PROPOSALS_PATH}`);
  console.log('\nNext: node scripts/healthcheck.mjs apply --dry-run');
}

async function cmdApply(opts) {
  if (!existsSync(PROPOSALS_PATH)) {
    console.error(`No proposals at ${PROPOSALS_PATH}. Run: node scripts/healthcheck.mjs recover`);
    process.exit(1);
  }
  const file = JSON.parse(readFileSync(PROPOSALS_PATH, 'utf-8'));
  const { proposals } = file;

  // Profile-context guard. portals.yml is user-data and swaps on profile
  // change; scan-health.json + proposals do not. Applying proposals from
  // profile A onto profile B's portals.yml is a silent miss-fest — most
  // companies simply won't be in the active profile's tracked list. Make
  // this explicit instead of letting the user wonder why the diff is empty.
  const activeProfile = getActiveProfile();
  if (file.profile && activeProfile && file.profile !== activeProfile) {
    console.error(`Profile mismatch: proposals were generated for "${file.profile}" but the active profile is "${activeProfile}".`);
    console.error('Re-run baseline + recover under the active profile, or use --force to apply anyway (entries not in the active profile will be skipped).');
    if (!opts.force) process.exit(1);
  }
  if (proposals.length === 0) {
    console.log('No proposals to apply.');
    return;
  }

  const portalsRaw = readFileSync(PORTALS_PATH, 'utf-8');
  const portals = yaml.load(portalsRaw);
  const byName = new Map(portals.tracked_companies.map((c) => [c.name, c]));

  let applied = 0;
  for (const p of proposals) {
    const target = byName.get(p.name);
    if (!target) {
      console.log(`  ! ${p.name} — not found in portals.yml`);
      continue;
    }
    console.log(`  ${opts.dryRun ? '[dry]' : '✓'} ${p.name}`);
    if (p.recovery.patch.careers_url) {
      console.log(`        careers_url: ${target.careers_url || '(none)'}`);
      console.log(`                  → ${p.recovery.patch.careers_url}`);
    }
    if (p.recovery.patch.api) {
      console.log(`        api:         ${target.api || '(none)'}`);
      console.log(`                  → ${p.recovery.patch.api}`);
    }
    if (p.recovery.patch.scan_method) {
      console.log(`        scan_method: ${target.scan_method || '(auto)'} → ${p.recovery.patch.scan_method}`);
    }
    if (!opts.dryRun) {
      Object.assign(target, p.recovery.patch);
      // Drop incompatible legacy fields when switching provider
      if (p.recovery.provider !== 'greenhouse' && target.api && !p.recovery.patch.api) {
        delete target.api;
      }
      applied += 1;
    }
  }

  if (!opts.dryRun && applied > 0) {
    const out = yaml.dump(portals, { lineWidth: 200, noRefs: true });
    writeFileSync(PORTALS_PATH, out);
    console.log(`\nApplied ${applied} changes to portals.yml`);
  } else if (opts.dryRun) {
    console.log(`\n(dry run — ${proposals.length} would be applied)`);
  }
}

async function cmdJobspy(opts) {
  // Phase 3: probe still-broken companies via JobSpy (Indeed by default,
  // LinkedIn opt-in via --linkedin). For each company where JobSpy returns
  // ≥1 hit whose `company` field matches the name, mark the company as
  // `scan_method: jobspy` in proposals. JobSpy rate-limits aggressively
  // so we run sequentially with a small inter-query delay rather than
  // the parallelism Phases 1/2 use.
  if (!existsSync(HEALTH_PATH)) {
    console.error('No baseline. Run: node scripts/healthcheck.mjs baseline');
    process.exit(1);
  }
  const health = JSON.parse(readFileSync(HEALTH_PATH, 'utf-8'));
  const proposalsFile = existsSync(PROPOSALS_PATH)
    ? JSON.parse(readFileSync(PROPOSALS_PATH, 'utf-8'))
    : { proposals: [] };
  const recoveredNames = new Set(proposalsFile.proposals.map((p) => p.name));

  const broken = health.companies
    .filter((c) => !['healthy', 'empty'].includes(c.status))
    .filter((c) => !recoveredNames.has(c.name));

  // Allow narrowing to one company for fast iteration.
  let targets = broken;
  if (opts._[1]) {
    const filter = opts._[1].toLowerCase();
    targets = broken.filter((c) => c.name.toLowerCase().includes(filter));
    if (targets.length === 0) {
      console.error(`No still-broken company matches "${opts._[1]}".`);
      process.exit(1);
    }
  }

  const sites = opts.linkedin ? ['indeed', 'linkedin'] : ['indeed'];
  console.log(`Phase 3 — JobSpy probe (${targets.length} candidates, sites=${sites.join(',')}):`);
  console.log('Note: JobSpy rate-limits aggressively. Sites that block return 0 hits silently.\n');

  const proposals = [...proposalsFile.proposals];
  let done = 0;
  let recovered = 0;

  for (const c of targets) {
    done += 1;
    let hits = [];
    try {
      const r = await fetchJobspyForCompany({ name: c.name }, { sites });
      hits = r.jobs;
    } catch (err) {
      console.log(`[${String(done).padStart(3)}/${targets.length}] ${c.name.padEnd(30)} ! ${err.message}`);
      continue;
    }
    if (hits.length === 0) {
      console.log(`[${String(done).padStart(3)}/${targets.length}] ${c.name.padEnd(30)} ·`);
      continue;
    }
    recovered += 1;
    console.log(`[${String(done).padStart(3)}/${targets.length}] ${c.name.padEnd(30)} ✓ ${hits.length} JobSpy hits`);
    proposals.push({
      name: c.name,
      previousStatus: c.status,
      previousUrl: c.probedUrl,
      recovery: {
        provider: 'jobspy',
        slug: c.name,
        jobs: hits.length,
        patch: { scan_method: 'jobspy' },
        phase: 3,
        sampleJobs: hits.slice(0, 3).map((h) => ({ title: h.title, url: h.url })),
      },
    });
  }

  console.log(`\nPhase 3 recovered ${recovered} of ${targets.length} (marked scan_method: jobspy).`);
  writeFileSync(
    PROPOSALS_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), profile: getActiveProfile(), proposals }, null, 2),
  );
  console.log(`Proposals updated at ${PROPOSALS_PATH}`);
  if (recovered > 0) console.log('Next: node scripts/healthcheck.mjs apply --dry-run');
}

async function cmdReport() {
  if (!existsSync(HEALTH_PATH)) {
    console.error('No baseline to report on.');
    process.exit(1);
  }
  const health = JSON.parse(readFileSync(HEALTH_PATH, 'utf-8'));
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = join(ROOT, 'data', `healthcheck-${date}.md`);
  const proposals = existsSync(PROPOSALS_PATH)
    ? JSON.parse(readFileSync(PROPOSALS_PATH, 'utf-8')).proposals
    : [];

  const lines = [
    `# Portal Healthcheck — ${date}`,
    '',
    `Baseline: ${health.startedAt} → ${health.finishedAt}`,
    `Total checked: ${health.companies.length}`,
    '',
    '## Summary',
    '',
  ];
  for (const [status, n] of Object.entries(health.summary)) {
    if (n > 0) lines.push(`- **${status}**: ${n}`);
  }
  lines.push('', `## Recovery proposals (${proposals.length})`, '');
  for (const p of proposals) {
    lines.push(`- **${p.name}** — ${p.previousStatus} → ${p.recovery.provider}/${p.recovery.slug} (${p.recovery.jobs} jobs)`);
  }
  lines.push('', '## Still broken — needs Phase 2 (Playwright) or Phase 3 (JobSpy/manual)', '');
  const recoveredNames = new Set(proposals.map((p) => p.name));
  const unresolved = health.companies.filter(
    (c) => !['healthy', 'empty'].includes(c.status) && !recoveredNames.has(c.name),
  );
  for (const c of unresolved) {
    lines.push(`- ${c.name} (${c.status}) — ${c.error || c.probedUrl}`);
  }

  writeFileSync(reportPath, lines.join('\n'));
  console.log(`Report written to ${reportPath}`);
}

// ── CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [], dryRun: false, force: false, providers: null, concurrency: DEFAULT_CONCURRENCY, includeHealthy: false, phase: 'both' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--providers') out.providers = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--phase') out.phase = String(argv[++i]); // '1' | '2' | 'both'
    else if (a === '--linkedin') out.linkedin = true;
    else if (a === '--include' && argv[i + 1] === 'healthy') { out.includeHealthy = true; i++; }
    else if (!a.startsWith('--')) out._.push(a);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0] || 'help';
  switch (cmd) {
    case 'baseline': return cmdBaseline();
    case 'recover': return cmdRecover(opts);
    case 'jobspy': return cmdJobspy(opts);
    case 'apply': return cmdApply(opts);
    case 'report': return cmdReport();
    case 'all':
      await cmdBaseline();
      await cmdRecover(opts);
      await cmdReport();
      console.log('\nReview data/healthcheck-proposals.json, then: node scripts/healthcheck.mjs apply --dry-run');
      return;
    default:
      console.log(`Usage: node scripts/healthcheck.mjs <baseline|recover|jobspy|apply|report|all> [flags]`);
      console.log(`See file header for full docs.`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exitCode = 1;
});
