import { fetchJson, finalizeJob, matchesQueryText } from './_shared.mjs';

export const remoteOkProvider = {
  name: 'remoteok',
  description: 'Remote OK public jobs API',
  async fetch(opts = {}) {
    const limit = normalizeLimit(opts.limit, 25);
    const payload = await fetchJson('https://remoteok.com/api', opts);
    return { available: true, jobs: parseRemoteOkJobs(payload, { query: opts.query }).slice(0, limit) };
  },
};

export function parseRemoteOkJobs(records = [], { query = '' } = {}) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => record && (record.position || record.url || record.apply_url))
    .map((record) => finalizeJob({
      url: record?.apply_url || record?.url,
      title: record?.position,
      company: record?.company,
      location: record?.location,
      postedAt: record?.date || record?.epoch,
      searchSnippet: Array.isArray(record?.tags) && record.tags.length
        ? `${record.description || ''} ${record.tags.join(', ')}`
        : record?.description,
    }, 'market:remoteok'))
    .filter(Boolean)
    .filter((job) => matchesQueryText(job, query));
}

function normalizeLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : fallback;
}

export default remoteOkProvider;
