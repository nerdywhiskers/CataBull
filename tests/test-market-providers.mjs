#!/usr/bin/env node

import {
  listMarketProviders,
  getMarketProvider,
  normalizeMarketProviderName,
} from '../scan/market/providers/index.mjs';
import {
  cleanText,
  trimSnippet,
  normalizeDate,
  finalizeJob,
  parseRssItems,
} from '../scan/market/providers/_shared.mjs';
import { parseRemotiveJobs } from '../scan/market/providers/remotive.mjs';
import { parseHimalayasJobs } from '../scan/market/providers/himalayas.mjs';
import { parseWorkingNomadsJobs } from '../scan/market/providers/workingnomads.mjs';
import { parseRemoteOkJobs } from '../scan/market/providers/remoteok.mjs';
import { parseWeWorkRemotelyRss, splitCompanyAndTitle } from '../scan/market/providers/weworkremotely.mjs';

let passed = 0;
let failed = 0;
let total = 0;

function assert(cond, msg) {
  total++;
  if (cond) passed++;
  else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

console.log('\nmarket providers');

const providers = listMarketProviders();
assert(providers.length === 5, 'registers five market providers');
assert(getMarketProvider('remoteok')?.name === 'remoteok', 'registry lookup works');
assert(getMarketProvider('remote-ok')?.name === 'remoteok', 'registry alias lookup works');
assert(getMarketProvider('working_nomads')?.name === 'workingnomads', 'working nomads alias resolves');
assert(normalizeMarketProviderName('We Work Remotely') === 'weworkremotely', 'provider name normalization strips spaces');

assert(cleanText('<p>Hello&nbsp;<strong>world</strong></p>') === 'Hello world', 'cleanText strips html and decodes entities');
assert(trimSnippet('a'.repeat(400), 20).length === 20, 'trimSnippet caps length');
assert(normalizeDate('2026-06-12T11:32:31-04:00') === '2026-06-12', 'normalizeDate parses ISO timestamps');
assert(normalizeDate(1781320167) === '2026-06-13', 'normalizeDate parses epoch seconds');
assert(finalizeJob({ url: 'https://x.test', title: 'Role', company: '' }, 'market:test').company === 'Unknown', 'finalizeJob defaults missing company');
assert(finalizeJob({ url: '', title: 'Role' }, 'market:test') === null, 'finalizeJob drops empty url');

const remotiveJobs = parseRemotiveJobs([
  {
    url: 'https://remotive.com/job/1',
    title: 'Senior AI Engineer',
    company_name: 'Acme',
    candidate_required_location: 'Worldwide',
    publication_date: '2026-06-11T20:31:09',
    description: '<p>Build AI systems</p>',
  },
  {
    url: 'https://remotive.com/job/2',
    title: '',
    company_name: 'Bad',
  },
], { query: 'AI Engineer' });
assert(remotiveJobs.length === 1, 'Remotive parser filters invalid rows');
assert(remotiveJobs[0].source === 'market:remotive', 'Remotive parser sets source');
assert(remotiveJobs[0].postedAt === '2026-06-11', 'Remotive parser normalizes date');

const himalayasJobs = parseHimalayasJobs([
  {
    title: 'Staff ML Engineer',
    companyName: '',
    companySlug: 'acme',
    applicationLink: 'https://himalayas.app/jobs/1',
    locationRestrictions: ['United States', 'Canada'],
    pubDate: '2026-06-10T00:00:00.000Z',
    excerpt: 'Remote ML platform work',
  },
  {
    title: '',
    applicationLink: 'https://himalayas.app/jobs/2',
  },
]);
assert(himalayasJobs.length === 1, 'Himalayas parser drops rows missing title');
assert(himalayasJobs[0].company === 'Unknown', 'Himalayas parser defaults company');
assert(himalayasJobs[0].location === 'United States, Canada', 'Himalayas parser joins location restrictions');

const workingNomadsJobs = parseWorkingNomadsJobs([
  {
    url: 'https://workingnomads.com/job/1',
    title: 'Platform Engineer',
    company_name: 'Nomad Co',
    location: 'Europe',
    pub_date: '2026-06-12T11:32:31-04:00',
    description: '<p>Build <strong>platform</strong> systems</p>',
  },
]);
assert(workingNomadsJobs[0].searchSnippet === 'Build platform systems', 'Working Nomads parser cleans html snippet');

const remoteOkJobs = parseRemoteOkJobs([
  { legal: 'terms' },
  {
    apply_url: 'https://remoteok.com/job/1',
    position: 'AI Engineer',
    company: 'Remote Co',
    location: 'Remote, US',
    epoch: 1781320167,
    description: 'Interesting role',
    tags: ['ai', 'engineer'],
  },
  {
    apply_url: '',
    position: 'No URL',
  },
]);
assert(remoteOkJobs.length === 1, 'Remote OK parser skips metadata and invalid rows');
assert(remoteOkJobs[0].postedAt === '2026-06-13', 'Remote OK parser normalizes epoch date');

const rss = `<?xml version="1.0"?><rss><channel>
  <item>
    <title><![CDATA[Thrill Labs: DevOps Engineer]]></title>
    <link>https://weworkremotely.com/remote-jobs/1</link>
    <pubDate>Fri, 13 Jun 2026 10:00:00 GMT</pubDate>
    <region>Anywhere in the World</region>
    <description><![CDATA[<p>Run infrastructure &amp; CI</p>]]></description>
  </item>
</channel></rss>`;
const items = parseRssItems(rss);
assert(items.length === 1, 'RSS parser extracts item blocks');
assert(items[0].region === 'Anywhere in the World', 'RSS parser reads custom region tag');
const wwrJobs = parseWeWorkRemotelyRss(rss, { query: 'DevOps' });
assert(wwrJobs.length === 1, 'WWR parser emits one normalized job');
assert(wwrJobs[0].company === 'Thrill Labs', 'WWR parser splits company from title');
assert(wwrJobs[0].searchSnippet === 'Run infrastructure & CI', 'WWR parser cleans description');
const split = splitCompanyAndTitle('Acme: Staff Engineer');
assert(split.company === 'Acme' && split.title === 'Staff Engineer', 'splitCompanyAndTitle splits provider title pattern');

console.log(`\nPassed: ${passed}/${total}`);
if (failed > 0) process.exit(1);
