/**
 * scan/providers/workable.mjs — Workable careers pages
 *
 * Workable does not expose a stable unauthenticated JSON endpoint across
 * accounts, but its rendered careers pages consistently link individual
 * postings at:
 *   https://apply.workable.com/{account}/j/{jobId}/
 */

const WORKABLE_RE = /^https?:\/\/apply\.workable\.com\/([^/?#]+)/i;
const JOB_LINK_SELECTOR = 'a[href*="/j/"]';
const FETCH_TIMEOUT_MS = 10000;

function workableSlug(company) {
  const url = company.careers_url || '';
  const match = String(url).match(WORKABLE_RE);
  return match ? match[1] : null;
}

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function joinLocation(parts) {
  const seen = new Set();
  return parts
    .map(normalizeText)
    .filter(Boolean)
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(' | ');
}

function absoluteUrl(baseUrl, rawUrl) {
  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return rawUrl || '';
  }
}

function jobsMarkdownUrl(slug) {
  return `https://apply.workable.com/${slug}/jobs.md`;
}

function splitMarkdownRow(row) {
  const cells = [];
  let current = '';
  let escaped = false;
  const s = String(row || '').trim().replace(/^\|/, '').replace(/\|$/, '');
  for (const ch of s) {
    if (escaped) {
      current += ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function markdownLinkUrl(value) {
  const match = String(value || '').match(/\[[^\]]+\]\(([^)]+)\)/);
  return match ? match[1] : String(value || '').trim();
}

function workableJobUrl(slug, detailsUrl) {
  const match = String(detailsUrl || '').match(/\/jobs\/view\/([^/.?#]+)\.md/i);
  if (match) return `https://apply.workable.com/${slug}/j/${match[1]}/`;
  return absoluteUrl(`https://apply.workable.com/${slug}/`, detailsUrl);
}

function parseMarkdownJobs(markdown, companyName, slug) {
  const rows = String(markdown || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'));

  const jobs = [];
  for (const row of rows.slice(2)) {
    const cells = splitMarkdownRow(row);
    if (cells.length < 7) continue;
    const [title, department, location, type, , posted, details] = cells;
    const url = workableJobUrl(slug, markdownLinkUrl(details));
    const cleanTitle = normalizeTitle(title);
    if (!cleanTitle || !url) continue;
    jobs.push({
      title: cleanTitle,
      url,
      company: companyName,
      location: joinLocation([location, type, department]),
      postedAt: /^\d{4}-\d{2}-\d{2}$/.test(posted) ? posted : '',
    });
  }
  return jobs;
}

async function fetchJobsMarkdown(slug) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(jobsMarkdownUrl(slug), {
      headers: { Accept: 'text/markdown, text/plain;q=0.9, */*;q=0.8' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRenderedJobs(company) {
  const { launchChromiumWithRetry } = await import('../../lib/playwright-launch.mjs');
  const browser = await launchChromiumWithRetry({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(company.careers_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('[data-ui="job"], a[href*="/j/"]', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    const jobs = await page.locator(JOB_LINK_SELECTOR).evaluateAll((elements, payload) => {
      return elements.map((element) => {
        const item = element.closest('[data-ui="job"]');
        return {
          title: (
            item?.querySelector('[data-ui="job-title"]')?.textContent ||
            element.textContent ||
            ''
          ).replace(/\s+/g, ' ').trim(),
          url: element.getAttribute('href') || '',
          company: payload.companyName,
          location: [
            item?.querySelector('[data-ui="job-workplace"]')?.textContent || '',
            item?.querySelector('[data-ui="job-location"]')?.textContent || '',
          ].map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | '),
          postedAt: '',
        };
      });
    }, { companyName: company.name });

    const seen = new Set();
    const out = [];
    for (const job of jobs) {
      const url = absoluteUrl(company.careers_url, job.url);
      const title = normalizeTitle(job.title);
      if (!url || !title) continue;
      const key = `${url}::${title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...job, url, title });
    }
    return out;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export default {
  name: 'workable',
  description: 'Workable all-openings markdown feed with rendered-page fallback',
  needsPlaywright: false,

  match(company) {
    return Boolean(workableSlug(company));
  },

  matchUrl(href) {
    const m = String(href || '').match(WORKABLE_RE);
    return m ? { slug: m[1] } : null;
  },

  buildCareersUrl(slug) {
    return `https://apply.workable.com/${slug}/`;
  },

  async fetch(company) {
    const slug = workableSlug(company);
    if (!slug) throw new Error('Not a Workable URL');

    try {
      const markdown = await fetchJobsMarkdown(slug);
      const jobs = parseMarkdownJobs(markdown, company.name, slug);
      if (jobs.length > 0) return { jobs };
    } catch {
      // Some older Workable pages may not expose jobs.md. Fall through to
      // rendered extraction so the provider remains useful for those accounts.
    }

    return { jobs: await fetchRenderedJobs(company) };
  },

  _internal: {
    workableSlug,
    jobsMarkdownUrl,
    splitMarkdownRow,
    markdownLinkUrl,
    workableJobUrl,
    parseMarkdownJobs,
    joinLocation,
    WORKABLE_RE,
  },
};
