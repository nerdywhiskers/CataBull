#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function assert(condition, msg) {
  if (!condition) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ ${msg}`);
  }
}

const { extractJobMetadataFromHtml, extractJobMetadataFromSnapshot } = await import(pathToFileURL(join(ROOT, 'dashboard-web', 'lib', 'job-url-metadata.mjs')).href);

const jsonLdHtml = `
  <html><head>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "JobPosting",
        "title": "Senior Product Designer",
        "hiringOrganization": { "name": "Figma" },
        "jobLocation": {
          "@type": "Place",
          "address": {
            "@type": "PostalAddress",
            "addressLocality": "San Francisco",
            "addressRegion": "CA"
          }
        }
      }
    </script>
  </head><body></body></html>
`;
const jsonLdMeta = extractJobMetadataFromHtml(jsonLdHtml, 'https://boards.greenhouse.io/figma/jobs/123');
assert(jsonLdMeta.role === 'Senior Product Designer', 'json-ld title parsed');
assert(jsonLdMeta.company === 'Figma', 'json-ld company parsed');
assert(jsonLdMeta.location === 'San Francisco, CA', 'json-ld location parsed');

const linkedInHtml = `
  <html><head>
    <title>Applied AI Engineer - Anthropic | LinkedIn</title>
    <meta property="og:title" content="Applied AI Engineer - Anthropic | LinkedIn">
    <meta property="og:description" content="Anthropic · San Francisco, CA (Hybrid)">
  </head><body>
    <h1>Applied AI Engineer</h1>
  </body></html>
`;
const linkedInMeta = extractJobMetadataFromHtml(linkedInHtml, 'https://www.linkedin.com/jobs/view/987654321/');
assert(linkedInMeta.role === 'Applied AI Engineer', 'linkedin title parsed');
assert(linkedInMeta.company === 'Anthropic', 'linkedin company parsed');
assert(linkedInMeta.location === 'San Francisco, CA (Hybrid)', 'linkedin location parsed');

const reversedMetaAttrHtml = `
  <html><head>
    <meta content="Staff Software Engineer - Vercel | LinkedIn" property="og:title">
    <meta content="Vercel · Remote (US)" property="og:description">
    <title>Ignore me</title>
  </head><body></body></html>
`;
const reversedMetaAttr = extractJobMetadataFromHtml(reversedMetaAttrHtml, 'https://www.linkedin.com/jobs/view/123456789/');
assert(reversedMetaAttr.role === 'Staff Software Engineer', 'meta parser handles content before property for role');
assert(reversedMetaAttr.company === 'Vercel', 'meta parser handles content before property for company');
assert(reversedMetaAttr.location === 'Remote (US)', 'meta parser handles content before property for location');

const linkedInSearchHtml = `
  <html><head>
    <title>More than 1,000 jobs for Product Designer in United States</title>
    <meta property="og:title" content="More than 1,000 jobs for Product Designer in United States">
  </head></html>
`;
const linkedInSearchMeta = extractJobMetadataFromHtml(linkedInSearchHtml, 'https://www.linkedin.com/jobs/view/12345/');
assert(!linkedInSearchMeta.role, 'linkedin search title does not become fake role');
assert(!linkedInSearchMeta.company, 'linkedin search title does not become fake company');

const snapshotMeta = extractJobMetadataFromSnapshot({
  title: 'Jobs',
  h1: '',
  meta: {},
  jsonLd: [],
  roleCandidates: [''],
  companyCandidates: [''],
  locationCandidates: [''],
  visibleText: 'Senior Staff Product Designer\nFigma · Remote (US)\nApply now',
}, 'https://www.linkedin.com/jobs/view/555/');
assert(snapshotMeta.role === 'Senior Staff Product Designer', 'snapshot visible text can recover role');
assert(snapshotMeta.company === 'Figma', 'snapshot visible text can recover company');
assert(snapshotMeta.location === 'Remote (US)', 'snapshot visible text can recover location');

const snapshotPreferredMeta = extractJobMetadataFromSnapshot({
  title: 'Ignored title',
  h1: 'Fallback role',
  meta: {},
  jsonLd: [{
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Platform Engineer',
    hiringOrganization: { name: 'Stripe' },
  }],
  roleCandidates: ['Role from selector'],
  companyCandidates: ['Company from selector'],
  locationCandidates: [],
  visibleText: '',
}, 'https://jobs.stripe.com/roles/1');
assert(snapshotPreferredMeta.role === 'Platform Engineer', 'snapshot prefers json-ld role when present');
assert(snapshotPreferredMeta.company === 'Stripe', 'snapshot prefers json-ld company when present');

if (process.exitCode) process.exit(process.exitCode);
