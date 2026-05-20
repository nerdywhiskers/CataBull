#!/usr/bin/env node

/**
 * resolve-urls.mjs — second pass on the JobSpy audit results.
 *
 * The first pass (run-audit.mjs) classifies tracked portals as
 * landing-page vs ATS-endpoint and surfaces new-company candidates.
 * Many of those classifications come back as "JobSpy says hiring,
 * couldn't auto-suggest an ATS URL" — usually because LinkedIn doesn't
 * expose job_url_direct, or Indeed surfaced an aggregator-internal
 * link.
 *
 * This pass closes that gap by visiting each candidate's careers
 * landing page over plain HTTP and scanning the HTML for embedded ATS
 * markers (Greenhouse iframe, Ashby script tag, Lever link, Workday
 * URL pattern, etc.). For ~50% of A1 entries this surfaces the real
 * ATS endpoint without any agent help. For the rest (Big Tech custom
 * ATS like Netflix / Google / Apple), we emit a `scan_method:
 * websearch` recommendation instead — that's the project's documented
 * fallback for non-ATS portals.
 *
 * Output: tools/audit/resolved-urls.json (consumed by apply-patches.mjs).
 *
 * Usage:
 *   node tools/audit/resolve-urls.mjs                       # full pass
 *   node tools/audit/resolve-urls.mjs --a1-only             # skip C
 *   node tools/audit/resolve-urls.mjs --c-only              # skip A1
 *   node tools/audit/resolve-urls.mjs --concurrency 4       # default 4
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const A1_ONLY = argv.includes('--a1-only');
const C_ONLY = argv.includes('--c-only');
const CONCURRENCY = (() => {
  const i = argv.indexOf('--concurrency');
  return i >= 0 && argv[i + 1] ? Math.max(1, parseInt(argv[i + 1], 10)) : 4;
})();

const CACHE_PATH = join(__dirname, 'last-results.json');
const OUT_PATH = join(__dirname, 'resolved-urls.json');
const REPORT_PATH = join(REPO, 'docs', 'audit', `portals-resolved-${new Date().toISOString().slice(0, 10)}.md`);

// ── ATS detection patterns ────────────────────────────────────────────
// Each pattern matches a host (or full URL fragment) inside the fetched
// HTML — iframe src, link href, script src, or anywhere else. The slug
// extractor pulls the company-specific path segment so we can build the
// canonical careers URL without further guesswork.
const ATS_DETECTORS = [
  {
    kind: 'greenhouse',
    re: /https?:\/\/(?:job-?boards|boards)(\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)/gi,
    canonical: (m) => {
      const eu = m[1] ? '.eu' : '';
      return {
        host: `job-boards${eu}.greenhouse.io`,
        slug: m[2],
        url: `https://job-boards${eu}.greenhouse.io/${m[2]}`,
        api: `https://boards-api${eu ? '.eu' : ''}.greenhouse.io/v1/boards/${m[2]}/jobs`,
      };
    },
  },
  {
    kind: 'greenhouse_embed',
    re: /<div[^>]+id=["']grnhse_app["'][^>]+data-board=["']([a-z0-9_-]+)["']/gi,
    canonical: (m) => ({
      host: 'job-boards.greenhouse.io',
      slug: m[1],
      url: `https://job-boards.greenhouse.io/${m[1]}`,
      api: `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs`,
    }),
  },
  {
    kind: 'ashby',
    re: /https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/gi,
    canonical: (m) => ({
      host: 'jobs.ashbyhq.com',
      slug: m[1],
      url: `https://jobs.ashbyhq.com/${m[1]}`,
    }),
  },
  {
    kind: 'lever',
    re: /https?:\/\/jobs\.lever\.co\/([a-z0-9_-]+)/gi,
    canonical: (m) => ({
      host: 'jobs.lever.co',
      slug: m[1],
      url: `https://jobs.lever.co/${m[1]}`,
    }),
  },
  {
    kind: 'workday',
    // Workday URLs come in two shapes:
    //   <sub>.wd1.myworkdayjobs.com/<JobBoard>          (no locale)
    //   <sub>.wd1.myworkdayjobs.com/<locale>/<JobBoard> (with locale)
    // The locale segment is always `xx-XX` (e.g., en-US). When the URL
    // has a locale, capture the JobBoard segment after it; otherwise
    // capture the first segment as the JobBoard.
    re: /https?:\/\/([a-z0-9_-]+)\.(wd[1-9])\.myworkdayjobs\.com\/(?:([a-z]{2}-[A-Z]{2})\/)?([A-Za-z0-9_]+)/gi,
    canonical: (m) => {
      const sub = m[1], shard = m[2], locale = m[3], board = m[4];
      const path = locale ? `${locale}/${board}` : board;
      return {
        host: `${sub}.${shard}.myworkdayjobs.com`,
        slug: board,
        url: `https://${sub}.${shard}.myworkdayjobs.com/${path}`,
      };
    },
  },
  {
    kind: 'smartrecruiters',
    re: /https?:\/\/(?:careers|jobs)\.smartrecruiters\.com\/([a-z0-9_-]+)/gi,
    canonical: (m) => ({
      host: 'careers.smartrecruiters.com',
      slug: m[1],
      url: `https://careers.smartrecruiters.com/${m[1]}`,
    }),
  },
  {
    kind: 'bamboohr',
    re: /https?:\/\/([a-z0-9_-]+)\.bamboohr\.com\/(?:careers|jobs)/gi,
    canonical: (m) => ({
      host: `${m[1]}.bamboohr.com`,
      slug: m[1],
      url: `https://${m[1]}.bamboohr.com/careers`,
    }),
  },
  {
    kind: 'teamtailor',
    re: /https?:\/\/([a-z0-9_-]+)\.teamtailor\.com/gi,
    canonical: (m) => ({
      host: `${m[1]}.teamtailor.com`,
      slug: m[1],
      url: `https://${m[1]}.teamtailor.com/jobs`,
    }),
  },
  {
    kind: 'workable',
    // Workable URLs: apply.workable.com/<company>/j/<jobid> (per-job)
    //                apply.workable.com/<company>            (board)
    // Only match when the path has 2+ chars AND isn't a generic word
    // (j, jobs, careers, login, apply) — those are job-URL fragments,
    // not company slugs.
    re: /https?:\/\/(?:apply|jobs)\.workable\.com\/([a-z0-9_-]{2,})/gi,
    canonical: (m) => ({
      host: 'apply.workable.com',
      slug: m[1],
      url: `https://apply.workable.com/${m[1]}/`,
    }),
    rejectSlug: ['j', 'jobs', 'careers', 'login', 'apply', 'admin'],
  },
  {
    kind: 'rippling',
    re: /https?:\/\/ats\.rippling\.com\/([a-z0-9_-]+)/gi,
    canonical: (m) => ({
      host: 'ats.rippling.com',
      slug: m[1],
      url: `https://ats.rippling.com/${m[1]}/jobs`,
    }),
  },
  {
    kind: 'recruitee',
    re: /https?:\/\/([a-z0-9_-]+)\.recruitee\.com/gi,
    canonical: (m) => ({
      host: `${m[1]}.recruitee.com`,
      slug: m[1],
      url: `https://${m[1]}.recruitee.com/`,
    }),
  },
  {
    kind: 'breezy',
    re: /https?:\/\/([a-z0-9_-]+)\.breezy\.hr/gi,
    canonical: (m) => ({
      host: `${m[1]}.breezy.hr`,
      slug: m[1],
      url: `https://${m[1]}.breezy.hr/`,
    }),
  },
  {
    kind: 'pinpoint',
    re: /https?:\/\/([a-z0-9_-]+)\.pinpointhq\.com/gi,
    canonical: (m) => ({
      host: `${m[1]}.pinpointhq.com`,
      slug: m[1],
      url: `https://${m[1]}.pinpointhq.com/`,
    }),
  },
  {
    kind: 'jobvite',
    re: /https?:\/\/jobs\.jobvite\.com\/([a-z0-9_-]+)/gi,
    canonical: (m) => ({
      host: 'jobs.jobvite.com',
      slug: m[1],
      url: `https://jobs.jobvite.com/${m[1]}`,
    }),
  },
  {
    kind: 'paylocity',
    re: /https?:\/\/recruiting\.paylocity\.com\/recruiting\/jobs\/all\/([a-z0-9_-]+)/gi,
    canonical: (m) => ({
      host: 'recruiting.paylocity.com',
      slug: m[1],
      url: `https://recruiting.paylocity.com/recruiting/jobs/all/${m[1]}`,
    }),
  },
];

function normCompany(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/[,.]/g, ' ')
    .replace(/\b(inc|llc|ltd|gmbh|pbc|sa|s\.a\.|co|corp|corporation|group|holdings|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectAts(html) {
  // Returns the highest-confidence detection — the one with the most
  // matches in the HTML — so a page that embeds a Greenhouse iframe
  // AND links to a company tweet doesn't get falsely classified as
  // Twitter-something. Tally per kind, return the winner.
  const tallies = new Map();
  const samples = new Map();
  for (const det of ATS_DETECTORS) {
    let m;
    while ((m = det.re.exec(html)) !== null) {
      const can = det.canonical(m);
      // Per-detector slug blocklist filters out matches like
      // apply.workable.com/j/<id> where "j" is a routing fragment.
      if (det.rejectSlug && det.rejectSlug.includes(String(can.slug || '').toLowerCase())) continue;
      // Reject 1-char slugs across the board — almost always a false
      // positive (regex captured a query-string char or similar).
      if (!can.slug || String(can.slug).length < 2) continue;
      const key = `${det.kind}:${can.slug}`;
      tallies.set(key, (tallies.get(key) || 0) + 1);
      if (!samples.has(key)) samples.set(key, { kind: det.kind, ...can });
    }
    det.re.lastIndex = 0; // reset stateful global regex
  }
  if (!tallies.size) return null;
  const best = [...tallies.entries()].sort((a, b) => b[1] - a[1])[0];
  return { ...samples.get(best[0]), match_count: best[1] };
}

async function fetchHtml(url, { timeoutMs = 12_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        // Some careers pages 403 a default Node UA. Mimic a normal browser.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) return { ok: false, status: res.status, html: null, finalUrl: res.url };
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html')) return { ok: false, status: res.status, html: null, finalUrl: res.url, reason: `non-html content-type: ${ct}` };
    const html = await res.text();
    return { ok: true, status: res.status, html, finalUrl: res.url };
  } catch (err) {
    return { ok: false, status: 0, html: null, finalUrl: url, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Pool fetches with a bounded concurrency so we don't open hundreds of
// sockets at once. The careers pages are scattered across hundreds of
// domains — the bottleneck is each individual page's response time, so
// 4–8 in flight gives us throughput without hammering any one host.
async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

function buildScanQuery(brandedUrl, atsHost) {
  // Pulls a Google search query like:
  //   site:openai.com/careers OR site:job-boards.greenhouse.io/openai
  // The scanner already supports `scan_method: websearch` + `scan_query`;
  // this is the shape it expects.
  let host = '';
  try { host = new URL(brandedUrl).hostname.replace(/^www\./, ''); } catch { return null; }
  const path = (() => { try { return new URL(brandedUrl).pathname; } catch { return ''; } })();
  const sitePart = `site:${host}${path && path !== '/' ? path : ''}`;
  if (!atsHost) return sitePart;
  return `${sitePart} OR site:${atsHost}`;
}

function bucketCandidate({ name, currentUrl, jobspyAtsHint, atsDetected }) {
  // Translate detection results into a single "what should portals.yml
  // look like for this entry?" recommendation. Returns null if we
  // can't make a confident call (caller drops to manual review).
  const ats = atsDetected || jobspyAtsHint;
  if (ats) {
    return {
      action: 'use_ats',
      careers_url: ats.url,
      api: ats.api || null,
      ats_kind: ats.kind,
      provenance: atsDetected ? 'detected_in_html' : 'jobspy_job_url_direct',
    };
  }
  // No ATS pattern anywhere → if we have a working branded URL, fall
  // back to scan_method: websearch with a templated query.
  if (currentUrl) {
    return {
      action: 'use_websearch_fallback',
      careers_url: currentUrl,
      scan_method: 'websearch',
      scan_query: buildScanQuery(currentUrl, null),
      provenance: 'no_ats_pattern_detected',
    };
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(CACHE_PATH)) {
    console.error(`No cached audit results at ${CACHE_PATH}. Run "node tools/audit/run-audit.mjs" first.`);
    process.exit(1);
  }
  const audit = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  const portals = yaml.load(readFileSync(join(REPO, 'portals.yml'), 'utf8'));
  const trackedByKey = new Map((portals.tracked_companies || []).map(c => [normCompany(c.name), c]));

  // Re-aggregate JobSpy hits per company so we can look up sample URLs
  // when building C entries (mirrors run-audit.mjs's aggregation step
  // but kept tiny here).
  const byCompany = new Map();
  for (const q of (audit.queries || [])) {
    if (!q.ok) continue;
    for (const hit of (q.hits || [])) {
      if (!hit.company) continue;
      const key = normCompany(hit.company);
      if (!key) continue;
      const e = byCompany.get(key) || { name: hit.company, hits: [], sites: new Set() };
      e.hits.push(hit);
      e.sites.add(hit.site);
      byCompany.set(key, e);
    }
  }

  // Build the work list: A1 entries (existing tracked, landing-page,
  // hits) + C entries (untracked, ranked).
  const a1 = [];
  if (!C_ONLY) {
    for (const [key, entry] of byCompany.entries()) {
      const portal = trackedByKey.get(key);
      if (!portal) continue;
      if (portal.enabled === false) continue;
      // Skip entries whose current URL already matches a known ATS
      // pattern — those are A2 and don't need resolution.
      if (ATS_DETECTORS.some(d => d.re.test(portal.careers_url || ''))) {
        for (const d of ATS_DETECTORS) d.re.lastIndex = 0;
        continue;
      }
      for (const d of ATS_DETECTORS) d.re.lastIndex = 0;
      // Pull a JobSpy hint (job_url_direct that matches a known ATS).
      let jobspyHint = null;
      for (const hit of entry.hits) {
        if (!hit.job_url_direct) continue;
        const det = detectAts(hit.job_url_direct);
        if (det) { jobspyHint = det; break; }
      }
      a1.push({
        section: 'A1',
        name: portal.name,
        currentUrl: portal.careers_url,
        jobspyAtsHint: jobspyHint,
        sample_titles: [...new Set(entry.hits.map(h => h.title).filter(Boolean))].slice(0, 3),
        hit_count: entry.hits.length,
        sites: [...entry.sites],
      });
    }
  }

  const c = [];
  if (!A1_ONLY) {
    for (const [key, entry] of byCompany.entries()) {
      if (trackedByKey.has(key)) continue;
      // Reject ultra-short or generic-looking company names — these
      // tend to be initialisms scraped from corporate jargon ("WD",
      // "ICF", "EXP") that need a manual lookup before they're useful
      // to ship in the default template.
      if (!entry.name || entry.name.length < 4) continue;
      // Only resolve the top 50 to mirror the audit report's cutoff.
      // Order by hit count.
      c.push({
        section: 'C',
        name: entry.name,
        currentUrl: null,
        jobspyAtsHint: (() => {
          for (const hit of entry.hits) {
            if (!hit.job_url_direct) continue;
            const det = detectAts(hit.job_url_direct);
            if (det) return det;
          }
          return null;
        })(),
        sample_titles: [...new Set(entry.hits.map(h => h.title).filter(Boolean))].slice(0, 3),
        sample_urls: [...new Set(entry.hits.map(h => h.job_url).filter(Boolean))].slice(0, 3),
        hit_count: entry.hits.length,
        sites: [...entry.sites],
      });
    }
    c.sort((a, b) => b.hit_count - a.hit_count);
    c.length = Math.min(c.length, 50);
  }

  console.log(`📦 work list: ${a1.length} A1 entries + ${c.length} C candidates (concurrency=${CONCURRENCY})\n`);

  // Resolve A1 by fetching the company's branded URL and scanning HTML.
  console.log(`A1 — fetching ${a1.length} branded URLs…`);
  const a1Results = await pool(a1, CONCURRENCY, async (entry, i) => {
    process.stderr.write(`  [${(i + 1).toString().padStart(2)}/${a1.length}] ${entry.name.padEnd(28)} ${entry.currentUrl}\n`);
    const fetched = await fetchHtml(entry.currentUrl);
    let detected = null;
    if (fetched.ok && fetched.html) {
      detected = detectAts(fetched.html);
    }
    return {
      ...entry,
      atsDetected: detected,
      fetch: { ok: fetched.ok, status: fetched.status, finalUrl: fetched.finalUrl, reason: fetched.reason || null },
      bucket: bucketCandidate({
        name: entry.name,
        currentUrl: entry.currentUrl,
        jobspyAtsHint: entry.jobspyAtsHint,
        atsDetected: detected,
      }),
    };
  });

  // C entries don't have a known branded URL — for now we trust the
  // jobspy hint (job_url_direct → ATS host) when present. A future
  // pass could guess `<slug>.com/careers` and verify, but that's
  // brittle and not strictly necessary for the apply step.
  console.log(`\nC — ${c.length} new-company candidates (no fetch — JobSpy hints only)…`);
  const cResults = c.map((entry) => ({
    ...entry,
    atsDetected: null,
    fetch: null,
    bucket: bucketCandidate({
      name: entry.name,
      currentUrl: null,
      jobspyAtsHint: entry.jobspyAtsHint,
      atsDetected: null,
    }),
  }));

  // Tally + write
  const tally = (rows) => {
    const t = { use_ats: 0, use_websearch_fallback: 0, manual: 0 };
    for (const r of rows) {
      if (!r.bucket) t.manual++;
      else t[r.bucket.action]++;
    }
    return t;
  };
  const a1Tally = tally(a1Results);
  const cTally = tally(cResults);

  console.log(`\n📊 A1 outcomes: ${a1Tally.use_ats} ATS-resolved · ${a1Tally.use_websearch_fallback} websearch fallback · ${a1Tally.manual} manual`);
  console.log(`📊 C  outcomes: ${cTally.use_ats} ATS-resolved · ${cTally.use_websearch_fallback} websearch fallback · ${cTally.manual} manual`);

  const out = {
    generated_at: new Date().toISOString(),
    a1: a1Results,
    c: cResults,
    summary: { a1: a1Tally, c: cTally },
  };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\n💾 wrote ${OUT_PATH}`);

  // Companion markdown report so the resolution pass is reviewable.
  let md = `# Portals audit — URL resolution pass — ${new Date().toISOString().slice(0, 10)}\n\n`;
  md += `Second pass on \`tools/audit/last-results.json\`. For each landing-page portal (A1) and each new-company candidate (C), we fetched the company's careers page and scanned the HTML for embedded ATS markers. Results bucket into:\n\n`;
  md += `- **use_ats**: HTML revealed an ATS embed → drop the ATS URL into \`portals.yml\`. \`api:\` field added when the ATS supports direct API scraping.\n`;
  md += `- **use_websearch_fallback**: page exists but no known ATS pattern (Big Tech custom ATS) → set \`scan_method: websearch\` with a templated \`scan_query\`.\n`;
  md += `- **manual**: page unreachable or pattern matching ambiguous → human review required.\n\n`;
  md += `Apply with \`node tools/audit/apply-patches.mjs --apply\`. Defaults to dry-run.\n\n`;

  md += `## A1 — landing-page portals (${a1Results.length})\n\n`;
  md += `| Company | Current URL | Bucket | Action |\n|---|---|---|---|\n`;
  for (const r of a1Results) {
    const action = !r.bucket
      ? '_manual_'
      : r.bucket.action === 'use_ats'
      ? `→ \`${r.bucket.careers_url}\` (${r.bucket.ats_kind}, ${r.bucket.provenance})`
      : `→ \`scan_method: websearch\`, \`scan_query: ${r.bucket.scan_query || '_(none)_'}\``;
    const bucketLabel = r.bucket?.action || (r.fetch?.ok === false ? 'unreachable' : 'manual');
    md += `| ${r.name} | \`${r.currentUrl || '—'}\` | ${bucketLabel} | ${action} |\n`;
  }
  md += `\n## C — new-company candidates (${cResults.length})\n\n`;
  md += `| Company | Hits | Sites | Bucket | Action |\n|---|---:|---|---|---|\n`;
  for (const r of cResults) {
    const action = !r.bucket
      ? '_manual_ (LinkedIn-only or no ATS host in hits)'
      : r.bucket.action === 'use_ats'
      ? `→ add as \`${r.bucket.careers_url}\` (${r.bucket.ats_kind})`
      : '';
    const bucketLabel = r.bucket?.action || 'manual';
    md += `| ${r.name} | ${r.hit_count} | ${r.sites.join(', ')} | ${bucketLabel} | ${action} |\n`;
  }
  writeFileSync(REPORT_PATH, md);
  console.log(`📝 wrote ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error('FAILED:', err.stack || err.message);
  process.exit(1);
});
