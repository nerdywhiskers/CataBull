import { fetchJson, finalizeJob, matchesQueryText } from './_shared.mjs';

export const workingNomadsProvider = {
  name: 'workingnomads',
  description: 'Working Nomads public exposed jobs feed',
  async fetch(opts = {}) {
    const limit = normalizeLimit(opts.limit, 25);
    const payload = await fetchJson('https://www.workingnomads.com/api/exposed_jobs/', opts);
    return { available: true, jobs: parseWorkingNomadsJobs(payload, { query: opts.query }).slice(0, limit) };
  },
};

export function parseWorkingNomadsJobs(records = [], { query = '' } = {}) {
  return (Array.isArray(records) ? records : [])
    .map((record) => finalizeJob({
      url: record?.url,
      title: record?.title,
      company: record?.company_name,
      location: record?.location,
      postedAt: record?.pub_date,
      searchSnippet: record?.description,
    }, 'market:workingnomads'))
    .filter(Boolean)
    .filter((job) => matchesQueryText(job, query));
}

function normalizeLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : fallback;
}

export default workingNomadsProvider;
