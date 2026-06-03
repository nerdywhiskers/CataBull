#!/usr/bin/env node

import assert from 'assert/strict';
import { DEFAULT_RESTART_EXIT_CODE, readLaunchContext, requestDashboardRestart } from '../dashboard-web/lib/restart-control.mjs';

console.log('\nrestart control');

{
  const ctx = readLaunchContext({
    CATABULL_LAUNCHER: 'global-cli',
    CATABULL_RESTART_SUPPORTED: 'true',
    CATABULL_RESTART_EXIT_CODE: '91',
    CATABULL_UPDATE_INSTALL_KIND: 'npm-global',
  });
  assert.equal(ctx.launcher, 'global-cli');
  assert.equal(ctx.restartSupported, true);
  assert.equal(ctx.restartExitCode, 91);
  assert.equal(ctx.updateInstallKind, 'npm-global');
}

{
  const ctx = readLaunchContext({
    CATABULL_RESTART_SUPPORTED: 'nope',
    CATABULL_RESTART_EXIT_CODE: 'bad',
    CATABULL_UPDATE_INSTALL_KIND: 'weird',
  });
  assert.equal(ctx.restartSupported, false);
  assert.equal(ctx.restartExitCode, DEFAULT_RESTART_EXIT_CODE);
  assert.equal(ctx.updateInstallKind, '');
}

{
  let scheduled = null;
  let exited = null;
  const ok = requestDashboardRestart(
    { restartSupported: true, restartExitCode: 88 },
    {
      schedule(fn, delay) {
        scheduled = { fn, delay, unrefCalled: false };
        return { unref() { scheduled.unrefCalled = true; } };
      },
      exit(code) {
        exited = code;
      },
    }
  );
  assert.equal(ok, true);
  assert.equal(scheduled.delay, 150);
  assert.equal(scheduled.unrefCalled, true);
  scheduled.fn();
  assert.equal(exited, 88);
}

{
  const ok = requestDashboardRestart({ restartSupported: false }, {
    schedule() { throw new Error('should not schedule'); },
    exit() { throw new Error('should not exit'); },
  });
  assert.equal(ok, false);
}

console.log('  ok');
