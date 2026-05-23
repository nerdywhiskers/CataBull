#!/usr/bin/env node

/**
 * scan-health.mjs — Pre-scan portal health check
 *
 * Probes every tracked company in portals.yml, classifies each as
 * healthy / empty / not_found / redirected / bot_blocked / unknown_ats /
 * network_error / no_provider, and writes a snapshot to
 * data/scan-health.json for the dashboard to consume.
 *
 * Pure HTTP + Playwright — no LLM tokens.
 *
 * Usage:
 *   node scan-health.mjs                    # check all enabled companies
 *   node scan-health.mjs --all              # also include disabled companies
 *   node scan-health.mjs --company Adobe    # check a single company
 *   node scan-health.mjs --json             # write data/scan-health.json (default)
 *   node scan-health.mjs --no-write         # dry run (no file output)
 *   node scan-health.mjs --quiet            # suppress per-company progress lines
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defaultWorkspace } from '../lib/workspace.mjs';
import yaml from 'js-yaml';
import { checkCompanies, suggestedAction } from '../scan/health.mjs';

// Data root = the user's workspace. CATABULL_WORKSPACE_ROOT (set by the CLI and
// the dashboard when it spawns scripts) wins; otherwise fall back to the package
// dir so a direct run from a git clone keeps working.
const ROOT = defaultWorkspace(resolve(dirname(fileURLToPath(import.meta.url)), '..')).root;
const PORTALS_PATH = join(ROOT, 'portals.yml');
const HEALTH_PATH = join(ROOT, 'data', 'scan-health.json');

mkdirSync(join(ROOT, 'data'), { recursive: true });

const STATUS_GLYPH = {
  healthy: '✓',
  empty: '·',
  not_found: '✗',
  redirected: '↪',
  bot_blocked: '🛇',
  unknown_ats: '?',
  network_error: '⚠',
  no_provider: '∅',
};

function color(code, str) {
  if (!process.stdout.isTTY) return str;
  return `\x1b[${code}m${str}\x1b[0m`;
}

function colorize(status, str) {
  switch (status) {
    case 'healthy': return color(32, str);  // green
    case 'empty': return color(90, str);    // gray
    case 'not_found':
    case 'bot_blocked':
    case 'no_provider': return color(31, str);  // red
    case 'redirected':
    case 'unknown_ats':
    case 'network_error': return color(33, str);  // yellow
    default: return str;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const includeDisabled = args.includes('--all');
  const noWrite = args.includes('--no-write');
  const quiet = args.includes('--quiet');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  if (!existsSync(PORTALS_PATH)) {
    console.error(`Error: portals.yml not found at ${PORTALS_PATH}.`);
    console.error('Complete onboarding (npm run dashboard) or copy templates/portals.example.yml.');
    process.exit(1);
  }

  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const all = config.tracked_companies || [];

  let companies = includeDisabled ? all : all.filter((c) => c.enabled !== false);
  if (filterCompany) {
    companies = companies.filter((c) => c.name.toLowerCase().includes(filterCompany));
  }

  if (companies.length === 0) {
    console.log('No companies to check (filter or all-disabled).');
    process.exit(0);
  }

  console.log(`Checking ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}...\n`);

  const result = await checkCompanies(companies, {
    onProgress: ({ done, total, latest }) => {
      if (quiet) return;
      const glyph = STATUS_GLYPH[latest.status] || '?';
      const line = `[${String(done).padStart(3)}/${total}] ${glyph} ${latest.name.padEnd(28)} ${latest.status.padEnd(15)} ${latest.error || latest.probedUrl || ''}`.trim();
      console.log(colorize(latest.status, line));
    },
  });

  // Sort companies in the output by status severity (problems first) so
  // the dashboard and CLI both lead with what needs attention.
  const severityOrder = ['not_found', 'bot_blocked', 'no_provider', 'redirected', 'unknown_ats', 'network_error', 'empty', 'healthy'];
  result.companies.sort((a, b) => severityOrder.indexOf(a.status) - severityOrder.indexOf(b.status));

  if (!noWrite) {
    writeFileSync(HEALTH_PATH, JSON.stringify(result, null, 2), 'utf-8');
  }

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`Health Check Summary`);
  console.log(`${'━'.repeat(50)}`);
  for (const status of severityOrder) {
    const count = result.summary[status] || 0;
    if (count === 0) continue;
    const glyph = STATUS_GLYPH[status];
    console.log(`  ${colorize(status, `${glyph} ${status.padEnd(15)}`)} ${count}`);
  }

  const problems = result.companies.filter((c) => !['healthy', 'empty'].includes(c.status));
  if (problems.length > 0) {
    console.log(`\nNeeds attention (${problems.length}):`);
    for (const c of problems) {
      console.log(`  ${colorize(c.status, STATUS_GLYPH[c.status])} ${c.name} (${c.status})`);
      console.log(`     ${c.error || c.probedUrl}`);
      console.log(`     → ${suggestedAction(c.status)}`);
    }
  }

  if (!noWrite) {
    console.log(`\nWritten to ${HEALTH_PATH}`);
  } else {
    console.log('\n(--no-write — no file output)');
  }

  // We deliberately exit 0 even with problems, since one bad portal
  // shouldn't block CI / cron usage. Strict checks should grep the JSON.
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exitCode = 1;
});
