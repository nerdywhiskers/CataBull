#!/usr/bin/env node

import assert from 'assert/strict';
import { applyEnvUpdates, readEnvValue, readSettingsFromEnv } from '../dashboard-web/routes/settings.mjs';

console.log('\ndashboard settings');

const original = [
  '# keep comments',
  'BRAVE_SEARCH_API_KEY=old-key',
  'CATABULL_WEBSEARCH=scrape',
  'BRAVE_SEARCH_API_KEY=duplicate-key',
  '',
].join('\n');

const updated = applyEnvUpdates(original, {
  BRAVE_SEARCH_API_KEY: 'new-key',
  SERPER_API_KEY: 'serper-key',
  APOLLO_API_KEY: 'apollo-key',
  CATABULL_WEBSEARCH: 'brave',
  CATABULL_WEBSEARCH_ORDER: 'serper,brave,scrape',
  CATABULL_DEEP_SCAN_LIMIT: '50',
  CATABULL_DEEP_SCAN_MIN_RELEVANCE: '3.5',
  CATABULL_SCAN_FRESHNESS_DAYS: '30',
  CATABULL_TAILSCALE_MODE: 'detect',
  CATABULL_AUTO_UPDATE: 'true',
});

assert.equal(readEnvValue(updated, 'BRAVE_SEARCH_API_KEY'), 'new-key');
assert.equal(readEnvValue(updated, 'SERPER_API_KEY'), 'serper-key');
assert.equal(readEnvValue(updated, 'APOLLO_API_KEY'), 'apollo-key');
assert.equal(readEnvValue(updated, 'CATABULL_WEBSEARCH'), 'brave');
assert.equal(readEnvValue(updated, 'CATABULL_WEBSEARCH_ORDER'), 'serper,brave,scrape');
assert.equal(readEnvValue(updated, 'CATABULL_DEEP_SCAN_LIMIT'), '50');
assert.equal(readEnvValue(updated, 'CATABULL_DEEP_SCAN_MIN_RELEVANCE'), '3.5');
assert.equal(readEnvValue(updated, 'CATABULL_SCAN_FRESHNESS_DAYS'), '30');
assert.equal(readEnvValue(updated, 'CATABULL_TAILSCALE_MODE'), 'detect');
assert.equal(readEnvValue(updated, 'CATABULL_AUTO_UPDATE'), 'true');
assert.equal((updated.match(/BRAVE_SEARCH_API_KEY/g) || []).length, 1);
assert.match(updated, /# keep comments/);

const cleared = applyEnvUpdates(updated, {
  BRAVE_SEARCH_API_KEY: null,
  CATABULL_WEBSEARCH: null,
});

assert.equal(readEnvValue(cleared, 'BRAVE_SEARCH_API_KEY'), undefined);
assert.equal(readEnvValue(cleared, 'CATABULL_WEBSEARCH'), undefined);
assert.equal(readEnvValue(cleared, 'APOLLO_API_KEY'), 'apollo-key');

const settings = readSettingsFromEnv('BRAVE_SEARCH_API_KEY=secret\nCATABULL_WEBSEARCH=ddg\n', {});
assert.equal(settings.secrets.braveApiKey.configured, true);
assert.equal(settings.secrets.braveApiKey.redacted, '********');
assert.equal(settings.secrets.braveApiKey.value, undefined);
assert.equal(settings.webSearchProvider, 'scrape');
assert.equal(settings.webSearchOrder, 'brave,serper,scrape');
assert.deepEqual(settings.scanDefaults, { deepScanLimit: 0, minRelevance: 2.5, freshnessDays: 0 });

const tuned = readSettingsFromEnv('CATABULL_WEBSEARCH_ORDER=serper,brave,scrape\nCATABULL_DEEP_SCAN_LIMIT=25\nCATABULL_DEEP_SCAN_MIN_RELEVANCE=4\nCATABULL_SCAN_FRESHNESS_DAYS=7\n', {});
assert.equal(tuned.webSearchOrder, 'serper,brave,scrape');
assert.deepEqual(tuned.scanDefaults, { deepScanLimit: 25, minRelevance: 4, freshnessDays: 7 });

const tailnet = readSettingsFromEnv('CATABULL_TAILSCALE_MODE=serve\nCATABULL_AUTO_UPDATE=true\n', {});
assert.equal(tailnet.tailscale.mode, 'serve');
assert.equal(tailnet.tailscale.status.message, 'Not checked');
assert.equal(tailnet.updates.autoUpdate, true);

const invalidTailnet = readSettingsFromEnv('CATABULL_TAILSCALE_MODE=maybe\n', {});
assert.equal(invalidTailnet.tailscale.mode, 'off');

const explicitZero = readSettingsFromEnv('CATABULL_DEEP_SCAN_MIN_RELEVANCE=0\n', {});
assert.equal(explicitZero.scanDefaults.minRelevance, 0);

const blankMin = readSettingsFromEnv('CATABULL_DEEP_SCAN_MIN_RELEVANCE=\n', {});
assert.equal(blankMin.scanDefaults.minRelevance, 2.5);

const runtimeOnly = readSettingsFromEnv('', { APOLLO_API_KEY: 'runtime-secret', SERPER_API_KEY: 'runtime-serper' });
assert.equal(runtimeOnly.secrets.apolloApiKey.configured, true);
assert.equal(runtimeOnly.secrets.apolloApiKey.source, 'environment');
assert.equal(runtimeOnly.secrets.serperApiKey.configured, true);
assert.equal(runtimeOnly.secrets.serperApiKey.redacted, '********');

console.log('  ok');
