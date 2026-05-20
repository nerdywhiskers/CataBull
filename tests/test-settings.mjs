#!/usr/bin/env node

import assert from 'assert/strict';
import { applyEnvUpdates, readEnvValue, readSettingsFromEnv } from '../dashboard-web/routes/settings.mjs';

console.log('\ndashboard settings');

const original = [
  '# keep comments',
  'BRAVE_SEARCH_API_KEY=old-key',
  'CAREERBOT_WEBSEARCH=scrape',
  'BRAVE_SEARCH_API_KEY=duplicate-key',
  '',
].join('\n');

const updated = applyEnvUpdates(original, {
  BRAVE_SEARCH_API_KEY: 'new-key',
  SERPER_API_KEY: 'serper-key',
  APOLLO_API_KEY: 'apollo-key',
  CAREERBOT_WEBSEARCH: 'brave',
  CAREERBOT_WEBSEARCH_ORDER: 'serper,brave,scrape',
  CAREERBOT_DEEP_SCAN_LIMIT: '50',
  CAREERBOT_DEEP_SCAN_MIN_RELEVANCE: '3.5',
  CAREERBOT_SCAN_FRESHNESS_DAYS: '30',
  CAREERBOT_TAILSCALE_MODE: 'detect',
  CAREERBOT_AUTO_UPDATE: 'true',
});

assert.equal(readEnvValue(updated, 'BRAVE_SEARCH_API_KEY'), 'new-key');
assert.equal(readEnvValue(updated, 'SERPER_API_KEY'), 'serper-key');
assert.equal(readEnvValue(updated, 'APOLLO_API_KEY'), 'apollo-key');
assert.equal(readEnvValue(updated, 'CAREERBOT_WEBSEARCH'), 'brave');
assert.equal(readEnvValue(updated, 'CAREERBOT_WEBSEARCH_ORDER'), 'serper,brave,scrape');
assert.equal(readEnvValue(updated, 'CAREERBOT_DEEP_SCAN_LIMIT'), '50');
assert.equal(readEnvValue(updated, 'CAREERBOT_DEEP_SCAN_MIN_RELEVANCE'), '3.5');
assert.equal(readEnvValue(updated, 'CAREERBOT_SCAN_FRESHNESS_DAYS'), '30');
assert.equal(readEnvValue(updated, 'CAREERBOT_TAILSCALE_MODE'), 'detect');
assert.equal(readEnvValue(updated, 'CAREERBOT_AUTO_UPDATE'), 'true');
assert.equal((updated.match(/BRAVE_SEARCH_API_KEY/g) || []).length, 1);
assert.match(updated, /# keep comments/);

const cleared = applyEnvUpdates(updated, {
  BRAVE_SEARCH_API_KEY: null,
  CAREERBOT_WEBSEARCH: null,
});

assert.equal(readEnvValue(cleared, 'BRAVE_SEARCH_API_KEY'), undefined);
assert.equal(readEnvValue(cleared, 'CAREERBOT_WEBSEARCH'), undefined);
assert.equal(readEnvValue(cleared, 'APOLLO_API_KEY'), 'apollo-key');

const settings = readSettingsFromEnv('BRAVE_SEARCH_API_KEY=secret\nCAREERBOT_WEBSEARCH=ddg\n', {});
assert.equal(settings.secrets.braveApiKey.configured, true);
assert.equal(settings.secrets.braveApiKey.redacted, '********');
assert.equal(settings.secrets.braveApiKey.value, undefined);
assert.equal(settings.webSearchProvider, 'scrape');
assert.equal(settings.webSearchOrder, 'brave,serper,scrape');
assert.deepEqual(settings.scanDefaults, { deepScanLimit: 0, minRelevance: 2.5, freshnessDays: 0 });

const tuned = readSettingsFromEnv('CAREERBOT_WEBSEARCH_ORDER=serper,brave,scrape\nCAREERBOT_DEEP_SCAN_LIMIT=25\nCAREERBOT_DEEP_SCAN_MIN_RELEVANCE=4\nCAREERBOT_SCAN_FRESHNESS_DAYS=7\n', {});
assert.equal(tuned.webSearchOrder, 'serper,brave,scrape');
assert.deepEqual(tuned.scanDefaults, { deepScanLimit: 25, minRelevance: 4, freshnessDays: 7 });

const tailnet = readSettingsFromEnv('CAREERBOT_TAILSCALE_MODE=serve\nCAREERBOT_AUTO_UPDATE=true\n', {});
assert.equal(tailnet.tailscale.mode, 'serve');
assert.equal(tailnet.tailscale.status.message, 'Not checked');
assert.equal(tailnet.updates.autoUpdate, true);

const invalidTailnet = readSettingsFromEnv('CAREERBOT_TAILSCALE_MODE=maybe\n', {});
assert.equal(invalidTailnet.tailscale.mode, 'off');

const explicitZero = readSettingsFromEnv('CAREERBOT_DEEP_SCAN_MIN_RELEVANCE=0\n', {});
assert.equal(explicitZero.scanDefaults.minRelevance, 0);

const blankMin = readSettingsFromEnv('CAREERBOT_DEEP_SCAN_MIN_RELEVANCE=\n', {});
assert.equal(blankMin.scanDefaults.minRelevance, 2.5);

const runtimeOnly = readSettingsFromEnv('', { APOLLO_API_KEY: 'runtime-secret', SERPER_API_KEY: 'runtime-serper' });
assert.equal(runtimeOnly.secrets.apolloApiKey.configured, true);
assert.equal(runtimeOnly.secrets.apolloApiKey.source, 'environment');
assert.equal(runtimeOnly.secrets.serperApiKey.configured, true);
assert.equal(runtimeOnly.secrets.serperApiKey.redacted, '********');

console.log('  ok');
