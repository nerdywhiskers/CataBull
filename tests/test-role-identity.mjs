#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  canonicalJobUrlKey,
  sameJobPosting,
} from '../lib/role-identity.mjs';

assert.equal(
  canonicalJobUrlKey('https://www.linkedin.com/comm/jobs/view/4442838957/?utm_source=feed'),
  canonicalJobUrlKey('https://linkedin.com/jobs/view/4442838957/'),
  'LinkedIn public and comm URLs share one posting identity',
);

assert.equal(
  canonicalJobUrlKey('https://boards.greenhouse.io/acme/jobs/123456?gh_src=abc'),
  canonicalJobUrlKey('https://job-boards.greenhouse.io/acme/jobs/123456'),
  'Greenhouse host and tracking variants share one posting identity',
);

assert.equal(
  canonicalJobUrlKey('https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=123456'),
  canonicalJobUrlKey('https://job-boards.greenhouse.io/acme/jobs/123456'),
  'Greenhouse query-based application URLs preserve the posting id',
);

assert.equal(sameJobPosting(
  { url: 'https://provider-a.example/jobs/abc', company: 'Acme, Inc.', role: 'Head of AI Workflows / Lead Architect' },
  { url: 'https://provider-b.example/roles/xyz', company: 'Acme', role: 'Head of AI Workflows' },
), true, 'cross-provider mirrors tolerate a modest title suffix');

assert.equal(sameJobPosting(
  { url: 'https://provider-a.example/jobs/abc', company: 'Acme', role: 'AI Artist' },
  { url: 'https://provider-b.example/roles/xyz', company: 'Acme', role: 'AI Technical Artist' },
), false, 'cross-provider matching does not collapse materially different short titles');

assert.equal(sameJobPosting(
  { url: 'https://provider-a.example/jobs/abc', company: 'Acme', role: 'Senior Art Director' },
  { url: 'https://provider-a.example/jobs/def', company: 'Acme', role: 'Art Director' },
), false, 'similar roles on one provider remain distinct without a shared posting URL');

console.log('role identity tests passed');