#!/usr/bin/env node

import process from 'process';
import { enrichJobUrl } from '../dashboard-web/lib/job-url-metadata.mjs';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node scripts/extract-job-url-metadata.mjs <url>');
  process.exit(1);
}

try {
  const metadata = await enrichJobUrl(url);
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
} catch (error) {
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exit(1);
}
