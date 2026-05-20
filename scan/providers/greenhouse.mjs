// Hosts that resolve to a Greenhouse-hosted board. Includes the legacy
// boards.greenhouse.io as well as job-boards.greenhouse.io and the EU
// shard. Used by the sniffer to detect outbound ATS links from a marketing
// careers page.
const GREENHOUSE_HOST_RE = /(?:boards|job-boards(?:\.eu)?)\.greenhouse\.io\/([^/?#]+)/i;

function greenhouseSlug(company) {
  if (company.api) {
    const match = String(company.api).match(/boards\/([^/?#]+)\/jobs/i);
    if (match) return match[1];
  }

  const url = company.careers_url || '';
  const match = url.match(GREENHOUSE_HOST_RE);
  return match ? match[1] : null;
}

function matchUrl(href) {
  const m = String(href || '').match(GREENHOUSE_HOST_RE);
  return m ? { slug: m[1] } : null;
}

export default {
  name: 'greenhouse',
  description: 'Structured Greenhouse board API',
  needsPlaywright: false,
  match(company) {
    return Boolean(greenhouseSlug(company));
  },
  matchUrl,
  buildUrl(company) {
    if (company.api) return company.api;
    const slug = greenhouseSlug(company);
    if (!slug) throw new Error('Greenhouse board slug not found');
    return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  },
  buildCareersUrl(slug) {
    return `https://job-boards.greenhouse.io/${slug}`;
  },
  parse(json, companyName) {
    const jobs = json.jobs || [];
    return jobs.map((job) => ({
      title: job.title || '',
      url: job.absolute_url || '',
      company: companyName,
      location: job.location?.name || '',
      postedAt: (job.updated_at || job.first_published_at || '').slice(0, 10),
    }));
  },
};
