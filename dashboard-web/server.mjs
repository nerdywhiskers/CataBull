import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startScheduler } from './lib/scheduler.mjs';
import { DEFAULT_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS } from './routes/terminal.mjs';
import { defaultWorkspace } from '../lib/workspace.mjs';
import { ensureWorkspace } from '../lib/workspace-resolver.mjs';
import { registerSecurity, logSessionToken } from './lib/security.mjs';
import { loadEnvFile } from '../lib/load-env.mjs';
import { startTailscaleServe } from '../lib/tailscale.mjs';
import { readSettings } from './routes/settings.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Workspace resolution order:
//   1. CATABULL_WORKSPACE_ROOT env (the CLI sets this; explicit override always wins)
//   2. cwd if it looks like a CataBull workspace
//   3. The project directory containing this server file, when it has
//      cv.md / portals.yml — i.e. running from a checked-out source tree
//      (npm run dashboard from the repo).
//   4. ~/.catabull/ — the fresh-install path used by the global CLI
//
// The `allowProjectFallback` flag is true here so `npm run dashboard` from
// inside the source repo keeps using the repo as the workspace; the
// global CLI passes false because globally installed users shouldn't
// have their data leak into the npm install location.
const PROJECT_ROOT = join(__dirname, '..');
const resolved = ensureWorkspace({
  packageRoot: PROJECT_ROOT,
  projectRoot: PROJECT_ROOT,
  allowProjectFallback: true,
});
const workspace = defaultWorkspace(resolved.root);
const CATA_BULL_ROOT = workspace.root;

// Load .env from the workspace before any route uses process.env.
// Shell-set vars always win — this is just for users who put secrets
// in .env (which is gitignored) instead of their shell profile.
const envLoaded = loadEnvFile(CATA_BULL_ROOT);

const app = Fastify({ logger: false, requestTimeout: 300000 });

const PORT = process.env.PORT || 3737;

// Local-only auth + CSP. Must register BEFORE routes so the preHandler
// hook runs before route handlers. Registers the cookie bootstrap, the
// /api/v1/* auth gate, the WebSocket Origin + token check, and a
// restrictive CSP on HTML responses.
registerSecurity(app, { port: PORT });

// Plugins
app.register(fastifyWebsocket);
app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB
app.register(fastifyStatic, {
  root: join(__dirname, 'public'),
  prefix: '/',
});

// Share root path + workspace with routes. Existing routes use
// `cataBullRoot`; new code should prefer `workspace` (lib/workspace.mjs).
app.decorate('cataBullRoot', CATA_BULL_ROOT);
app.decorate('packageRoot', PROJECT_ROOT);
app.decorate('workspace', workspace);

// Register routes
app.register(import('./routes/applications.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/reports.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/metrics.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/profile.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/settings.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/updates.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/profiles.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/portals.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/memory.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/cv.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/onboarding.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/actions.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/terminal.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/backup.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/health.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/tailor.mjs'), { prefix: '/api/v1' });
app.register(import('./routes/scan-deep.mjs'), { prefix: '/api/v1' });

app.listen({ port: PORT, host: '127.0.0.1' }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`\n  CataBull dashboard running at http://localhost:${PORT}`);
  console.log(`  Workspace root: ${CATA_BULL_ROOT} (${resolved.reason})`);
  if (envLoaded.loaded > 0) {
    console.log(`  Loaded ${envLoaded.loaded} env var${envLoaded.loaded === 1 ? '' : 's'} from .env`);
  }
  if (resolved.created) {
    console.log(`  ↳ Fresh workspace created on first run.`);
    if (resolved.scaffold?.copied?.length) {
      console.log(`  ↳ Templates copied: ${resolved.scaffold.copied.join(', ')}`);
    }
  }
  // Surface the agent timeout so a stale running server is obvious at a
  // glance — e.g. if you pulled a timeout change but didn't restart, the
  // logged number won't match what's in the source.
  console.log(`  Agent timeout: ${Math.round(DEFAULT_RUN_TIMEOUT_MS / 1000)}s default, ${Math.round(MAX_RUN_TIMEOUT_MS / 1000)}s max`);
  logSessionToken(PORT);
  activateTailnetAccess();
  console.log('');
  startScheduler(CATA_BULL_ROOT);
});

function activateTailnetAccess() {
  const settings = readSettings(CATA_BULL_ROOT);
  const tailscale = settings.tailscale || {};
  const mode = tailscale.mode || 'off';
  if (mode === 'off') return;

  if (!tailscale.status?.available) {
    console.log(`  Tailnet access: ${tailscale.status?.message || 'Tailscale unavailable'}`);
    return;
  }

  if (mode === 'detect') {
    console.log(`  Tailnet access: detected at ${tailscale.url || tailscale.status.ip || tailscale.status.dnsName}`);
    return;
  }

  const served = startTailscaleServe({ dashboardPort: PORT });
  if (served.ok) {
    console.log(`  Tailnet access: serving at ${served.url || tailscale.url || 'your Tailscale device address'}`);
  } else {
    console.log(`  Tailnet access: failed to start Tailscale Serve (${served.error})`);
  }
}
