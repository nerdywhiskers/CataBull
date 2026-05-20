#!/usr/bin/env node

/**
 * test-providers.mjs — Unit tests for new ATS providers (W3)
 *
 * Pure-logic tests against the URL parsers, posting parsers, and
 * provider matching for Workday / BambooHR / Teamtailor. Does not
 * make real HTTP calls.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition, msg) {
  total++;
  if (condition) {
    passed++;
    if (VERBOSE) console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

console.log('\nproviders (W3)');

// ── Workday ─────────────────────────────────────────────────────────

console.log('\n1. Workday provider');

const workday = (await import(pathToFileURL(join(ROOT, 'scan', 'providers', 'workday.mjs')).href)).default;
const { parseConfig: wdParse, buildJobsApiUrl, buildSiteBase, parsePosting: wdParsePosting } = workday._internal;

assert(workday.name === 'workday', 'name set to workday');
assert(workday.needsPlaywright === false, 'workday is not a Playwright provider');

assert(
  workday.match({ careers_url: 'https://adobe.wd5.myworkdayjobs.com/external_experienced' }),
  'matches Adobe Workday careers URL',
);
assert(
  workday.match({ careers_url: 'https://mastercard.wd1.myworkdayjobs.com/CorporateCareers' }),
  'matches Mastercard Workday URL with mixed-case site',
);
assert(
  !workday.match({ careers_url: 'https://job-boards.greenhouse.io/anthropic' }),
  'does NOT match Greenhouse URLs',
);
assert(
  !workday.match({ careers_url: 'https://www.adobe.com/careers' }),
  'does NOT match Adobe\'s public careers page (only Workday subdomain)',
);

const cfg = wdParse({ careers_url: 'https://adobe.wd5.myworkdayjobs.com/external_experienced/' });
assert(cfg && cfg.tenant === 'adobe', 'parses tenant from URL');
assert(cfg && cfg.shard === 'wd5', 'parses shard from URL');
assert(cfg && cfg.site === 'external_experienced', 'parses site from URL');

const cfg2 = wdParse({ careers_url: 'https://x.y.myworkdayjobs.com/wday/cxs/x/site_b/jobs' });
assert(cfg2 && cfg2.site === 'site_b', 'parses site even from raw API URL form');

const explicit = wdParse({
  careers_url: 'https://anything.example/careers',
  provider_config: { workday: { tenant: 'foo', shard: 'wd9', site: 'External' } },
});
assert(
  explicit && explicit.tenant === 'foo' && explicit.shard === 'wd9' && explicit.site === 'External',
  'explicit provider_config.workday overrides URL parsing',
);

const apiUrl = buildJobsApiUrl({ tenant: 'adobe', shard: 'wd5', site: 'external_experienced' });
assert(
  apiUrl === 'https://adobe.wd5.myworkdayjobs.com/wday/cxs/adobe/external_experienced/jobs',
  'builds correct CXS jobs URL',
);

const base = buildSiteBase({ tenant: 'adobe', shard: 'wd5', site: 'external_experienced' });
assert(
  base === 'https://adobe.wd5.myworkdayjobs.com/external_experienced',
  'builds correct site base URL',
);

const postingFull = wdParsePosting({
  title: 'Senior Designer',
  externalPath: '/job/Bay-Area/Senior-Designer_R142',
  locationsText: 'Bay Area, CA',
  postedOn: 'Posted Today',
}, base);
assert(postingFull.title === 'Senior Designer', 'parsePosting preserves title');
assert(
  postingFull.url === 'https://adobe.wd5.myworkdayjobs.com/external_experienced/job/Bay-Area/Senior-Designer_R142',
  'parsePosting builds full job URL',
);
assert(postingFull.location === 'Bay Area, CA', 'parsePosting passes location');
assert(/^\d{4}-\d{2}-\d{2}$/.test(postingFull.postedAt), 'Posted Today → today\'s ISO date');

const postingDays = wdParsePosting({
  title: 'X', externalPath: '/job/X', locationsText: '', postedOn: 'Posted 7 Days Ago',
}, base);
assert(/^\d{4}-\d{2}-\d{2}$/.test(postingDays.postedAt), 'Posted N Days Ago → ISO date');

const postingArray = wdParsePosting({
  title: 'Y', externalPath: '/job/Y', locationsText: ['SF', 'NYC'], postedOn: '',
}, base);
assert(postingArray.location === 'SF, NYC', 'array locations joined');

// ── BambooHR ────────────────────────────────────────────────────────

console.log('\n2. BambooHR provider');

const bamboohr = (await import(pathToFileURL(join(ROOT, 'scan', 'providers', 'bamboohr.mjs')).href)).default;
const { bambooSlug, parsePosting: bambooParse } = bamboohr._internal;

assert(bamboohr.name === 'bamboohr', 'name set to bamboohr');
assert(bamboohr.needsPlaywright === false, 'bamboohr is not a Playwright provider');

assert(
  bambooSlug({ careers_url: 'https://acme.bamboohr.com/careers/list' }) === 'acme',
  'extracts slug from careers/list URL',
);
assert(
  bambooSlug({ careers_url: 'https://foo.bamboohr.com/' }) === 'foo',
  'extracts slug from bare URL',
);
assert(
  bamboohr.match({ careers_url: 'https://x.bamboohr.com/careers/list' }),
  'matches a BambooHR URL',
);
assert(
  !bamboohr.match({ careers_url: 'https://x.bamboohr.io/careers' }),
  'does NOT match a different domain',
);

const goodPosting = bambooParse({
  id: 42,
  jobOpeningName: 'Marketing Lead',
  jobOpeningStatus: 'Open',
  locationCity: 'Remote',
  locationState: 'US',
  datePosted: '2026-04-15',
}, 'acme');
assert(goodPosting && goodPosting.title === 'Marketing Lead', 'parses open posting');
assert(goodPosting.url === 'https://acme.bamboohr.com/careers/42', 'builds posting URL');
assert(goodPosting.location === 'Remote, US', 'joins location parts');
assert(goodPosting.postedAt === '2026-04-15', 'preserves datePosted');

const closed = bambooParse({ id: 1, jobOpeningName: 'X', jobOpeningStatus: 'Closed' }, 'acme');
assert(closed === null, 'rejects closed postings');

const noTitle = bambooParse({ id: 1, jobOpeningStatus: 'Open' }, 'acme');
assert(noTitle === null, 'rejects postings without a title');

const noId = bambooParse({ jobOpeningName: 'X', jobOpeningStatus: 'Open' }, 'acme');
assert(noId === null, 'rejects postings without an id');

// ── Teamtailor ──────────────────────────────────────────────────────

console.log('\n3. Teamtailor provider');

const teamtailor = (await import(pathToFileURL(join(ROOT, 'scan', 'providers', 'teamtailor.mjs')).href)).default;
const { teamtailorSlug, parseItems, decodeXmlEntities } = teamtailor._internal;

assert(teamtailor.name === 'teamtailor', 'name set to teamtailor');
assert(teamtailor.needsPlaywright === false, 'teamtailor is not a Playwright provider');

assert(
  teamtailorSlug({ careers_url: 'https://acme.teamtailor.com/jobs.rss' }) === 'acme',
  'extracts slug from RSS URL',
);
assert(
  teamtailorSlug({ careers_url: 'https://acme.teamtailor.com/' }) === 'acme',
  'extracts slug from bare URL',
);
assert(
  teamtailor.match({ careers_url: 'https://acme.teamtailor.com/jobs' }),
  'matches a Teamtailor URL',
);

assert(
  decodeXmlEntities('Tom &amp; Jerry &#8482;') === 'Tom & Jerry ™',
  'decodes XML entities',
);

const sampleRss = `
<rss>
  <channel>
    <item>
      <title>Senior Designer</title>
      <link>https://acme.teamtailor.com/jobs/senior-designer</link>
      <pubDate>Wed, 15 Apr 2026 10:00:00 +0000</pubDate>
      <category>Design</category>
    </item>
    <item>
      <title><![CDATA[Engineer & Architect]]></title>
      <link>https://acme.teamtailor.com/jobs/eng-arch</link>
      <pubDate>Mon, 20 Apr 2026 12:00:00 +0000</pubDate>
      <category>Engineering</category>
    </item>
  </channel>
</rss>
`;
const items = parseItems(sampleRss);
assert(items.length === 2, 'parseItems returns 2 entries');
assert(items[0].title === 'Senior Designer', 'first item title');
assert(items[1].title === 'Engineer & Architect', 'CDATA title decoded correctly');
assert(items[0].link === 'https://acme.teamtailor.com/jobs/senior-designer', 'first item link');
assert(items[0].category === 'Design', 'category preserved');

// ── Provider registry order ─────────────────────────────────────────

console.log('\n4. SmartRecruiters provider');

const smartrecruiters = (await import(pathToFileURL(join(ROOT, 'scan', 'providers', 'smartrecruiters.mjs')).href)).default;
const { smartRecruitersSlug, buildApiUrl: srBuildApiUrl, parseLocation } = smartrecruiters._internal;

assert(smartrecruiters.name === 'smartrecruiters', 'name set to smartrecruiters');
assert(smartrecruiters.needsPlaywright === false, 'smartrecruiters is not a Playwright provider');
assert(
  smartRecruitersSlug({ careers_url: 'https://careers.smartrecruiters.com/SmartRecruiters' }) === 'SmartRecruiters',
  'extracts slug from careers.smartrecruiters.com URL',
);
assert(
  smartRecruitersSlug({ api: 'https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100' }) === 'acme',
  'extracts slug from API URL',
);
assert(
  srBuildApiUrl('acme') === 'https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100',
  'builds SmartRecruiters API URL',
);
assert(parseLocation({ fullLocation: 'Remote, US' }) === 'Remote, US', 'uses fullLocation when present');
assert(parseLocation({ city: 'Berlin', region: 'BE', country: 'de' }) === 'Berlin, BE, de', 'joins location fields');

const srJobs = smartrecruiters.parse({
  content: [
    {
      id: '123',
      name: 'Senior Product Designer',
      ref: 'https://jobs.smartrecruiters.com/acme/123',
      releasedDate: '2026-05-01T10:00:00.000Z',
      location: { fullLocation: 'Remote, US' },
    },
    { id: 'missing-title', ref: 'https://jobs.smartrecruiters.com/acme/missing-title' },
  ],
}, 'Acme', 'acme');
assert(srJobs.length === 1, 'parses and filters SmartRecruiters postings');
assert(srJobs[0].title === 'Senior Product Designer', 'SmartRecruiters title parsed');
assert(srJobs[0].url === 'https://jobs.smartrecruiters.com/acme/123', 'SmartRecruiters job URL built from public jobs host');
assert(srJobs[0].postedAt === '2026-05-01', 'SmartRecruiters date parsed');
assert(srJobs[0].location === 'Remote, US', 'SmartRecruiters location parsed');

console.log('\n5. Workable provider');

const workable = (await import(pathToFileURL(join(ROOT, 'scan', 'providers', 'workable.mjs')).href)).default;
const { workableSlug, jobsMarkdownUrl, workableJobUrl, parseMarkdownJobs, joinLocation } = workable._internal;

assert(workable.name === 'workable', 'name set to workable');
assert(workable.needsPlaywright === false, 'workable is HTTP-first with a Playwright fallback');
assert(
  workableSlug({ careers_url: 'https://apply.workable.com/huggingface/' }) === 'huggingface',
  'extracts slug from Workable careers URL',
);
assert(
  jobsMarkdownUrl('huggingface') === 'https://apply.workable.com/huggingface/jobs.md',
  'builds Workable jobs.md URL',
);
assert(
  workableJobUrl('huggingface', 'https://apply.workable.com/huggingface/jobs/view/F24E2E5058.md') === 'https://apply.workable.com/huggingface/j/F24E2E5058/',
  'converts Workable markdown detail URL to public job URL',
);
assert(
  joinLocation(['Remote', 'Remote', 'Product']) === 'Remote | Product',
  'dedupes Workable location parts',
);
assert(
  workable.match({ careers_url: 'https://apply.workable.com/huggingface/' }),
  'matches a Workable URL',
);
assert(
  !workable.match({ careers_url: 'https://www.workable.com/careers' }),
  'does NOT match the Workable marketing site',
);
assert(
  workable.matchUrl('https://apply.workable.com/huggingface/j/ABC123/')?.slug === 'huggingface',
  'matches Workable job links for sniffer recovery',
);
assert(
  workable.buildCareersUrl('acme') === 'https://apply.workable.com/acme/',
  'builds Workable careers URL',
);

const workableMarkdown = `
# Acme -- All Open Positions

| Title | Department | Location | Type | Salary | Posted | Details |
|-------|-----------|----------|------|--------|--------|---------|
| Senior Product Designer | Design | New York, United States (Remote) | Full-time | - | 2026-05-01 | [View](https://apply.workable.com/acme/jobs/view/ABC123.md) |
|  | Design | Remote | Full-time | - | 2026-05-02 | [View](https://apply.workable.com/acme/jobs/view/EMPTY.md) |
`;
const workableJobs = parseMarkdownJobs(workableMarkdown, 'Acme', 'acme');
assert(workableJobs.length === 1, 'parses Workable markdown jobs');
assert(workableJobs[0].title === 'Senior Product Designer', 'Workable markdown title parsed');
assert(workableJobs[0].url === 'https://apply.workable.com/acme/j/ABC123/', 'Workable markdown job URL parsed');
assert(workableJobs[0].location === 'New York, United States (Remote) | Full-time | Design', 'Workable markdown location parsed');
assert(workableJobs[0].postedAt === '2026-05-01', 'Workable markdown posted date parsed');

console.log('\n6. Provider registry');

const { resolveProvider, listProviders } = await import(
  pathToFileURL(join(ROOT, 'scan', 'providers', 'index.mjs')).href
);

const list = listProviders().map((p) => p.name);
assert(list.includes('workday'), 'registry includes workday');
assert(list.includes('bamboohr'), 'registry includes bamboohr');
assert(list.includes('teamtailor'), 'registry includes teamtailor');
assert(list.includes('smartrecruiters'), 'registry includes smartrecruiters');
assert(list.includes('workable'), 'registry includes workable');
assert(list[list.length - 1] === 'webfetch', 'webfetch stays last (universal fallback)');

const resolved = resolveProvider({ careers_url: 'https://adobe.wd5.myworkdayjobs.com/external' });
assert(resolved && resolved.name === 'workday', 'resolves a Workday URL to workday provider');

const resolvedBamboo = resolveProvider({ careers_url: 'https://acme.bamboohr.com/careers/list' });
assert(resolvedBamboo && resolvedBamboo.name === 'bamboohr', 'resolves BambooHR URL to bamboohr');

const resolvedTeamtailor = resolveProvider({ careers_url: 'https://acme.teamtailor.com/jobs' });
assert(resolvedTeamtailor && resolvedTeamtailor.name === 'teamtailor', 'resolves Teamtailor URL to teamtailor');

const resolvedSmartRecruiters = resolveProvider({ careers_url: 'https://careers.smartrecruiters.com/acme' });
assert(resolvedSmartRecruiters && resolvedSmartRecruiters.name === 'smartrecruiters', 'resolves SmartRecruiters URL to smartrecruiters');

const resolvedWorkable = resolveProvider({ careers_url: 'https://apply.workable.com/acme/' });
assert(resolvedWorkable && resolvedWorkable.name === 'workable', 'resolves Workable URL to workable');

const legacyWebsearchAts = resolveProvider({
  careers_url: 'https://apply.workable.com/acme/',
  scan_method: 'websearch',
});
assert(legacyWebsearchAts && legacyWebsearchAts.name === 'workable', 'legacy websearch scan_method still prefers known ATS URLs');

const legacyWebsearchCustom = resolveProvider({
  careers_url: 'https://example.com/careers',
  scan_method: 'websearch',
});
assert(legacyWebsearchCustom && legacyWebsearchCustom.name === 'webfetch', 'legacy websearch scan_method falls back to webfetch for custom URLs');

const explicitWebfetch = resolveProvider({
  careers_url: 'https://apply.workable.com/acme/',
  scan_method: 'webfetch',
});
assert(explicitWebfetch && explicitWebfetch.name === 'webfetch', 'explicit webfetch scan_method is still honored');

// Webfetch should still be the fallback for unrecognized URLs.
const fallback = resolveProvider({ careers_url: 'https://example.com/careers' });
assert(fallback && fallback.name === 'webfetch', 'unrecognized URL still falls back to webfetch');

// Greenhouse / Ashby / Lever still resolve correctly (regression check).
const gh = resolveProvider({ careers_url: 'https://job-boards.greenhouse.io/anthropic' });
assert(gh && gh.name === 'greenhouse', 'Greenhouse still resolves');

// ── DONE ────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
