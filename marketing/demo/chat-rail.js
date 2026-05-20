// Injects the static chat rail into each demo page so the layout matches
// the production dashboard. Mirrors the markup from
// dashboard-web/public/index.html, minus the live agent select / WebSocket
// hookup that only the real app needs.

(function () {
  function render() {
    const shell = document.querySelector('.dashboard-shell');
    if (!shell) return;
    if (shell.querySelector('.terminal-drawer')) return; // idempotent

    const aside = document.createElement('aside');
    aside.id = 'demo-terminal-drawer';
    aside.className = 'terminal-drawer dock-right';
    aside.style.display = 'flex';
    aside.innerHTML = `
      <div class="terminal-resize-handle"></div>
      <div class="terminal-drawer-header">
        <div class="rail-brand">
          <span class="rail-brand-icon">
            <svg width="22" height="19" viewBox="0 0 22 19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="16" height="13" rx="3"/><circle cx="8" cy="9.5" r="1.2" fill="currentColor"/><circle cx="14" cy="9.5" r="1.2" fill="currentColor"/><path d="M11 1v2"/></svg>
          </span>
          <div class="rail-brand-text">
            <span class="rail-brand-name">CareerBot AI</span>
            <select class="terminal-header-agent" title="Switch agent (no-op in demo)" data-noop>
              <option>Claude</option>
              <option>OpenCode</option>
              <option>Codex</option>
            </select>
          </div>
        </div>
        <div class="terminal-view-toggle">
          <button class="terminal-view-btn active" type="button" data-noop>Chat</button>
          <button class="terminal-view-btn" type="button" data-noop>Terminal</button>
        </div>
      </div>
      <div class="terminal-content">
        <div class="chat-pane" style="display:flex;flex-direction:column;height:100%">
          <div class="chat-messages" style="flex:1;display:flex">
            <div class="chat-empty-state">
              <span class="chat-empty-icon" aria-hidden="true">
                <svg width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12h26a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H17l-7 7v-7H9a3 3 0 0 1-3-3V15a3 3 0 0 1 3-3z"/><circle cx="17" cy="22" r="1.6" fill="currentColor" stroke="none"/><circle cx="22" cy="22" r="1.6" fill="currentColor" stroke="none"/><circle cx="27" cy="22" r="1.6" fill="currentColor" stroke="none"/></svg>
              </span>
              <h3>Chat View</h3>
              <p>Send a prompt here or launch a mode from the dashboard. Raw terminal stays one click away.</p>
            </div>
          </div>
          <div class="chat-composer">
            <textarea class="form-textarea chat-composer-input" placeholder="Ask CareerBot something or type /careerbot to show a list of commands" data-noop></textarea>
            <div class="chat-composer-actions">
              <button class="btn btn-ghost btn-sm" type="button" data-noop>Settings</button>
              <button class="btn btn-ghost btn-sm" type="button" data-noop>History</button>
              <button class="btn btn-sm btn-primary" type="button" data-noop style="margin-left:auto">Send</button>
            </div>
          </div>
        </div>
      </div>
    `;
    shell.appendChild(aside);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
