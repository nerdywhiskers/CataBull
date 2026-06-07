import { api } from './api.mjs';
import { toast } from './components/toast.mjs';
import { runModePrompt } from './lib/modes.mjs';
import { render as renderPipeline } from './views/pipeline.mjs';
import { render as renderProgress } from './views/progress.mjs';
import { render as renderProfile } from './views/profile.mjs';
import { render as renderPortals } from './views/portals.mjs';
import { render as renderDiscover } from './views/discover.mjs';
import { render as renderSettings } from './views/settings.mjs';
import { init as initTerminal, show as showTerminal, runPrompt } from './views/chat.mjs';
import { init as initCommandPalette, isOpen as isPaletteOpen, open as openCommandPalette } from './views/command-palette.mjs';
import { render as renderOnboarding } from './views/onboarding.mjs';
import { initUpdateNotifier } from './components/update-notifier.mjs';

const views = { pipeline: renderPipeline, discover: renderDiscover, analytics: renderProgress, profile: renderProfile, portals: renderPortals, settings: renderSettings };

function updateThemeIcon(theme) {
  const dark = document.getElementById('theme-icon-dark');
  const light = document.getElementById('theme-icon-light');
  if (dark) dark.style.display = theme === 'dark' ? 'block' : 'none';
  if (light) light.style.display = theme === 'light' ? 'block' : 'none';
}

let currentView = 'pipeline';

function parseHash() {
  const hash = window.location.hash.slice(2) || 'pipeline';
  const parts = hash.split('/');
  return { view: parts[0], param: parts.slice(1).join('/') };
}

function switchView(name, param) {
  currentView = name;

  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.view === name);
  });
  document.querySelectorAll('.nav-icon-btn[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const viewEl = document.getElementById(`view-${name}`);
  if (viewEl) {
    viewEl.classList.add('active');
    const renderer = views[name];
    if (renderer) renderer(viewEl, param);
  }
}

async function init() {
  const onboardingBypass = sessionStorage.getItem('catabull-onboarding-bypass') === '1';
  // Check onboarding status
  try {
    const { complete } = await api.onboardingStatus();
    if (!complete && !onboardingBypass) {
      document.getElementById('onboarding-container').style.display = 'block';
      document.getElementById('dashboard-container').style.display = 'none';
      renderOnboarding(document.getElementById('onboarding-container'));
      return;
    }
    if (complete) sessionStorage.removeItem('catabull-onboarding-bypass');
  } catch { /* proceed to dashboard */ }

  // Show dashboard
  document.getElementById('onboarding-container').style.display = 'none';
  document.getElementById('dashboard-container').style.display = 'block';

  // Load user name + initials for the nav avatar chip
  try {
    const { profile } = await api.getProfile();
    const fullName = profile?.candidate?.full_name;
    if (fullName) {
      document.getElementById('user-name').textContent = fullName;
      const parts = String(fullName).trim().split(/\s+/);
      const initials = (parts[0]?.[0] || '?') + (parts[1]?.[0] || '');
      const avatar = document.getElementById('user-avatar');
      if (avatar) avatar.textContent = initials.toUpperCase();
    }
  } catch { /* ok */ }

  // Theme toggle
  const savedTheme = localStorage.getItem('catabull-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);

  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('catabull-theme', next);
    updateThemeIcon(next);
  });

  // Initialize chat rail. The rail is permanent on >=1180px viewports
  // (it lives in the dashboard grid). On narrow viewports the same drawer
  // collapses behind a slide-in transform — the toggle button still works.
  initTerminal();
  initCommandPalette(document.getElementById('command-palette-root'));
  initUpdateNotifier();

  // Nav tab clicks (also routes the avatar profile chip)
  document.querySelectorAll('[data-view]').forEach(tab => {
    tab.onclick = () => {
      window.location.hash = `#/${tab.dataset.view}`;
    };
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (!isPaletteOpen()) openCommandPalette();
    }
  });

  // Handle hash routing
  window.addEventListener('hashchange', () => {
    const { view, param } = parseHash();
    if (view === 'reports') { switchView('analytics'); return; }
    // Memory used to be a top-level view. It now lives inside Analytics
    // as a sub-tab. Redirect deep-links transparently.
    if (view === 'memory') { switchView('analytics', 'memory'); return; }
    // #/chat opens the terminal drawer instead of a view
    if (view === 'chat') { showTerminal(); return; }
    if (views[view]) switchView(view, param);
  });

  // Initial route
  const { view, param } = parseHash();
  if (view === 'chat') {
    switchView('pipeline');
    showTerminal();
  } else if (view === 'memory') {
    switchView('analytics', 'memory');
  } else {
    const resolvedView = view === 'reports' ? 'analytics' : (views[view] ? view : 'pipeline');
    switchView(resolvedView, param);
  }

  // If onboarding left a prompt for us (the "Run with <agent>" button on
  // the done step), fire it now that the dashboard is up and the terminal
  // is initialized.
  const pendingPrompt = sessionStorage.getItem('catabull-autogen-prompt');
  if (pendingPrompt) {
    sessionStorage.removeItem('catabull-autogen-prompt');
    // Slight delay so the initial view's render finishes first.
    setTimeout(() => { runPrompt(pendingPrompt); }, 400);
  }
}

init();
