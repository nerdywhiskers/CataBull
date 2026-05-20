const ASHBY_HOST_RE = /jobs\.ashbyhq\.com\/([^/?#]+)/i;

function ashbySlug(company) {
  const url = company.careers_url || '';
  const match = url.match(ASHBY_HOST_RE);
  return match ? match[1] : null;
}

function matchUrl(href) {
  const m = String(href || '').match(ASHBY_HOST_RE);
  return m ? { slug: m[1] } : null;
}

export default {
  name: 'ashby',
  description: 'Structured Ashby job board API',
  needsPlaywright: false,
  match(company) {
    return Boolean(ashbySlug(company));
  },
  matchUrl,
  buildUrl(company) {
    const slug = ashbySlug(company);
    if (!slug) throw new Error('Ashby board slug not found');
    return `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  },
  buildCareersUrl(slug) {
    return `https://jobs.ashbyhq.com/${slug}`;
  },
  parse(json, companyName) {
    const jobs = json.jobs || [];
    return jobs.map((job) => ({
      title: job.title || '',
      url: job.jobUrl || '',
      company: companyName,
      location: job.location || '',
      postedAt: (job.publishedDate || job.updatedAt || '').slice(0, 10),
    }));
  },
};
