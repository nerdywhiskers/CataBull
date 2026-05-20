const LEVER_HOST_RE = /jobs\.lever\.co\/([^/?#]+)/i;

function leverSlug(company) {
  const url = company.careers_url || '';
  const match = url.match(LEVER_HOST_RE);
  return match ? match[1] : null;
}

function matchUrl(href) {
  const m = String(href || '').match(LEVER_HOST_RE);
  return m ? { slug: m[1] } : null;
}

export default {
  name: 'lever',
  description: 'Structured Lever postings API',
  needsPlaywright: false,
  match(company) {
    return Boolean(leverSlug(company));
  },
  matchUrl,
  buildUrl(company) {
    const slug = leverSlug(company);
    if (!slug) throw new Error('Lever board slug not found');
    return `https://api.lever.co/v0/postings/${slug}`;
  },
  buildCareersUrl(slug) {
    return `https://jobs.lever.co/${slug}`;
  },
  parse(json, companyName) {
    if (!Array.isArray(json)) return [];
    return json.map((job) => ({
      title: job.text || '',
      url: job.hostedUrl || '',
      company: companyName,
      location: job.categories?.location || '',
      postedAt: job.createdAt ? new Date(job.createdAt).toISOString().slice(0, 10) : '',
    }));
  },
};
