import { fetchJson, finalizeJob, matchesQueryText } from './_shared.mjs';

export const remotiveProvider = {
  name: 'remotive',
  description: 'Remotive public remote jobs API',
  async fetch(opts = {}) {
    const limit = normalizeLimit(opts.limit, 25);
    const payload = await fetchJson(`https://remotive.com/api/remote-jobs?limit=${limit}`, opts);
    const jobs = parseRemotiveJobs(payload?.jobs || [], { query: opts.query }).slice(0, limit);
    return { available: true, jobs };
  },
};

export function parseRemotiveJobs(records = [], { query = '' } = {}) {
  return records
    .map((record) => finalizeJob({
      url: record?.url,
      title: record?.title,
      company: record?.company_name,
      location: record?.candidate_required_location,
      postedAt: record?.publication_date,
      searchSnippet: record?.description,
    }, 'market:remotive'))
    .filter(Boolean)
    .filter((job) => matchesQueryText(job, query));
}

function normalizeLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : fallback;
}

export default remotiveProvider;
