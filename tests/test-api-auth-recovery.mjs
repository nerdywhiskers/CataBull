#!/usr/bin/env node

import assert from 'assert/strict';
import { pathToFileURL } from 'url';

const moduleUrl = `${pathToFileURL(process.cwd() + '/dashboard-web/public/js/api.mjs').href}?t=${Date.now()}`;

const locationState = {
  pathname: '/dashboard',
  search: '?tab=pipeline',
  hash: '#/discover',
  replaceCalls: [],
  reloadCalls: 0,
  replace(url) {
    this.replaceCalls.push(url);
  },
  reload() {
    this.reloadCalls += 1;
  },
};

global.window = { location: locationState };
global.fetch = async () => ({
  status: 401,
  ok: false,
  statusText: 'Unauthorized',
  json: async () => ({ error: 'Unauthorized' }),
});

const { api, buildAuthRefreshLocation } = await import(moduleUrl);

assert.equal(typeof buildAuthRefreshLocation, 'function', 'buildAuthRefreshLocation exported');

const refreshUrl = buildAuthRefreshLocation(locationState);
assert.match(
  refreshUrl,
  /^\/dashboard\?tab=pipeline&cb_session_refresh=\d+#\/discover$/,
  'refresh URL preserves path/search/hash and adds cache-busting marker',
);

await assert.rejects(() => api.getProfile(), /401 Unauthorized/, '401 still rejects caller');
assert.equal(locationState.reloadCalls, 0, '401 recovery should not call location.reload');
assert.equal(locationState.replaceCalls.length, 1, '401 recovery should navigate once');
assert.match(
  locationState.replaceCalls[0],
  /^\/dashboard\?tab=pipeline&cb_session_refresh=\d+#\/discover$/,
  '401 recovery uses cache-busting navigation URL',
);

console.log('api auth recovery ok');
