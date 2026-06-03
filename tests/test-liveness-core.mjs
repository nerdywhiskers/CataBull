#!/usr/bin/env node

import { classifyLiveness } from '../lib/liveness-core.mjs';

const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
let failed = 0;
let total = 0;

function assert(cond, msg) {
  total++;
  if (cond) {
    passed++;
    if (VERBOSE) console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

console.log('\nLiveness core');

const linkedInClosed = classifyLiveness({
  status: 200,
  finalUrl: 'https://www.linkedin.com/jobs/view/123',
  bodyText: 'Short shell',
  titleText: 'LinkedIn Job Posting: No longer accepting applications',
  applyControls: ['Apply'],
});
assert(linkedInClosed.result === 'expired', 'LinkedIn closed title beats visible apply control');

const linkedInNoLongerOpen = classifyLiveness({
  status: 200,
  finalUrl: 'https://www.linkedin.com/jobs/view/456',
  bodyText: 'The job you are looking for is no longer open.',
  titleText: 'LinkedIn job search',
  applyControls: [],
});
assert(linkedInNoLongerOpen.result === 'expired', 'explicit no longer open text expires posting');

const linkedInOpenVariantWithApply = classifyLiveness({
  status: 200,
  finalUrl: 'https://www.linkedin.com/jobs/view/789',
  bodyText: 'This role is no longer accepting candidates at this time.',
  titleText: 'Product Designer role',
  applyControls: ['Apply now'],
});
assert(linkedInOpenVariantWithApply.result === 'expired', 'closed-text variants beat visible apply control');

const filledRole = classifyLiveness({
  status: 200,
  finalUrl: 'https://company.com/jobs/filled-role',
  bodyText: 'Thank you for your interest. This position has been filled.',
  titleText: 'Careers',
  applyControls: ['Apply now'],
});
assert(filledRole.result === 'expired', 'filled-position text expires posting even if stale apply UI remains');

const expiredPosting = classifyLiveness({
  status: 200,
  finalUrl: 'https://company.com/jobs/expired-role',
  bodyText: 'This job posting has expired and is no longer available.',
  titleText: 'Job Posting',
  applyControls: [],
});
assert(expiredPosting.result === 'expired', 'expired posting text expires posting');

const activeWithApply = classifyLiveness({
  status: 200,
  finalUrl: 'https://company.com/jobs/123',
  bodyText: 'Full job description '.repeat(30),
  titleText: 'Senior Engineer',
  applyControls: ['Apply now'],
});
assert(activeWithApply.result === 'active', 'visible apply control marks posting active');

const listingRedirect = classifyLiveness({
  status: 200,
  finalUrl: 'https://company.com/jobs',
  bodyText: 'Search for jobs page is loaded',
  titleText: 'Jobs',
  applyControls: [],
});
assert(listingRedirect.result === 'uncertain', 'listing/search pages stay uncertain unless clearly gone or closed');

const linkedInLoginWall = classifyLiveness({
  status: 200,
  finalUrl: 'https://www.linkedin.com/uas/login?session_redirect=%2Fjobs%2Fview%2F4402327200%2F&skipRedirect=true',
  bodyText: 'Sign in Continue with Google Sign in with Apple Keep me logged in Forgot password?',
  titleText: 'LinkedIn Login, Sign in | LinkedIn',
  applyControls: [],
});
assert(linkedInLoginWall.result === 'uncertain', 'LinkedIn login wall stays uncertain, not expired');

const botChallenge403 = classifyLiveness({
  status: 403,
  finalUrl: 'https://wellfound.com/jobs/1595869-art-director',
  bodyText: 'DataDome CAPTCHA Submit feedback ID: 99004772-5919-42f2-aec2-e5f292d5b858',
  titleText: 'wellfound.com',
  applyControls: [],
});
assert(botChallenge403.result === 'uncertain', 'bot challenge wall stays uncertain, not expired');

const botChallenge403ViaIframe = classifyLiveness({
  status: 403,
  finalUrl: 'https://wellfound.com/jobs/1595869-art-director',
  bodyText: '',
  titleText: 'wellfound.com',
  extraText: 'iframe title: DataDome CAPTCHA iframe src: https://geo.captcha-delivery.com/captcha/...',
  applyControls: [],
});
assert(botChallenge403ViaIframe.result === 'uncertain', 'iframe captcha wall stays uncertain, not expired');

const cloudflareChallenge403 = classifyLiveness({
  status: 403,
  finalUrl: 'https://www.theladders.com/job/senior-concept-artist-characters-2xko-riotgames-los-angeles-ca_77041588',
  bodyText: 'Performing security verification This website uses a security service to protect against malicious bots. Cloudflare Privacy Help',
  titleText: 'Just a moment...',
  applyControls: [],
});
assert(cloudflareChallenge403.result === 'uncertain', 'security verification wall stays uncertain, not expired');

const activeWithApplyAndLoginNav = classifyLiveness({
  status: 200,
  finalUrl: 'https://remoteok.com/remote-jobs/example',
  bodyText: 'Browse remote jobs Log in Sign up Full job description '.repeat(10),
  titleText: 'RemoteOK job',
  applyControls: ['Apply now'],
});
assert(activeWithApplyAndLoginNav.result === 'active', 'visible apply control beats generic login nav text on real job pages');

const uncertainServerError = classifyLiveness({
  status: 503,
  finalUrl: 'https://company.com/jobs/123',
  bodyText: '',
  titleText: '',
  applyControls: [],
});
assert(uncertainServerError.result === 'uncertain', '5xx remains uncertain');

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exitCode = 1;
