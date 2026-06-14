import { fetchJson, finalizeJob, matchesQueryText } from './_shared.mjs';

export const himalayasProvider = {
  name: 'himalayas',
  description: 'Himalayas public jobs search API',
  async fetch(opts = {}) {
    const query = String(opts.query || '').trim();
    if (!query) {
      return { available: true, jobs: [], error: 'query is required' };
    }
    const limit = normalizeLimit(opts.limit, 25);
    const url = `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const payload = await fetchJson(url, opts);
    return { available: true, jobs: parseHimalayasJobs(payload?.jobs || []).slice(0, limit) };
  },
};

export function parseHimalayasJobs(records = [], { query = '' } = {}) {
  return records
    .map((record) => finalizeJob({
      url: record?.applicationLink || buildJobUrl(record),
      title: record?.title,
      company: record?.companyName,
      location: Array.isArray(record?.locationRestrictions) ? record.locationRestrictions.join(', ') : '',
      postedAt: record?.pubDate,
      searchSnippet: record?.excerpt || record?.description,
    }, 'market:himalayas'))
    .filter(Boolean)
    .filter((job) => matchesQueryText(job, query));
}

function buildJobUrl(record = {}) {
  if (record?.guid) return record.guid;
  if (record?.companySlug && record?.title) {
    const slug = String(record.title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (slug) return `https://himalayas.app/companies/${record.companySlug}/jobs/${slug}`;
  }
  return '';
}

function normalizeLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : fallback;
}

export default himalayasProvider;
