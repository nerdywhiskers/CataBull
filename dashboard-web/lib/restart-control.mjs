export const DEFAULT_RESTART_EXIT_CODE = 75;

export function readLaunchContext(env = process.env) {
  return {
    launcher: String(env.CATABULL_LAUNCHER || '').trim(),
    restartSupported: parseBooleanEnv(env.CATABULL_RESTART_SUPPORTED),
    restartExitCode: parseRestartExitCode(env.CATABULL_RESTART_EXIT_CODE),
    updateInstallKind: normalizeInstallKind(env.CATABULL_UPDATE_INSTALL_KIND),
  };
}

export function requestDashboardRestart(context = {}, { schedule = setTimeout, exit = process.exit } = {}) {
  if (!context?.restartSupported) return false;
  const exitCode = parseRestartExitCode(context.restartExitCode);
  const timer = schedule(() => exit(exitCode), 150);
  if (typeof timer?.unref === 'function') timer.unref();
  return true;
}

function parseBooleanEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function parseRestartExitCode(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RESTART_EXIT_CODE;
}

function normalizeInstallKind(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'npm-global' || normalized === 'git-checkout') return normalized;
  return '';
}
