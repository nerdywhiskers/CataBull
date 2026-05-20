import { execFileSync } from 'child_process';

const DEFAULT_TIMEOUT_MS = 2500;
const IPV4_RE = /^100\.\d+\.\d+\.\d+$/;

export function normalizeTailscaleMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'serve' || mode === 'share' || mode === 'on' || mode === 'true') return 'serve';
  if (mode === 'detect' || mode === 'status') return 'detect';
  return 'off';
}

export function detectTailscale({ env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const bin = env.TAILSCALE_BIN || 'tailscale';
  try {
    const raw = execFileSync(bin, ['status', '--json'], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const status = JSON.parse(raw || '{}');
    const self = status.Self || {};
    const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
    const ipv4 = ips.find((ip) => IPV4_RE.test(String(ip))) || '';
    const dnsName = String(self.DNSName || '').replace(/\.$/, '');
    const backendState = String(status.BackendState || '');
    const running = backendState.toLowerCase() === 'running';
    return {
      installed: true,
      running,
      available: running && Boolean(ipv4 || dnsName),
      backendState,
      ip: ipv4,
      dnsName,
      message: running ? 'Tailscale is running' : (backendState || 'Tailscale is not running'),
    };
  } catch (err) {
    const missing = err?.code === 'ENOENT';
    return {
      installed: !missing,
      running: false,
      available: false,
      backendState: '',
      ip: '',
      dnsName: '',
      message: missing ? 'Tailscale CLI not found' : normalizeCommandError(err),
    };
  }
}

export function tailnetDashboardUrl(status, port) {
  const p = Number(port) || 3737;
  if (status?.dnsName) return `http://${status.dnsName}:${p}`;
  if (status?.ip) return `http://${status.ip}:${p}`;
  return '';
}

export function startTailscaleServe({ dashboardPort = 3737, servePort = dashboardPort, env = process.env, timeoutMs = 8000 } = {}) {
  const bin = env.TAILSCALE_BIN || 'tailscale';
  const target = `localhost:${Number(dashboardPort) || 3737}`;
  const port = Number(servePort) || Number(dashboardPort) || 3737;
  const args = ['serve', '--yes', '--bg', `--http=${port}`, target];
  try {
    const output = execFileSync(bin, args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const status = detectTailscale({ env, timeoutMs: DEFAULT_TIMEOUT_MS });
    return {
      ok: true,
      command: `tailscale ${args.join(' ')}`,
      output: String(output || '').trim(),
      url: tailnetDashboardUrl(status, port),
      status,
    };
  } catch (err) {
    return {
      ok: false,
      command: `tailscale ${args.join(' ')}`,
      error: normalizeCommandError(err),
    };
  }
}

export function stopTailscaleServe({ dashboardPort = 3737, servePort = dashboardPort, env = process.env, timeoutMs = 8000 } = {}) {
  const bin = env.TAILSCALE_BIN || 'tailscale';
  const target = `localhost:${Number(dashboardPort) || 3737}`;
  const port = Number(servePort) || Number(dashboardPort) || 3737;
  const args = ['serve', '--yes', `--http=${port}`, target, 'off'];
  try {
    const output = execFileSync(bin, args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      ok: true,
      command: `tailscale ${args.join(' ')}`,
      output: String(output || '').trim(),
    };
  } catch (err) {
    return {
      ok: false,
      command: `tailscale ${args.join(' ')}`,
      error: normalizeCommandError(err),
    };
  }
}

function normalizeCommandError(err) {
  const stderr = err?.stderr ? String(err.stderr).trim() : '';
  const stdout = err?.stdout ? String(err.stdout).trim() : '';
  const message = stderr || stdout || err?.message || 'Tailscale command failed';
  return message.split(/\r?\n/).slice(0, 4).join(' ');
}
