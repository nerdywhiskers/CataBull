/**
 * healthcheck-phase2.mjs — Playwright network-capture probe.
 *
 * For companies whose careers page renders but exposes no <a href> link
 * to an ATS (the entire `unknown_ats` failure class), inspecting the
 * page's network activity often reveals the real ATS endpoint anyway —
 * the marketing page is making XHR/fetch calls to greenhouse/ashby/lever
 * or embedding an iframe whose `src` points at smartrecruiters/workable.
 *
 * Strategy per company:
 *   1. Launch a page, record every network request.
 *   2. Wait for networkidle (capped at 8s).
 *   3. Match recorded request URLs against known ATS hostname patterns.
 *   4. Also scan page.content() for <iframe src=...> ATS hosts (some
 *      embeds are added post-render and never trigger an XHR we can
 *      catch on the parent context).
 *   5. For each candidate slug, verify by hitting the public JSON API
 *      and counting jobs. Confidence comes from the API responding, not
 *      from the slug looking right.
 *
 * Returns null if nothing usable is found — the caller then routes to
 * Phase 3 (JobSpy fallback) or manual triage.
 */

import { launchChromiumWithRetry } from '../lib/playwright-launch.mjs';

const NAV_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 8_000;
const VERIFY_TIMEOUT_MS = 10_000;

// Patterns that uniquely identify an ATS request. Each yields the
// provider name plus the slug/tenant we'd need to wire up the company.
const ATS_PATTERNS = [
  {
    provider: 'greenhouse',
    re: /boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)\/jobs/i,
    careersUrl: (slug) => `https://job-boards.greenhouse.io/${slug}`,
    api: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    verify: async (slug) => {
      const r = await safeFetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
      return r?.json?.jobs?.length || 0;
    },
  },
  {
    provider: 'greenhouse',
    // Embedded iframe form
    re: /(?:boards|job-boards(?:\.eu)?)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([^/?#&]+)/i,
    careersUrl: (slug) => `https://job-boards.greenhouse.io/${slug}`,
    api: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    verify: async (slug) => {
      const r = await safeFetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
      return r?.json?.jobs?.length || 0;
    },
  },
  {
    provider: 'ashby',
    re: /api\.ashbyhq\.com\/posting-api\/job-board\/([^/?#]+)/i,
    careersUrl: (slug) => `https://jobs.ashbyhq.com/${slug}`,
    verify: async (slug) => {
      const r = await safeFetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
      return r?.json?.jobs?.length || 0;
    },
  },
  {
    provider: 'ashby',
    re: /jobs\.ashbyhq\.com\/([^/?#]+)/i,
    careersUrl: (slug) => `https://jobs.ashbyhq.com/${slug}`,
    verify: async (slug) => {
      const r = await safeFetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
      return r?.json?.jobs?.length || 0;
    },
  },
  {
    provider: 'lever',
    re: /api\.lever\.co\/v0\/postings\/([^/?#]+)/i,
    careersUrl: (slug) => `https://jobs.lever.co/${slug}`,
    verify: async (slug) => {
      const r = await safeFetch(`https://api.lever.co/v0/postings/${slug}`);
      return Array.isArray(r?.json) ? r.json.length : 0;
    },
  },
  {
    provider: 'lever',
    re: /jobs\.lever\.co\/([^/?#]+)/i,
    careersUrl: (slug) => `https://jobs.lever.co/${slug}`,
    verify: async (slug) => {
      const r = await safeFetch(`https://api.lever.co/v0/postings/${slug}`);
      return Array.isArray(r?.json) ? r.json.length : 0;
    },
  },
  {
    provider: 'workday',
    // wday/cxs/{tenant}/{site}/jobs — the actual XHR
    re: /https?:\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com\/wday\/cxs\/[^/]+\/([^/?#]+)\/jobs/i,
    careersUrl: (tenant, shard, site) => `https://${tenant}.${shard}.myworkdayjobs.com/${site}`,
    extract: (m) => ({ tenant: m[1], shard: m[2], site: m[3] }),
    verify: async () => 1, // Workday API requires POST; presence of the URL is strong enough
  },
  {
    provider: 'workday',
    // User-facing URL form
    re: /https?:\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com\/(?:en-US\/)?([^/?#]+)/i,
    careersUrl: (tenant, shard, site) => `https://${tenant}.${shard}.myworkdayjobs.com/${site}`,
    extract: (m) => ({ tenant: m[1], shard: m[2], site: m[3] }),
    verify: async () => 1,
  },
  {
    provider: 'smartrecruiters',
    re: /api\.smartrecruiters\.com\/v1\/companies\/([^/?#]+)\/postings/i,
    careersUrl: (slug) => `https://careers.smartrecruiters.com/${slug}`,
    verify: async (slug) => {
      const r = await safeFetch(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=10`);
      return r?.json?.content?.length || (r?.json?.totalFound ?? 0);
    },
  },
  {
    provider: 'smartrecruiters',
    re: /careers\.smartrecruiters\.com\/([^/?#]+)/i,
    careersUrl: (slug) => `https://careers.smartrecruiters.com/${slug}`,
    verify: async (slug) => {
      const r = await safeFetch(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=10`);
      return r?.json?.content?.length || (r?.json?.totalFound ?? 0);
    },
  },
  {
    provider: 'workable',
    re: /apply\.workable\.com\/(?:api\/v[0-9]+\/accounts\/)?([^/?#]+)/i,
    careersUrl: (slug) => `https://apply.workable.com/${slug}/`,
    verify: async () => 1,
  },
  {
    provider: 'teamtailor',
    re: /([a-z0-9-]+)\.teamtailor\.com/i,
    careersUrl: (slug) => `https://${slug}.teamtailor.com/jobs`,
    verify: async () => 1,
  },
  {
    provider: 'bamboohr',
    re: /([a-z0-9-]+)\.bamboohr\.com\/(?:careers|jobs)/i,
    careersUrl: (slug) => `https://${slug}.bamboohr.com/careers`,
    verify: async () => 1,
  },
  {
    // Phenom People — used by Adobe, T-Mobile, Lowe's, Verizon, many F500.
    // The Phenom JSON API is locked behind their CDN and rejects direct
    // curl/POST. We can't verify via API, but if we see Phenom asset/script
    // URLs in the page's network traffic, the careers page is Phenom-backed.
    // Patching careers_url to `<origin>/search-results` reliably surfaces
    // job listings to the existing webfetch provider, which scrapes
    // `a[href*="/job/"]` (Phenom's posting URL pattern).
    //
    // The `slug` here is the Phenom tenant code (e.g. ADOBUS for Adobe),
    // which we keep for future use even though we don't currently hit any
    // tenant-specific endpoint with it.
    provider: 'phenom',
    re: /content-(?:us|eu)\.phenompeople\.com\/api\/([A-Z0-9]+)\//i,
    // The careers_url is the page that listed Phenom in its XHRs — that's
    // already known by the caller, so we hand off via a closure-free signal.
    // pickBestMatch detects provider==='phenom' and patches relative to the
    // probe's own URL.
    extract: (m) => ({ tenant: m[1] }),
    careersUrl: () => null, // computed in pickBestMatch from probe URL
    verify: async () => 1,
  },
  {
    provider: 'phenom',
    re: /cdn\.phenompeople\.com\/CareerConnectResources/i,
    extract: () => ({ tenant: null }),
    careersUrl: () => null,
    verify: async () => 1,
  },
];

// Hosts where a match on the bare hostname is meaningless (e.g. CDN
// links, static assets, the marketing site itself). We only count
// matches whose URL path contains an actual identifying segment.
function isUsableMatch(provider, slug) {
  if (!slug) return false;
  // Slugs of length 1 are guaranteed garbage (typically a "v1" or "en"
  // path segment mistakenly matched). Min 2 chars.
  if (slug.length < 2) return false;
  // Discard obvious non-slug values
  if (/^(api|www|en|us|jobs|career|careers|embed|board|boards|wday|cxs|v\d+)$/i.test(slug)) return false;
  return true;
}

async function safeFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'catabull-healthcheck/1.0' },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    try {
      return { ok: true, status: res.status, json: JSON.parse(text) };
    } catch {
      return { ok: true, status: res.status, json: null, text };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = launchChromiumWithRetry({ headless: true }).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

export async function disposeBrowser() {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch { /* already gone */ }
  browserPromise = null;
}

/**
 * Probe a single company by network capture. Returns a recovery proposal
 * or null.
 *
 * @param {{name: string, careers_url: string}} company
 * @returns {Promise<{provider, slug, jobs, patch} | null>}
 */
export async function probeWithNetworkCapture(company) {
  if (!company.careers_url) return null;
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();

  const seenUrls = new Set();
  page.on('request', (req) => seenUrls.add(req.url()));
  page.on('response', (res) => seenUrls.add(res.url()));

  try {
    await page.goto(company.careers_url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    // Best-effort networkidle — pages with persistent polling/websockets
    // won't reach it, but we'll have captured the initial wave of XHRs.
    try {
      await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS });
    } catch { /* ok, timeout is fine */ }

    // Also scan iframes — some careers pages embed Workday/SmartRecruiters
    // in an iframe whose src isn't necessarily fetched by the parent.
    try {
      const html = await page.content();
      const iframeSrcs = Array.from(html.matchAll(/<iframe[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)).map((m) => m[1]);
      for (const src of iframeSrcs) seenUrls.add(src);
    } catch { /* ignore */ }

    return await pickBestMatch(Array.from(seenUrls), company);
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }
}

function phenomSearchResultsUrl(probedUrl) {
  // Phenom careers pages typically expose their full listings at
  // `<origin>/<locale>/search-results` (e.g. careers.adobe.com/us/en/search-results).
  // Extract the locale prefix from the probed URL when present so we land
  // on the right localized board; otherwise fall back to bare /search-results.
  try {
    const u = new URL(probedUrl);
    const localeMatch = u.pathname.match(/^\/([a-z]{2}\/[a-z]{2})(?:\/|$)/i);
    const localePrefix = localeMatch ? `/${localeMatch[1]}` : '';
    return `${u.origin}${localePrefix}/search-results`;
  } catch {
    return null;
  }
}

async function pickBestMatch(urls, company) {
  const candidates = [];
  for (const url of urls) {
    for (const pat of ATS_PATTERNS) {
      const m = String(url).match(pat.re);
      if (!m) continue;
      const slug = m[1];
      if (!isUsableMatch(pat.provider, slug)) continue;
      candidates.push({ pattern: pat, match: m, slug });
    }
  }

  if (candidates.length === 0) return null;

  // Prefer non-Workday matches first since Workday URLs may include
  // marketing-site links that aren't the actual ATS. Then prefer more
  // specific (longer) matched URL paths.
  candidates.sort((a, b) => {
    if (a.pattern.provider !== b.pattern.provider) {
      if (a.pattern.provider === 'workday') return 1;
      if (b.pattern.provider === 'workday') return -1;
    }
    return b.match[0].length - a.match[0].length;
  });

  // Verify each candidate by hitting the API. First one with ≥1 job wins.
  const tried = new Set();
  for (const cand of candidates) {
    const key = `${cand.pattern.provider}::${cand.slug}`;
    if (tried.has(key)) continue;
    tried.add(key);
    let jobs = 0;
    try {
      // Phenom can't be API-verified (their endpoints reject direct calls).
      // We trust the network-traffic detection: if Phenom assets loaded on
      // the page, the page is Phenom-backed. Patch careers_url to the
      // search-results sub-page so the existing webfetch provider can scrape
      // job links the next time the scanner runs.
      if (cand.pattern.provider === 'phenom') {
        const searchUrl = phenomSearchResultsUrl(company.careers_url);
        if (!searchUrl) continue;
        return {
          provider: 'phenom',
          slug: cand.slug || 'phenom',
          jobs: 1, // unverified; webfetch will count real jobs on next scan
          patch: { careers_url: searchUrl },
        };
      }
      if (cand.pattern.extract) {
        const ext = cand.pattern.extract(cand.match);
        jobs = await cand.pattern.verify(ext.tenant, ext.shard, ext.site);
        if (jobs > 0) {
          return {
            provider: cand.pattern.provider,
            slug: cand.slug,
            jobs,
            patch: { careers_url: cand.pattern.careersUrl(ext.tenant, ext.shard, ext.site) },
          };
        }
      } else {
        jobs = await cand.pattern.verify(cand.slug);
        if (jobs > 0) {
          const patch = { careers_url: cand.pattern.careersUrl(cand.slug) };
          if (cand.pattern.api) patch.api = cand.pattern.api(cand.slug);
          return { provider: cand.pattern.provider, slug: cand.slug, jobs, patch };
        }
      }
    } catch { /* try next */ }
  }

  return null;
}
