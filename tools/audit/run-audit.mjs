#!/usr/bin/env node

/**
 * run-audit.mjs — one-shot portals + market audit driven by JobSpy.
 *
 * Reads `portals.yml` and `config/profile.yml`, builds a small query
 * plan from the user's target_roles, hands it to `jobspy_audit.py`,
 * then post-processes the results into a triage report at
 * `docs/audit/portals-audit-YYYY-MM-DD.md`.
 *
 * The report has four sections:
 *   A1. Landing-page portals — URL doesn't match a known ATS pattern
 *       AND JobSpy found fresh hits for that company. Suggested fix
 *       comes from the JobSpy hits' job_url_direct (most common host).
 *   A2. ATS-endpoint portals with no recent activity — pattern looks
 *       right but JobSpy didn't surface hits either. Low priority
 *       review.
 *   B.  Dormant portals — landing-page-shaped AND zero JobSpy hits.
 *       Likely company stopped hiring, rebranded, or our query missed
 *       a niche role. Candidates for `enabled: false`.
 *   C.  New-company candidates — companies that surfaced in JobSpy
 *       results but aren't in portals.yml. Ranked by hit count × title
 *       match × recency. Top 50.
 *   D.  Summary stats.
 *
 * The report is committed for review. portals.yml is never auto-edited.
 *
 * Usage:
 *   node tools/audit/run-audit.mjs                       # full audit (~8 min)
 *   node tools/audit/run-audit.mjs --cached              # reuse last-results.json
 *   node tools/audit/run-audit.mjs --dry-run             # classify only, skip JobSpy
 *   node tools/audit/run-audit.mjs --no-linkedin         # Indeed-only (~1 min)
 *   node tools/audit/run-audit.mjs --terms-file path.json # override the bank
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const args = new Set(argv);
const USE_CACHE = args.has('--cached');
const DRY_RUN = args.has('--dry-run');
const NO_LINKEDIN = args.has('--no-linkedin');
const TERMS_FILE = (() => {
  const i = argv.indexOf('--terms-file');
  return i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : null;
})();

const TODAY = new Date().toISOString().slice(0, 10);
const REPORT_PATH = join(REPO, 'docs', 'audit', `portals-audit-${TODAY}.md`);
const CACHE_PATH = join(__dirname, 'last-results.json');
const PY = process.platform === 'win32'
  ? join(__dirname, '.venv', 'Scripts', 'python.exe')
  : join(__dirname, '.venv', 'bin', 'python');

// ── ATS pattern matchers ───────────────────────────────────────────────
// A URL is "ats-endpoint" if its host or path matches one of these. Anything
// else is "landing-page". Conservative: false-positive (treating a landing
// page as ATS) just means the audit underreports a fix opportunity, which
// is harmless. False-negative (treating a real ATS URL as landing) just
// surfaces it for manual review.
const ATS_PATTERNS = [
  { kind: 'greenhouse',     re: /(?:job-?boards|boards)(?:\.eu)?\.greenhouse\.io/i },
  { kind: 'greenhouse',     re: /greenhouse\.io\/embed\/job_board/i },
  { kind: 'ashby',          re: /(?:jobs|app)\.ashbyhq\.com/i },
  { kind: 'lever',          re: /jobs\.lever\.co|app\.lever\.co/i },
  { kind: 'workday',        re: /\.(?:myworkdayjobs|wd[1-9]?)\.com/i },
  { kind: 'workday',        re: /myworkdayjobs\.com/i },
  { kind: 'teamtailor',     re: /\.teamtailor\.com/i },
  { kind: 'smartrecruiters',re: /(?:jobs|smartrecruiters)\.smartrecruiters\.com|careers\.smartrecruiters/i },
  { kind: 'bamboohr',       re: /\.bamboohr\.com\/(?:careers|jobs)/i },
  { kind: 'jobvite',        re: /jobs\.jobvite\.com|jobvite\.com\/jobs/i },
  { kind: 'paylocity',      re: /recruiting\.paylocity\.com/i },
  { kind: 'adp',            re: /recruiting\.adp\.com/i },
  { kind: 'recruitee',      re: /\.recruitee\.com/i },
  { kind: 'breezy',         re: /\.breezy\.hr/i },
  { kind: 'workable',       re: /apply\.workable\.com|jobs\.workable\.com/i },
  { kind: 'rippling',       re: /ats\.rippling\.com/i },
  { kind: 'oraclecloud',    re: /\.oraclecloud\.com/i },
  { kind: 'successfactors', re: /careers\.successfactors\.com/i },
  { kind: 'icims',          re: /\.icims\.com/i },
  { kind: 'pinpoint',       re: /\.pinpointhq\.com/i },
];

function classifyUrl(url) {
  if (!url) return { kind: 'missing', isAts: false };
  for (const { kind, re } of ATS_PATTERNS) {
    if (re.test(url)) return { kind, isAts: true };
  }
  return { kind: 'landing-page', isAts: false };
}

// Normalize company names for matching. JobSpy company strings vary —
// "Anthropic", "Anthropic, Inc.", "Anthropic PBC" should all match the
// portals.yml entry "Anthropic".
function normCompany(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/[,.]/g, ' ')
    .replace(/\b(inc|llc|ltd|gmbh|pbc|sa|s\.a\.|co|corp|corporation|group|holdings|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readYaml(path) {
  return yaml.load(readFileSync(path, 'utf8'));
}

// ── Default query bank ───────────────────────────────────────────────
// Curated to cover the major job families CataBull supports, not any
// one user's profile. The audit is verifying a shared portals.yml; the
// queries should reflect the *project's* target audience, not the
// running user's archetype. Override via --terms-file <path.json>
// (file is a JSON array of strings) for ad-hoc runs.
const DEFAULT_TERMS = [
  // Engineering
  'software engineer',
  'staff engineer',
  'platform engineer',
  'machine learning engineer',
  'backend engineer',
  'frontend engineer',
  'engineering manager',
  'site reliability engineer',
  // Design / creative
  'product designer',
  'ux designer',
  'art director',
  'senior designer',
  'creative director',
  // Data / ML / research
  'data scientist',
  'data engineer',
  'research engineer',
  // Product / business
  'product manager',
  'developer advocate',
];

function loadTerms() {
  if (!TERMS_FILE) return DEFAULT_TERMS;
  const raw = readFileSync(TERMS_FILE, 'utf8');
  const parsed = TERMS_FILE.endsWith('.yml') || TERMS_FILE.endsWith('.yaml')
    ? yaml.load(raw)
    : JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`--terms-file ${TERMS_FILE} must contain a JSON/YAML array of strings`);
  return parsed.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
}

// ── Build the query plan ──────────────────────────────────────────────
// Indeed runs first (cheap, fast, gives us job_url_direct for the A1
// fix suggestions). LinkedIn runs second (slower, rate-limited; only
// used for discovery breadth). Per-site delays: 2s after each Indeed,
// 5s after each LinkedIn — LinkedIn's bot detection trips on tight
// loops, but Indeed handles 1-2s cadence without complaint.
function buildQueryPlan() {
  const terms = loadTerms();
  const sites = NO_LINKEDIN ? ['indeed'] : ['indeed', 'linkedin'];
  const queries = [];
  for (const site of sites) {
    for (const term of terms) {
      queries.push({
        search_term: term,
        site,
        results_wanted: 40,
        hours_old: 720,             // 30 days
        country_indeed: 'USA',
        location: '',
      });
    }
  }
  return {
    queries,
    per_site_delay_sec: { indeed: 2, linkedin: 5 },
  };
}

// ── Spawn the Python script and stream its output ─────────────────────
function runJobSpy(plan) {
  return new Promise((resolve, reject) => {
    if (!existsSync(PY)) {
      return reject(new Error(`venv python not found at ${PY}. Run "python -m venv tools/audit/.venv" and "pip install python-jobspy" first.`));
    }
    const child = spawn(PY, [join(__dirname, 'jobspy_audit.py')], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`jobspy_audit.py exited with code ${code}`));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error(`could not parse jobspy_audit.py stdout: ${e.message}`)); }
    });
    child.stdin.write(JSON.stringify(plan));
    child.stdin.end();
  });
}

// ── Aggregate hits per company across all queries ─────────────────────
function aggregateHits(jobspyOut) {
  const byCompany = new Map(); // normCompany → { name, hits[], sites:Set, titles:Set, directUrls:Map<host,count> }
  for (const q of (jobspyOut.queries || [])) {
    if (!q.ok) continue;
    const searchTerm = q.request?.search_term;
    for (const hit of (q.hits || [])) {
      if (!hit.company) continue;
      const key = normCompany(hit.company);
      if (!key) continue;
      let entry = byCompany.get(key);
      if (!entry) {
        entry = {
          name: hit.company,
          hits: [],
          sites: new Set(),
          titles: new Set(),
          directHosts: new Map(),     // host → count
          industries: new Set(),
          locations: new Set(),
          matchedTerms: new Set(),
        };
        byCompany.set(key, entry);
      }
      entry.hits.push(hit);
      entry.sites.add(hit.site);
      if (hit.title) entry.titles.add(hit.title);
      if (hit.company_industry) entry.industries.add(hit.company_industry);
      if (hit.location) entry.locations.add(hit.location);
      if (searchTerm) entry.matchedTerms.add(searchTerm);
      if (hit.job_url_direct) {
        try {
          const host = new URL(hit.job_url_direct).hostname.toLowerCase();
          entry.directHosts.set(host, (entry.directHosts.get(host) || 0) + 1);
        } catch { /* skip malformed */ }
      }
    }
  }
  return byCompany;
}

// Suggest a replacement ATS URL for a company whose portal URL is a
// landing page. Strategy: look at the most common job_url_direct host
// in the JobSpy hits for that company — if it matches a known ATS
// pattern, return a sample full URL plus the host.
function suggestAtsUrl(entry) {
  let bestHost = null;
  let bestCount = 0;
  for (const [host, count] of entry.directHosts.entries()) {
    const cls = classifyUrl(`https://${host}/`);
    if (cls.isAts && count > bestCount) {
      bestHost = host;
      bestCount = count;
    }
  }
  if (!bestHost) return null;
  const sample = entry.hits.find(h => {
    try { return new URL(h.job_url_direct || '').hostname.toLowerCase() === bestHost; }
    catch { return false; }
  });
  return {
    host: bestHost,
    classification: classifyUrl(`https://${bestHost}/`).kind,
    count: bestCount,
    sample_job_url: sample?.job_url_direct,
  };
}

// Title-match score against the user's title_keywords. 0..1, where 1 is
// "all the user's target keywords appear in this company's titles."
function titleMatchScore(entry, keywords) {
  if (!keywords?.length) return 0;
  const titleBag = [...entry.titles].join(' ').toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (titleBag.includes(kw.toLowerCase())) hits++;
  }
  return hits / keywords.length;
}

// ── Build the four report sections ────────────────────────────────────
function classifyPortals(companies, byCompany) {
  const A1 = [], A2 = [], B = [];
  for (const portal of companies) {
    if (portal.enabled === false) continue;
    const key = normCompany(portal.name);
    const urlClass = classifyUrl(portal.careers_url);
    const entry = byCompany.get(key);
    const jobspyHits = entry?.hits?.length || 0;
    const ctx = {
      portal,
      urlClass: urlClass.kind,
      jobspyHits,
      jobspySites: entry ? [...entry.sites] : [],
      titles: entry ? [...entry.titles].slice(0, 3) : [],
      suggestion: !urlClass.isAts && entry ? suggestAtsUrl(entry) : null,
    };
    if (!urlClass.isAts && jobspyHits > 0) {
      A1.push(ctx);
    } else if (urlClass.isAts && jobspyHits === 0) {
      A2.push(ctx);
    } else if (!urlClass.isAts && jobspyHits === 0) {
      B.push(ctx);
    }
  }
  // Sort A1 by JobSpy hits desc (biggest fix opportunities first)
  A1.sort((a, b) => b.jobspyHits - a.jobspyHits);
  A2.sort((a, b) => a.portal.name.localeCompare(b.portal.name));
  B.sort((a, b) => a.portal.name.localeCompare(b.portal.name));
  return { A1, A2, B };
}

function buildDiscovery(byCompany, trackedKeys, titleKeywords) {
  const candidates = [];
  for (const [key, entry] of byCompany.entries()) {
    if (trackedKeys.has(key)) continue;
    if (!entry.hits.length) continue;
    const hitCount = entry.hits.length;
    const siteCount = entry.sites.size;
    const termCount = entry.matchedTerms.size;
    const titleMatch = titleMatchScore(entry, titleKeywords);
    // Score weighs four signals:
    //   1. Raw hit count (volume).
    //   2. Title-keyword match (relevance to title_filter, if profile-derived).
    //   3. Site spread (Indeed + LinkedIn both surfaces vs LinkedIn-only).
    //   4. Term spread (how many distinct queries pulled them up). A
    //      company hitting under "software engineer" AND "platform
    //      engineer" AND "ML engineer" is genuinely engineering-heavy,
    //      not a one-off recruiter aggregation.
    const score = hitCount
      * (1 + titleMatch)
      * (1 + (siteCount - 1) * 0.25)
      * (1 + Math.log2(termCount));
    candidates.push({
      name: entry.name,
      hitCount,
      siteCount,
      termCount,
      sites: [...entry.sites],
      titles: [...entry.titles].slice(0, 3),
      industries: [...entry.industries].slice(0, 2),
      sampleDirect: entry.hits.find(h => h.job_url_direct)?.job_url_direct,
      sampleAggregator: entry.hits[0]?.job_url,
      suggestion: suggestAtsUrl(entry),
      matchedTerms: [...entry.matchedTerms],
      score: Number(score.toFixed(2)),
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 50);
}

function esc(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderReport({ A1, A2, B, discovery, queryPlan, jobspyOut }) {
  const totalHits = (jobspyOut.queries || []).reduce((n, q) => n + (q.hit_count || 0), 0);
  const failedQueries = (jobspyOut.queries || []).filter(q => !q.ok);
  const totalDuration = (jobspyOut.queries || []).reduce((n, q) => n + (q.duration_ms || 0), 0);

  let md = '';
  md += `# Portals audit — ${TODAY}\n\n`;
  md += `Driven by [JobSpy](https://github.com/speedyapply/JobSpy) ${jobspyOut.jobspy_version || '(version unknown)'}. `;
  md += `One-shot run — see [tools/audit/README.md](../../tools/audit/README.md) for re-run instructions.\n\n`;
  md += `**No changes have been made to \`portals.yml\`.** This is a triage report — review each item and apply by hand.\n\n`;

  // ── Section A1 ──
  md += `## A1. Landing-page portals (likely fix candidates)\n\n`;
  md += `Portals whose URL doesn't match a known ATS pattern AND that JobSpy found fresh hits for. The most common direct-job-URL host from JobSpy is suggested as a replacement.\n\n`;
  if (!A1.length) {
    md += `_None._\n\n`;
  } else {
    md += `| Company | Current URL | JobSpy hits (sites) | Suggested ATS URL | Sample title |\n`;
    md += `|---|---|---:|---|---|\n`;
    for (const r of A1) {
      const linkedinOnly = r.jobspySites.length === 1 && r.jobspySites[0] === 'linkedin';
      const sug = r.suggestion
        ? `\`${esc(r.suggestion.host)}\` (${r.suggestion.classification}, ${r.suggestion.count}×) [sample](${esc(r.suggestion.sample_job_url || '')})`
        : linkedinOnly
        ? '_(LinkedIn-only — lookup needed)_'
        : '_(no ATS host in Indeed hits — lookup needed)_';
      md += `| ${esc(r.portal.name)} | \`${esc(r.portal.careers_url || '—')}\` | ${r.jobspyHits} (${r.jobspySites.join(', ')}) | ${sug} | ${esc(r.titles[0] || '—')} |\n`;
    }
    md += `\n_${A1.length} candidate${A1.length === 1 ? '' : 's'}._\n\n`;
  }

  // ── Section A2 ──
  md += `## A2. ATS-endpoint portals with no JobSpy activity\n\n`;
  md += `URL pattern looks like a real ATS endpoint, but JobSpy didn't surface hits in the past 30 days. Likely fine (company just isn't hiring at the searched archetypes), but worth a scan to confirm.\n\n`;
  if (!A2.length) {
    md += `_None._\n\n`;
  } else {
    md += `<details><summary>${A2.length} portal${A2.length === 1 ? '' : 's'} — expand</summary>\n\n`;
    md += `| Company | URL |\n|---|---|\n`;
    for (const r of A2) {
      md += `| ${esc(r.portal.name)} | \`${esc(r.portal.careers_url)}\` |\n`;
    }
    md += `\n</details>\n\n`;
  }

  // ── Section B ──
  md += `## B. Dormant portals\n\n`;
  md += `Landing-page-shaped AND zero JobSpy hits. Either the company stopped hiring at the searched archetypes, the URL is broken, or our query missed a niche. Candidates for \`enabled: false\` after a manual check.\n\n`;
  if (!B.length) {
    md += `_None._\n\n`;
  } else {
    md += `<details><summary>${B.length} portal${B.length === 1 ? '' : 's'} — expand</summary>\n\n`;
    md += `| Company | URL |\n|---|---|\n`;
    for (const r of B) {
      md += `| ${esc(r.portal.name)} | \`${esc(r.portal.careers_url)}\` |\n`;
    }
    md += `\n</details>\n\n`;
  }

  // ── Section C ──
  md += `## C. New-company candidates (top ${discovery.length})\n\n`;
  md += `Companies that showed up in JobSpy results but aren't in \`portals.yml\`. Ranked by hit count × title-keyword match × site spread × term spread (a company hitting under multiple distinct queries scores higher than one surfacing under a single niche). The "Suggested ATS host" column comes from JobSpy's job_url_direct field — if it's present, that's the URL to start from; if not (LinkedIn-only or recruiter aggregator), you'll need a manual lookup.\n\n`;
  if (!discovery.length) {
    md += `_None._\n\n`;
  } else {
    md += `| # | Company | Hits | Sites | Terms | Sample title | Matched queries | Suggested ATS host |\n`;
    md += `|---:|---|---:|---|---:|---|---|---|\n`;
    discovery.forEach((c, i) => {
      const sug = c.suggestion ? `\`${esc(c.suggestion.host)}\` (${c.suggestion.classification})` : '_(lookup needed)_';
      md += `| ${i + 1} | [${esc(c.name)}](${esc(c.sampleAggregator || '')}) | ${c.hitCount} | ${c.sites.join(', ')} | ${c.termCount} | ${esc(c.titles[0] || '—')} | ${esc([...c.matchedTerms].slice(0, 4).join(', '))}${c.matchedTerms.length > 4 ? ` _+${c.matchedTerms.length - 4} more_` : ''} | ${sug} |\n`;
    });
    md += '\n';
  }

  // ── Section D ──
  md += `## D. Summary\n\n`;
  const indeedQueries = queryPlan.queries.filter(q => q.site === 'indeed').length;
  const linkedinQueries = queryPlan.queries.filter(q => q.site === 'linkedin').length;
  const uniqueTerms = [...new Set(queryPlan.queries.map(q => q.search_term))];
  md += `- **JobSpy version:** ${jobspyOut.jobspy_version}\n`;
  md += `- **Queries run:** ${queryPlan.queries.length} (${indeedQueries} Indeed${linkedinQueries ? ` + ${linkedinQueries} LinkedIn` : ', LinkedIn skipped'})\n`;
  md += `- **Distinct search terms:** ${uniqueTerms.length} — ${uniqueTerms.map(t => `\`${t}\``).join(', ')}\n`;
  md += `- **Total hits scraped:** ${totalHits}\n`;
  md += `- **Total JobSpy duration:** ${(totalDuration / 1000).toFixed(1)}s\n`;
  md += `- **Failed queries:** ${failedQueries.length}${failedQueries.length ? ` (${failedQueries.map(q => `${q.request?.site}: ${q.error}`).join('; ')})` : ''}\n`;
  md += `- **Sections:** A1 = ${A1.length}, A2 = ${A2.length}, B = ${B.length}, C = ${discovery.length}\n\n`;
  md += `_Re-run with \`node tools/audit/run-audit.mjs\` (full), \`--no-linkedin\` (Indeed-only, ~1 min), or \`--cached\` (replay last results). Cached raw data at \`tools/audit/last-results.json\`._\n`;
  return md;
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  const portalsYml = readYaml(join(REPO, 'portals.yml'));
  const profile = readYaml(join(REPO, 'config', 'profile.yml'));
  const companies = portalsYml.tracked_companies || [];
  const trackedKeys = new Set(companies.map(c => normCompany(c.name)));
  // title_keywords still drives the discovery score's relevance signal,
  // but the query bank itself no longer comes from the profile — see
  // DEFAULT_TERMS above for the rationale.
  const titleKeywords = profile?.target_roles?.title_keywords || profile?.target_roles?.primary || [];

  console.log(`📋 portals.yml: ${companies.length} companies (${companies.filter(c => c.enabled !== false).length} enabled)`);

  const plan = buildQueryPlan();
  const indeedQ = plan.queries.filter(q => q.site === 'indeed').length;
  const linkedinQ = plan.queries.filter(q => q.site === 'linkedin').length;
  console.log(`🎯 query plan: ${plan.queries.length} queries — ${indeedQ} Indeed${linkedinQ ? ` + ${linkedinQ} LinkedIn` : ''} across ${[...new Set(plan.queries.map(q => q.search_term))].length} terms`);
  if (TERMS_FILE) console.log(`📥 terms-file: ${TERMS_FILE}`);
  if (NO_LINKEDIN) console.log(`⚡ --no-linkedin: Indeed-only run (expect ~1 min)`);
  console.log('');

  // Warn the user (but don't block) if the cache is recent enough that
  // a fresh run is probably wasted. JobSpy's per-IP throttling means
  // back-to-back full runs are a bad idea.
  if (!USE_CACHE && existsSync(CACHE_PATH)) {
    const ageHours = (Date.now() - statSync(CACHE_PATH).mtimeMs) / 3_600_000;
    if (ageHours < 6) {
      console.log(`⚠️  cached results are only ${ageHours.toFixed(1)}h old — consider --cached instead of a fresh hit\n`);
    }
  }

  if (DRY_RUN) {
    console.log('--dry-run: skipping JobSpy. Classifying current portals only.\n');
    const byCompany = new Map();
    const sections = classifyPortals(companies, byCompany);
    console.log(`  A1 (landing + would-be hits): ${sections.A1.length}`);
    console.log(`  A2 (ats + no hits): ${sections.A2.length}`);
    console.log(`  B  (dormant): ${sections.B.length}`);
    return;
  }

  let jobspyOut;
  if (USE_CACHE && existsSync(CACHE_PATH)) {
    console.log(`📦 reusing cached results from ${CACHE_PATH}\n`);
    jobspyOut = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } else {
    console.log(`🐍 spawning ${PY} jobspy_audit.py …\n`);
    jobspyOut = await runJobSpy(plan);
    writeFileSync(CACHE_PATH, JSON.stringify(jobspyOut));
    console.log(`\n💾 cached raw results to ${CACHE_PATH}`);
  }

  const byCompany = aggregateHits(jobspyOut);
  const sections = classifyPortals(companies, byCompany);
  const discovery = buildDiscovery(byCompany, trackedKeys, titleKeywords);

  const md = renderReport({
    A1: sections.A1,
    A2: sections.A2,
    B: sections.B,
    discovery,
    queryPlan: plan,
    jobspyOut,
  });

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, md);
  console.log(`\n📝 wrote ${REPORT_PATH}`);
  console.log(`   A1 (landing-page portals to fix): ${sections.A1.length}`);
  console.log(`   A2 (ats endpoint, no recent hits): ${sections.A2.length}`);
  console.log(`   B  (dormant portals): ${sections.B.length}`);
  console.log(`   C  (new-company candidates): ${discovery.length}`);
}

main().catch(err => {
  console.error('\nFAILED:', err.stack || err.message);
  process.exit(1);
});
