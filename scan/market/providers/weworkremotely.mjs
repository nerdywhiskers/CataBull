import { fetchText, finalizeJob, matchesQueryText, parseRssItems } from './_shared.mjs';

export const weWorkRemotelyProvider = {
  name: 'weworkremotely',
  description: 'We Work Remotely RSS feed',
  async fetch(opts = {}) {
    const limit = normalizeLimit(opts.limit, 25);
    const xml = await fetchText('https://weworkremotely.com/remote-jobs.rss', opts);
    return { available: true, jobs: parseWeWorkRemotelyRss(xml, { query: opts.query }).slice(0, limit) };
  },
};

export function parseWeWorkRemotelyRss(xml, { query = '' } = {}) {
  return parseRssItems(xml)
    .map((item) => {
      const { company, title } = splitCompanyAndTitle(item.title);
      return finalizeJob({
        url: item.link,
        title,
        company,
        location: item.region,
        postedAt: item.pubDate,
        searchSnippet: item.description,
      }, 'market:weworkremotely');
    })
    .filter(Boolean)
    .filter((job) => matchesQueryText(job, query));
}

export function splitCompanyAndTitle(value = '') {
  const text = String(value || '').trim();
  const match = text.match(/^(.*?):\s*(.+)$/);
  if (!match) return { company: 'Unknown', title: text };
  return { company: match[1].trim() || 'Unknown', title: match[2].trim() };
}

function normalizeLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : fallback;
}

export default weWorkRemotelyProvider;
