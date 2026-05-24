// Mounts the real dashboard's nav into demo pages, with a DEMO badge.
// Mirrors dashboard-web/public/index.html so the demo CSS (copied from
// dashboard-web/public/css/) styles it identically.

(function () {
  const TABS = [
    {
      id: 'pipeline', label: 'Jobs', href: 'jobs.html',
      icon: '<svg class="tab-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="2" width="12" height="12" rx="2"/><line x1="5" y1="5.5" x2="11" y2="5.5"/><line x1="5" y1="8" x2="11" y2="8"/><line x1="5" y1="10.5" x2="9" y2="10.5"/></svg>',
    },
    {
      id: 'discover', label: 'Discover', href: 'index.html',
      icon: '<svg class="tab-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/></svg>',
    },
    {
      id: 'portals', label: 'Portals', href: 'search.html',
      icon: '<svg class="tab-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="12" height="9" rx="1.5"/><path d="M6 5V3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V5"/><line x1="2" y1="9" x2="14" y2="9"/></svg>',
    },
    {
      id: 'analytics', label: 'Analytics', href: 'analytics.html',
      icon: '<svg class="tab-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="8" width="3" height="6" rx="0.5"/><rect x="6.5" y="5" width="3" height="9" rx="0.5"/><rect x="11" y="2" width="3" height="12" rx="0.5"/></svg>',
    },
  ];

  function activeTabId() {
    const path = window.location.pathname;
    if (path.endsWith('/profile.html')) return 'profile';
    if (path.endsWith('/settings.html')) return 'settings';
    for (const t of TABS) {
      if (path.endsWith('/' + t.href)) return t.id;
    }
    if (path.endsWith('/demo/') || path.endsWith('/demo/index.html')) return 'discover';
    return 'discover';
  }

  function render() {
    const mount = document.getElementById('dash-nav-mount');
    if (!mount) return;
    const active = activeTabId();

    const tabHtml = TABS.map((t) => {
      const cls = 'nav-tab' + (t.id === active ? ' active' : '');
      const aria = t.id === active ? ' aria-current="page"' : '';
      return `<a class="${cls}" href="${t.href}"${aria}>${t.icon}${t.label}</a>`;
    }).join('');

    mount.innerHTML = `
      <div class="demo-banner" role="alert">
        <strong>DEMO MODE</strong>
        <span>Fictional profile, fictional roles, all actions are no-ops. <a href="../">← Back to landing</a></span>
      </div>
      <nav class="nav">
        <a class="nav-brand" href="index.html">
          <img src="../CataBull-logo.svg" alt="" width="28" height="28" class="nav-brand-logo" />
          <span class="nav-brand-text">Cata<span class="nav-brand-accent">Bull</span></span>
          <span class="demo-badge">DEMO</span>
        </a>
        <div class="nav-tabs">${tabHtml}</div>
        <div class="nav-right">
          <a class="nav-icon-btn${active === 'settings' ? ' active' : ''}" href="settings.html" title="Settings" aria-label="Settings"${active === 'settings' ? ' aria-current="page"' : ''}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="2.5" y1="5" x2="7" y2="5"/><line x1="11" y1="5" x2="15.5" y2="5"/><circle cx="9" cy="5" r="2"/><line x1="2.5" y1="13" x2="10" y2="13"/><line x1="14" y1="13" x2="15.5" y2="13"/><circle cx="12" cy="13" r="2"/></svg>
          </a>
          <button class="nav-icon-btn theme-toggle" id="demo-theme-toggle" title="Toggle theme" type="button">
            <svg id="demo-icon-dark" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M15 9.5a6 6 0 1 1-6.5-6.5 5 5 0 0 0 6.5 6.5z"/></svg>
            <svg id="demo-icon-light" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="display:none"><circle cx="9" cy="9" r="3.5"/><line x1="9" y1="1.5" x2="9" y2="3"/><line x1="9" y1="15" x2="9" y2="16.5"/><line x1="1.5" y1="9" x2="3" y2="9"/><line x1="15" y1="9" x2="16.5" y2="9"/><line x1="3.5" y1="3.5" x2="4.6" y2="4.6"/><line x1="13.4" y1="13.4" x2="14.5" y2="14.5"/><line x1="3.5" y1="14.5" x2="4.6" y2="13.4"/><line x1="13.4" y1="4.6" x2="14.5" y2="3.5"/></svg>
          </button>
          <button class="nav-icon-btn" type="button" data-noop title="Chat (no-op in demo)">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h12a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H6L3 16.5z"/></svg>
            <span class="status-dot"></span>
          </button>
          <a class="nav-profile${active === 'profile' ? ' active' : ''}" href="profile.html" title="Profile">
            <span class="nav-profile-avatar">DU</span>
            <span>Demo User</span>
          </a>
        </div>
      </nav>
    `;

    // Theme toggle wired here so each page picks up the user's choice.
    const root = document.documentElement;
    const stored = localStorage.getItem('catabull-demo-theme') || 'dark';
    root.setAttribute('data-theme', stored);
    const dark = document.getElementById('demo-icon-dark');
    const light = document.getElementById('demo-icon-light');
    if (stored === 'light') { dark.style.display = 'none'; light.style.display = 'block'; }
    document.getElementById('demo-theme-toggle').addEventListener('click', () => {
      const cur = root.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      localStorage.setItem('catabull-demo-theme', next);
      dark.style.display = next === 'dark' ? 'block' : 'none';
      light.style.display = next === 'light' ? 'block' : 'none';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
