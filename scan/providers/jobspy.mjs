/**
 * scan/providers/jobspy.mjs — JobSpy fallback provider.
 *
 * For companies whose careers page is fully custom (Epic, Riot, Roblox,
 * Meta, etc.) and has no public ATS endpoint, we can still get a job
 * stream by searching public boards (Indeed, LinkedIn) via JobSpy and
 * filtering hits down to that one company.
 *
 * Opt-in per company in portals.yml:
 *   - name: Epic Games
 *     careers_url: https://www.epicgames.com/site/en-US/careers
 *     scan_method: jobspy
 *
 * Why a per-company opt-in rather than auto-enable: JobSpy hits LinkedIn
 * and Indeed which rate-limit aggressively. Running it across hundreds
 * of companies on a normal scan cadence is a bad neighbor and will get
 * the venv blocked. The healthcheck Phase 3 step is what populates the
 * opt-in list — only companies where JobSpy actually returns hits get
 * marked.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY = process.platform === 'win32'
  ? join(ROOT, 'tools', 'audit', '.venv', 'Scripts', 'python.exe')
  : join(ROOT, 'tools', 'audit', '.venv', 'bin', 'python');
const SCRIPT = join(ROOT, 'tools', 'audit', 'jobspy_audit.py');

const DEFAULT_SITES = ['indeed']; // LinkedIn rate-limits hard. Opt in via config.
const DEFAULT_RESULTS = 25;
const DEFAULT_HOURS_OLD = 720; // 30 days
const PROCESS_TIMEOUT_MS = 90_000;

function normalizeCompanyName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function namesMatch(a, b) {
  return normalizeCompanyName(a) === normalizeCompanyName(b);
}

/**
 * Run jobspy_audit.py for one company. Resolves to the parsed result
 * envelope; rejects on hard failure (timeout, non-zero exit not from
 * the audit's own fatal field).
 */
async function runJobspy(query) {
  if (!existsSync(PY) || !existsSync(SCRIPT)) {
    throw new Error('jobspy venv or audit script missing — run tools/audit setup first');
  }
  const plan = {
    queries: [query],
    per_site_delay_sec: { indeed: 1, linkedin: 4, glassdoor: 2 },
  };
  return await new Promise((res, rej) => {
    const proc = spawn(PY, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      rej(new Error('jobspy timeout'));
    }, PROCESS_TIMEOUT_MS);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => (stdout += c));
    proc.stderr.on('data', (c) => (stderr += c));
    proc.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.fatal) return rej(new Error(parsed.fatal));
        return res(parsed);
      } catch (e) {
        rej(new Error(`jobspy: exit ${code}, parse failed: ${e.message}. Stderr: ${stderr.slice(0, 200)}`));
      }
    });
    proc.stdin.end(JSON.stringify(plan));
  });
}

function match(company) {
  return String(company.scan_method || '').toLowerCase() === 'jobspy';
}

function buildUrl(company) {
  return `jobspy://${normalizeCompanyName(company.name)}`;
}

/**
 * Probe JobSpy for jobs at a single company. Used both by the scanner
 * (when `scan_method: jobspy`) and by healthcheck Phase 3 (when
 * verifying that a still-broken company is jobspy-trackable).
 *
 * @returns {Promise<{ jobs: Array, meta?: object }>}
 */
async function fetchJobspyForCompany(company, options = {}) {
  const sites = options.sites || (company.jobspy_sites && Array.isArray(company.jobspy_sites)
    ? company.jobspy_sites
    : DEFAULT_SITES);
  const searchTerm = options.searchTerm || company.jobspy_query || company.name;
  const location = options.location || company.jobspy_location || '';
  const resultsWanted = options.resultsWanted || company.jobspy_results || DEFAULT_RESULTS;
  const hoursOld = options.hoursOld || company.jobspy_hours_old || DEFAULT_HOURS_OLD;

  const allHits = [];
  for (const site of sites) {
    let result;
    try {
      result = await runJobspy({
        site,
        search_term: searchTerm,
        location,
        results_wanted: resultsWanted,
        hours_old: hoursOld,
        country_indeed: company.jobspy_country || 'USA',
      });
    } catch (err) {
      continue; // try next site
    }
    const q = result.queries?.[0];
    if (!q || !q.ok || !q.hits) continue;
    for (const hit of q.hits) {
      if (!namesMatch(hit.company, company.name)) continue;
      allHits.push({
        title: hit.title || '',
        url: hit.job_url_direct || hit.job_url || '',
        company: company.name,
        location: hit.location || '',
        postedAt: (hit.date_posted || '').slice(0, 10),
        source: site,
      });
    }
  }
  return { jobs: allHits };
}

export { fetchJobspyForCompany };

export default {
  name: 'jobspy',
  description: 'Filter LinkedIn/Indeed hits down to one company via JobSpy',
  needsPlaywright: false,
  match,
  buildUrl,
  async fetch(company) {
    return await fetchJobspyForCompany(company);
  },
};
