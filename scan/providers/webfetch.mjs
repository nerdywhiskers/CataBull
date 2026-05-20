import { sniffAtsLinks } from './sniff.mjs';

// Signatures of WAF / bot-mitigation interstitials. When the page renders
// successfully but its content is a generic block page, we report it as
// such instead of letting the zero-job result be classified as
// `unknown_ats` — that misclassification leads users to try fixing the
// URL, when the underlying problem is that the host won't serve any URL
// to a headless browser. Each entry: a regex + the human-readable WAF
// vendor name to surface in the error message.
const BOT_BLOCK_SIGNATURES = [
  { vendor: 'Akamai',     re: /errors\.edgesuite\.net|edge\.errors|reference\s*#\d+\.[a-f0-9]+\.\d+\.[a-f0-9]+/i },
  { vendor: 'Cloudflare', re: /attention required|cloudflare|cf-(?:browser-verification|chl-bypass)|just a moment|please enable cookies and reload/i },
  { vendor: 'AWS WAF',    re: /aws[- ]?waf|request blocked|<title>403 forbidden<\/title>|x-amzn-requestid/i },
  { vendor: 'Imperva',    re: /incapsula|imperva|_inc(?:apsula|ap)/i },
  { vendor: 'PerimeterX', re: /perimeterx|px-captcha/i },
  { vendor: 'DataDome',   re: /datadome|dd-captcha/i },
  { vendor: 'generic',    re: /<title>\s*access denied\s*<\/title>|you don't have permission to access|verify you are human|press and hold to confirm/i },
];

function detectBotBlock(html) {
  if (!html || html.length < 50) return null;
  // Only scan the first 4KB — block pages are tiny by design; scanning a
  // full job listing would burn CPU and risk false positives in honest
  // postings that mention "captcha" in a description.
  const head = html.slice(0, 4096);
  for (const sig of BOT_BLOCK_SIGNATURES) {
    if (sig.re.test(head)) return { vendor: sig.vendor };
  }
  return null;
}

const DEFAULT_LINK_SELECTOR = [
  'a[href*="/job/"]',
  'a[href*="/jobs/"]',
  'a[href*="/careers/"]',
  'a[href*="greenhouse.io"]',
  'a[href*="ashbyhq.com"]',
  'a[href*="lever.co"]',
  'a[href*="workable.com"]',
  'a[href*="smartrecruiters.com"]',
  'a[href*="/j/"]',
].join(', ');

// Single chromium instance shared across all webfetch fetches in this process.
// scan.mjs runs up to 10 tasks in parallel; without pooling, that means up to
// 10 simultaneous chrome.exe spawns. On Windows that reliably trips Defender's
// real-time scan and surfaces as EPERM on the first launches. One browser +
// per-company newPage() avoids the spawn storm entirely. The retry inside
// launchChromiumWithRetry handles cold-start AV locks on top of that.
let browserPromise = null;
let launchChromiumWithRetry = null;

async function ensureLaunch() {
  if (!launchChromiumWithRetry) {
    const mod = await import('../../lib/playwright-launch.mjs');
    launchChromiumWithRetry = mod.launchChromiumWithRetry;
  }
  return launchChromiumWithRetry;
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const launch = await ensureLaunch();
      return launch({ headless: true });
    })().catch(err => {
      // Reset so the next call can try again from scratch.
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

export async function disposeBrowser() {
  if (!browserPromise) return;
  const promise = browserPromise;
  browserPromise = null;
  try {
    const browser = await promise;
    await browser.close();
  } catch { /* already gone */ }
}

function absoluteUrl(baseUrl, rawUrl) {
  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return rawUrl || '';
  }
}

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export default {
  name: 'webfetch',
  description: 'Playwright fallback that scrapes job links from the careers page',
  needsPlaywright: true,
  match(company) {
    return Boolean(company.careers_url);
  },
  async fetch(company) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    const linkSelector = company.provider_config?.selectors?.jobLink || DEFAULT_LINK_SELECTOR;

    try {
      await page.goto(company.careers_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1500);

      const jobs = await page.locator(linkSelector).evaluateAll((elements, payload) => {
        const entries = [];
        for (const element of elements) {
          const href = element.getAttribute('href') || '';
          const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
          if (!href || !text || text.length < 3) continue;
          entries.push({
            title: text,
            url: href,
            company: payload.companyName,
            location: '',
            postedAt: '',
          });
        }
        return entries;
      }, { companyName: company.name });

      const deduped = [];
      const seen = new Set();
      for (const job of jobs) {
        const url = absoluteUrl(company.careers_url, job.url);
        const title = normalizeTitle(job.title);
        if (!url || !title) continue;
        const key = `${url}::${title.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push({ ...job, url, title });
      }

      // W5 — when our selector-based extraction returned nothing, the page
      // is most likely either:
      //   (a) a marketing landing page that links out to a real ATS — the
      //       sniffer surfaces candidates so scan.mjs can auto-retry and
      //       the Health tab can suggest the right URL.
      //   (b) a WAF interstitial (Akamai "Access Denied", Cloudflare
      //       challenge, etc.) — no URL fix will help, the host blocks
      //       headless browsers entirely. Report botBlocked so the health
      //       classifier picks it up instead of misreading as unknown_ats.
      if (deduped.length === 0) {
        try {
          const html = await page.content();
          const botBlock = detectBotBlock(html);
          if (botBlock) {
            return { jobs: [], meta: { botBlocked: botBlock } };
          }
          const sniff = sniffAtsLinks(html, company.careers_url, { companyName: company.name });
          if (sniff.matches.length > 0) {
            return { jobs: [], meta: { sniff } };
          }
        } catch {
          // Detection failure is non-fatal — original empty-result behavior
          // (return zero jobs, health classifier marks unknown_ats) is the
          // safe fallback.
        }
      }

      return { jobs: deduped };
    } finally {
      await page.close().catch(() => {});
    }
  },
};
