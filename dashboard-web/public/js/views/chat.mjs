import { api } from '../api.mjs';
import { isPermissionLine, stripAnsi } from '../lib/ansi.mjs';
import { isSessionConflict } from '../lib/session-conflict.mjs';
import {
  addAssistantMessage,
  addPermissionMessage,
  addSystemMessage,
  addUserMessage,
  focusInput as focusChatInput,
  getMessagesSnapshot,
  handleError as handleChatError,
  handleExit as handleChatExit,
  handleOutput as handleChatOutput,
  hideWorkingMessage,
  init as initChatUi,
  reset as resetChatUi,
  restoreMessages as restoreChatMessages,
  setAgent as setChatAgent,
  showWorkingMessage,
} from './chatui.mjs';

let term = null;
let fitAddon = null;
let ws = null;
let agents = [];
let currentAgent = '';
let drawerInitialized = false;
let terminalInitialized = false;
let drawerVisible = false;
let agentsReady = null;
let lastOutputAt = 0;
let rawBacklog = '';
let currentView = localStorage.getItem('catabull-terminal-view') || 'chat';
let reconnectTimer = null;
let suppressTranscriptPersistence = false;
function shouldAutoOpenDrawer() {
  // On mobile the drawer becomes a full overlay. Reopening it automatically
  // from a desktop preference hides the dashboard behind chat on first load.
  return window.innerWidth > 1180 && localStorage.getItem('catabull-terminal-open') !== 'false';
}
const AGENT_STORAGE_KEY = 'catabull-terminal-agent';
const AGENT_SESSIONS_STORAGE_KEY = 'catabull-chat-agent-sessions';
const CHAT_TRANSCRIPTS_STORAGE_KEY = 'catabull-chat-transcripts';
const CHAT_RECORDS_STORAGE_KEY = 'catabull-chat-session-records';
const CURRENT_CHAT_RECORD_STORAGE_KEY = 'catabull-chat-current-session-record';
const MAX_SESSION_RECORDS = 20;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 20;

// Per-agent capability map populated from /terminal/agents.
let continuationSupport = {};

// Sticky session id per agent. claude uses --session-id <uuid>; same uuid on
// every turn means "continue this conversation," fresh uuid means "new chat."
// codex falls back to "resume last" (no per-id session control in exec mode),
// so for codex this map only tracks "have we seen at least one turn yet?".
const agentSessions = loadAgentSessions();
const chatRecords = loadChatRecords();
let currentChatRecordId = loadCurrentChatRecordId();
ensureCurrentChatRecord();
pruneOrphanedAgentSessions();

function loadAgentSessions() {
  try {
    const raw = localStorage.getItem(AGENT_SESSIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveAgentSessions() {
  try { localStorage.setItem(AGENT_SESSIONS_STORAGE_KEY, JSON.stringify(agentSessions)); } catch {}
}

function loadLegacyChatTranscripts() {
  try {
    const raw = localStorage.getItem(CHAT_TRANSCRIPTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveChatRecords() {
  try { localStorage.setItem(CHAT_RECORDS_STORAGE_KEY, JSON.stringify(chatRecords)); } catch {}
}

function saveCurrentChatRecordId() {
  try { localStorage.setItem(CURRENT_CHAT_RECORD_STORAGE_KEY, currentChatRecordId || ''); } catch {}
}

function loadCurrentChatRecordId() {
  try { return localStorage.getItem(CURRENT_CHAT_RECORD_STORAGE_KEY) || ''; } catch { return ''; }
}

function createChatRecord({ agent = currentAgent || '', sessionId = null, messages = [] } = {}) {
  return {
    id: newSessionId(),
    agent,
    sessionId,
    messages,
    title: sessionRecordTitle(messages, agent),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function loadChatRecords() {
  try {
    const raw = localStorage.getItem(CHAT_RECORDS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(record => record && record.id);
    }
  } catch {}

  const legacy = loadLegacyChatTranscripts();
  const migrated = Object.entries(legacy)
    .filter(([, value]) => Array.isArray(value?.messages) && value.messages.length > 0)
    .map(([agent, value]) => ({
      id: newSessionId(),
      agent,
      sessionId: agentSessions[agent] || null,
      messages: value.messages,
      title: sessionRecordTitle(value.messages, agent),
      createdAt: value.updatedAt || Date.now(),
      updatedAt: value.updatedAt || Date.now(),
    }));
  if (migrated.length) {
    try { localStorage.setItem(CHAT_RECORDS_STORAGE_KEY, JSON.stringify(migrated.slice(0, MAX_SESSION_RECORDS))); } catch {}
  }
  return migrated.slice(0, MAX_SESSION_RECORDS);
}

function withTranscriptPersistencePaused(callback) {
  suppressTranscriptPersistence = true;
  try {
    return callback();
  } finally {
    suppressTranscriptPersistence = false;
  }
}

function recordHasAgentSession(name) {
  return chatRecords.some(record => record.agent === name && record.sessionId === agentSessions[name]);
}

function pruneOrphanedAgentSessions() {
  let changed = false;
  for (const name of Object.keys(agentSessions)) {
    if (recordHasAgentSession(name)) continue;
    delete agentSessions[name];
    changed = true;
  }
  if (changed) saveAgentSessions();
}

function persistCurrentTranscript(snapshot = getMessagesSnapshot()) {
  if (suppressTranscriptPersistence) return;
  const record = ensureCurrentChatRecord();
  record.agent = currentAgent || record.agent || '';
  record.sessionId = agentSessions[currentAgent] || record.sessionId || null;
  record.messages = Array.isArray(snapshot) ? snapshot : [];
  record.title = sessionRecordTitle(record.messages, record.agent);
  record.updatedAt = Date.now();
  trimChatRecords();
  saveChatRecords();
}

function sessionRecordTitle(messages = [], agent = '') {
  const firstUser = messages.find(message => message?.role === 'user' && message.text);
  const text = String(firstUser?.text || agent || 'Chat').replace(/\s+/g, ' ').trim();
  return text.length > 44 ? `${text.slice(0, 43)}...` : text;
}

function ensureCurrentChatRecord() {
  let record = chatRecords.find(item => item.id === currentChatRecordId);
  if (!record) {
    record = createChatRecord();
    chatRecords.unshift(record);
    currentChatRecordId = record.id;
    saveCurrentChatRecordId();
    trimChatRecords();
    saveChatRecords();
  }
  return record;
}

function trimChatRecords() {
  chatRecords.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  chatRecords.splice(MAX_SESSION_RECORDS);
}

function restoreCurrentChatTranscript() {
  const record = ensureCurrentChatRecord();
  const snapshot = Array.isArray(record.messages) ? record.messages : [];
  withTranscriptPersistencePaused(() => {
    restoreChatMessages(snapshot, currentAgent);
  });
}

export function formatSessionRecordForMenu(record = {}, now = Date.now()) {
  const updatedAt = Number(record.updatedAt || 0);
  const ageMs = Math.max(0, now - updatedAt);
  const minutes = Math.floor(ageMs / 60_000);
  const hours = Math.floor(ageMs / 3_600_000);
  const days = Math.floor(ageMs / 86_400_000);
  const updatedLabel = !updatedAt
    ? ''
    : minutes < 1
    ? 'just now'
    : minutes < 60
    ? `${minutes}m ago`
    : hours < 24
    ? `${hours}h ago`
    : `${days}d ago`;
  return {
    id: record.id,
    title: record.title || sessionRecordTitle(record.messages, record.agent),
    agent: record.agent || '',
    updatedLabel,
  };
}

function listSessionRecordsForMenu() {
  return chatRecords
    .filter(record => Array.isArray(record.messages) && record.messages.length > 0)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(record => formatSessionRecordForMenu(record));
}

function selectChatRecord(recordId) {
  const record = chatRecords.find(item => item.id === recordId);
  if (!record) return;
  currentChatRecordId = record.id;
  saveCurrentChatRecordId();
  if (record.agent && agents.includes(record.agent)) {
    currentAgent = record.agent;
    localStorage.setItem(AGENT_STORAGE_KEY, currentAgent);
    document.getElementById('agent-select') && (document.getElementById('agent-select').value = currentAgent);
  }
  if (record.agent && record.sessionId) {
    agentSessions[record.agent] = record.sessionId;
    saveAgentSessions();
  }
  setChatAgent(currentAgent);
  clearTerminalOutput();
  restoreCurrentChatTranscript();
  disconnectSession({ state: drawerVisible ? 'connecting' : 'disconnected' });
  if (drawerVisible) connect();
}

function agentSupportsContinuation(name) {
  return Boolean(continuationSupport[name]);
}

function newSessionId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for very old browsers; not RFC-compliant but unique enough.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function ensureSessionId(name) {
  if (!agentSessions[name]) {
    agentSessions[name] = newSessionId();
    saveAgentSessions();
  }
  if (name === currentAgent) {
    const record = ensureCurrentChatRecord();
    record.agent = name;
    record.sessionId = agentSessions[name];
    record.updatedAt = Date.now();
    saveChatRecords();
  }
  return agentSessions[name];
}

export function shouldContinueAgentSession({ supportsContinuation, hasSession }) {
  // Sticky-session agents create a named session on turn one, then must resume
  // that same id on follow-up turns. Resume-last agents only need a boolean
  // "seen before" marker. In both cases, an existing marker means continue.
  return Boolean(supportsContinuation && hasSession);
}

export function textContainsPermissionPrompt(value = '') {
  return stripAnsi(String(value || ''))
    .split(/\r?\n/)
    .some(line => isPermissionLine(line));
}

async function loadAgents() {
  try {
    const [agentsRes, profileRes] = await Promise.all([
      fetch('/api/v1/terminal/agents').then(r => r.json()).catch(() => ({ agents: [] })),
      fetch('/api/v1/profile').then(r => r.json()).catch(() => ({ profile: null })),
    ]);
    agents = agentsRes.agents || [];
    continuationSupport = agentsRes.continuationSupport || {};
    const persisted = localStorage.getItem(AGENT_STORAGE_KEY);
    const preferred = profileRes?.profile?.preferences?.agent;
    currentAgent = (persisted && agents.includes(persisted))
      ? persisted
      : (preferred && agents.includes(preferred))
      ? preferred
      : (agents[0] || '');
    if (currentAgent) {
      localStorage.setItem(AGENT_STORAGE_KEY, currentAgent);
    }
    setChatAgent(currentAgent);
  } catch {
    agents = [];
  }
}

function updateStatus(state) {
  // Status is now reflected in the Chat button in the main nav: dot color
  // for at-a-glance state, tooltip for the literal label. The drawer header
  // no longer carries its own indicator.
  const toggleDot = document.getElementById('terminal-toggle-dot');
  const toggleBtn = document.getElementById('terminal-toggle');
  const color = state === 'connected'
    ? 'var(--green)'
    : state === 'connecting'
    ? 'var(--yellow)'
    : 'var(--red)';
  const text = state === 'connected'
    ? 'Connected'
    : state === 'connecting'
    ? 'Connecting…'
    : 'Disconnected';

  if (toggleDot) toggleDot.style.background = color;
  if (toggleBtn) toggleBtn.title = `Toggle chat (Ctrl+\`) — ${text}`;
}

function writeRaw(data) {
  rawBacklog += data;
  if (term) term.write(data);
}

function writeRawLine(data) {
  writeRaw(`${data}\r\n`);
}

function logSystem(text, tone = 'default') {
  const color = tone === 'error' ? '210' : '141';
  writeRawLine(`\x1b[38;5;${color}m  ${text}\x1b[0m`);
  addSystemMessage(text, tone);
}

function clearTerminalOutput() {
  rawBacklog = '';
  if (term) term.clear();
}

function syncChatUiToCurrentAgent() {
  restoreCurrentChatTranscript();
}

function clearSessionOutput({ resetChat = true } = {}) {
  clearTerminalOutput();
  if (resetChat) resetChatUi(currentAgent);
  else syncChatUiToCurrentAgent();
}

// "Reset" rotates the current agent's session id so the next message starts
// a brand-new conversation instead of resuming the previous one. Also wipes
// the visible chat history. Doesn't kill the raw PTY — that's separate.
function resetChatSession() {
  if (currentAgent) {
    delete agentSessions[currentAgent];
    saveAgentSessions();
  }
  const record = createChatRecord({ agent: currentAgent });
  chatRecords.unshift(record);
  currentChatRecordId = record.id;
  saveCurrentChatRecordId();
  trimChatRecords();
  saveChatRecords();
  clearTerminalOutput();
  syncChatUiToCurrentAgent();
}

function ensureTerminal() {
  const container = document.getElementById('terminal');
  if (!container || terminalInitialized) return;

  term = new Terminal({
    theme: {
      background: '#181825',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#181825',
      selectionBackground: '#45475a',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#cba6f7', cyan: '#89dceb', white: '#cdd6f4',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
      brightBlue: '#89b4fa', brightMagenta: '#cba6f7', brightCyan: '#89dceb', brightWhite: '#cdd6f4',
    },
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
    fontSize: 14,
    lineHeight: 1.4,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 5000,
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  term.write(rawBacklog);
  fitAddon.fit();

  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  term.onResize(({ cols, rows }) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  const resizeObserver = new ResizeObserver(() => {
    if (!drawerVisible || currentView !== 'raw') return;
    syncMainOffset();
    if (fitAddon) fitAddon.fit();
  });
  resizeObserver.observe(container);

  terminalInitialized = true;
}

function clearReconnectTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(delayMs = 1000) {
  if (reconnectTimer || !drawerVisible || !currentAgent) return;
  updateStatus('connecting');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delayMs);
}

function disconnectSession({ state = 'disconnected' } = {}) {
  clearReconnectTimer();
  const socket = ws;
  ws = null;
  if (socket) {
    try { socket.close(); } catch {}
  }
  updateStatus(state);
}

function connect() {
  if (!currentAgent || !drawerVisible) {
    updateStatus('disconnected');
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  clearReconnectTimer();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const cols = term ? term.cols : DEFAULT_COLS;
  const rows = term ? term.rows : DEFAULT_ROWS;
  const socket = new WebSocket(`${protocol}//${location.host}/api/v1/terminal/ws?agent=${encodeURIComponent(currentAgent)}&cols=${cols}&rows=${rows}`);
  ws = socket;
  updateStatus('connecting');

  socket.onopen = () => {
    if (ws !== socket) return;
    updateStatus('connected');
    setChatAgent(currentAgent);
    if (term && currentView === 'raw') {
      fitAddon?.fit();
      socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      term.focus();
    }
  };

  socket.onmessage = (event) => {
    if (ws !== socket) return;
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output') {
        writeRaw(msg.data);
        handleChatOutput(msg.data);
        lastOutputAt = Date.now();
      } else if (msg.type === 'exit') {
        writeRawLine(`\x1b[38;5;245m  Session ended (exit code: ${msg.code})\x1b[0m`);
        handleChatExit(msg.code);
        updateStatus('disconnected');
      } else if (msg.type === 'error') {
        writeRawLine(`\x1b[38;5;210m  Error: ${msg.data}\x1b[0m`);
        handleChatError(`Error: ${msg.data}`);
      }
    } catch {}
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    updateStatus('disconnected');
    scheduleReconnect();
  };
  socket.onerror = () => {
    if (ws !== socket) return;
    writeRawLine('\x1b[38;5;210m  Connection error\x1b[0m');
    handleChatError('Connection error');
  };
}

function syncMainOffset() {
  const drawer = document.getElementById('terminal-drawer');
  const main = document.getElementById('main-content');
  if (!drawer || !main || !drawerVisible) return;
  main.style.setProperty('--drawer-offset', drawer.offsetWidth + 'px');
}

function attachDrag(el, { markDragging } = {}) {
  const drawer = document.getElementById('terminal-drawer');
  const shell = document.querySelector('.dashboard-shell');
  if (!el || !drawer || !shell) return;

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.btn') || e.target.closest('select')) return;

    const startX = e.clientX;
    const startW = drawer.offsetWidth;
    if (markDragging) el.classList.add('dragging');
    document.body.style.userSelect = 'none';

    const onMove = (event) => {
      const newW = Math.max(280, Math.min(Math.floor(window.innerWidth * 0.55), startW + (startX - event.clientX)));
      // Drive the grid column width via a CSS variable on the dashboard
      // shell. The rail itself is `width: 100%` so it tracks the column.
      shell.style.setProperty('--rail-width', `${newW}px`);
      try { localStorage.setItem('catabull-rail-width', String(newW)); } catch {}
      syncMainOffset();
      if (fitAddon && currentView === 'raw') fitAddon.fit();
    };
    const onUp = () => {
      if (markDragging) el.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

function setupDragResize() {
  attachDrag(document.getElementById('terminal-resize-handle'), { markDragging: true });
}

function applyViewMode(nextView) {
  currentView = nextView === 'raw' ? 'raw' : 'chat';
  localStorage.setItem('catabull-terminal-view', currentView);

  const terminalEl = document.getElementById('terminal');
  const chatEl = document.getElementById('chat-pane');
  const chatBtn = document.getElementById('terminal-view-chat');
  const rawBtn = document.getElementById('terminal-view-raw');

  if (terminalEl) terminalEl.style.display = currentView === 'raw' ? 'block' : 'none';
  if (chatEl) chatEl.style.display = currentView === 'chat' ? 'flex' : 'none';
  if (chatBtn) chatBtn.classList.toggle('active', currentView === 'chat');
  if (rawBtn) rawBtn.classList.toggle('active', currentView === 'raw');

  if (currentView === 'raw' && drawerVisible) {
    ensureTerminal();
    connect();
    setTimeout(() => {
      if (fitAddon) fitAddon.fit();
      if (ws && ws.readyState === WebSocket.OPEN && term) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
      term?.focus();
    }, 50);
  } else if (currentView === 'chat' && drawerVisible) {
    focusChatInput();
  }
}

async function submitFromChatView(text) {
  return runPrompt(text);
}

export async function show({ persist = true } = {}) {
  const drawer = document.getElementById('terminal-drawer');
  const main = document.getElementById('main-content');
  if (!drawer) return;

  drawer.style.display = 'flex';
  drawer.classList.add('is-open');
  document.querySelector('.dashboard-shell')?.classList.remove('rail-hidden');
  if (persist) localStorage.setItem('catabull-terminal-open', 'true');
  if (main) main.classList.add('with-drawer-right');
  drawerVisible = true;

  if (!drawerInitialized) {
    setupDragResize();
    // Restore the user's last drag-resize width (capped to 55vw so it can
    // never push the main column off-screen on smaller monitors).
    try {
      const saved = parseInt(localStorage.getItem('catabull-rail-width') || '0', 10);
      const cap = Math.floor(window.innerWidth * 0.55);
      if (saved >= 280 && saved <= cap) {
        document.querySelector('.dashboard-shell')?.style.setProperty('--rail-width', `${saved}px`);
      }
    } catch {}
    drawerInitialized = true;
  }

  if (currentView === 'raw') ensureTerminal();
  applyViewMode(currentView);
  connect();

  setTimeout(() => {
    syncMainOffset();
    if (fitAddon && currentView === 'raw') fitAddon.fit();
  }, 50);

  if (agentsReady) { try { await agentsReady; } catch {} }
  if (!currentAgent) return;
  connect();
}

export function hide({ persist = true } = {}) {
  const drawer = document.getElementById('terminal-drawer');
  const main = document.getElementById('main-content');
  if (drawer) {
    drawer.style.display = 'none';
    drawer.classList.remove('is-open');
    document.querySelector('.dashboard-shell')?.classList.add('rail-hidden');
  }
  if (main) {
    main.classList.remove('with-drawer-right');
    main.style.removeProperty('--drawer-offset');
  }
  disconnectSession();
  if (persist) localStorage.setItem('catabull-terminal-open', 'false');
  drawerVisible = false;
}

export function toggle() {
  if (drawerVisible) hide();
  else show();
}

// Match terminal.mjs DEFAULT_RUN_TIMEOUT_MS plus a 30s grace for the HTTP
// round-trip. Long enough for evaluate / deep research / outreach without
// aborting mid-run.
const CHAT_RUN_TIMEOUT_MS = 630_000;

export async function runPrompt(text, {
  readinessTimeoutMs = 45000,
  quiescentMs = 700,
  timeoutMs = CHAT_RUN_TIMEOUT_MS,
  displayText,
} = {}) {
  if (!text) return false;

  // Open the drawer *before* rendering the user message so the message is
  // already on screen by the time the user looks. Avoids the perceived
  // "click → wait → message flashes in" delay.
  //
  // displayText is what the user sees in chat (e.g. `/catabull evaluate
  // <url>`). text is what's sent to the agent (e.g. the multi-paragraph
  // inline expansion built for codex/opencode/gemini, which would be ugly
  // to render verbatim). When omitted, displayText defaults to text — that
  // case covers free-form user typing where they already see what they
  // wrote in the composer.
  await show();
  addUserMessage(displayText || text);

  if (!currentAgent) {
    addSystemMessage('No supported agent was detected on PATH.', 'error');
    return false;
  }


  if (currentView === 'chat') {
    showWorkingMessage(`${currentAgent} is working`, currentAgent);
    // claude and openclaw are the CLIs whose explicit session ids create the
    // session on first use, so we can drive them with a sticky uuid (Reset
    // rotates it). codex, hermes, and opencode resume the most recent session
    // globally. For those agents we just track "have we seen one turn yet?"
    // and Reset drops the flag so the next turn creates a new session by
    // omitting continuation.
    const supportsContinuation = agentSupportsContinuation(currentAgent);
    const usesStickySession = currentAgent === 'claude' || currentAgent === 'openclaw';
    const hadSession = Boolean(agentSessions[currentAgent]);
    const continueSession = shouldContinueAgentSession({
      supportsContinuation,
      hasSession: hadSession,
    });

    // Run the agent with the current session-id. On session-conflict
    // errors (another claude process holding the same uuid — typically
    // the user's IDE Claude Code or a parallel `claude -p` job), we
    // rotate the uuid and retry once. Issue #27.
    const attempt = async (sessionId) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(`${currentAgent} request timed out.`), timeoutMs);
      try {
        return await api.runTerminalPrompt(currentAgent, text, {
          signal: controller.signal,
          timeoutMs: timeoutMs - 30_000,
          continueSession,
          sessionId,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      let sessionId = supportsContinuation && usesStickySession ? ensureSessionId(currentAgent) : null;
      let result = await attempt(sessionId);

      if (!result?.ok && usesStickySession && isSessionConflict(result?.error)) {
        // Session conflict — rotate the uuid and retry once. The user
        // loses cross-message continuity for this single turn but the
        // chat keeps working instead of dead-ending.
        delete agentSessions[currentAgent];
        saveAgentSessions();
        sessionId = ensureSessionId(currentAgent);
        addSystemMessage('Started a fresh session — the previous one was busy elsewhere.');
        result = await attempt(sessionId);
      }

      if (result?.ok) {
        addAssistantMessage(result.output || 'No output returned.', currentAgent);
        if (textContainsPermissionPrompt(result.output)) {
          addPermissionMessage('Approval prompt detected in agent output. Open Raw terminal to answer interactive prompts.');
        }
        try {
          window.dispatchEvent(new CustomEvent('catabull:data-maybe-changed', {
            detail: { source: 'chat', agent: currentAgent },
          }));
        } catch {}
        // For agents on the resume-last path (codex), mark the agent as
        // "seen" so the next turn requests continuation. Sticky-session
        // agents already had their uuid stamped via ensureSessionId.
        if (supportsContinuation && !usesStickySession && !agentSessions[currentAgent]) {
          agentSessions[currentAgent] = newSessionId();
          const record = ensureCurrentChatRecord();
          record.agent = currentAgent;
          record.sessionId = agentSessions[currentAgent];
          record.updatedAt = Date.now();
          saveAgentSessions();
          saveChatRecords();
        }
        return true;
      }
      hideWorkingMessage();
      if (textContainsPermissionPrompt(result?.error)) {
        addPermissionMessage(result.error);
        addSystemMessage('Approval required. Switch to Raw terminal to answer interactive prompts.', 'error');
        return false;
      }
      addSystemMessage(result?.error || `${currentAgent} request failed.`, 'error');
      return false;
    } catch (error) {
      hideWorkingMessage();
      addSystemMessage(error.message || `${currentAgent} request failed or timed out.`, 'error');
      return false;
    }
  }

  const wsDeadline = Date.now() + 12000;
  while (Date.now() < wsDeadline) {
    if (ws && ws.readyState === WebSocket.OPEN) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addSystemMessage('Could not connect to the terminal session.', 'error');
    return false;
  }

  // Wait for the agent to go quiescent before pasting the prompt, so the
  // slash command doesn't land mid-startup-output. Lower quiescentMs (700ms
  // vs the old 1800ms) makes the paste feel snappy without losing reliability.
  const waitStartedAt = Date.now();
  const deadline = waitStartedAt + readinessTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (lastOutputAt > waitStartedAt && (Date.now() - lastOutputAt) > quiescentMs) {
      ready = true;
      break;
    }
  }

  if (!ready) {
    logSystem('Agent still initializing, sending prompt anyway', 'error');
  }

  ws.send(JSON.stringify({ type: 'input', data: `${text}\r` }));
  return true;
}

export function isVisible() {
  return drawerVisible;
}

export function getCurrentAgent() {
  return currentAgent;
}

export async function init() {
  agentsReady = loadAgents();
  await agentsReady;

  withTranscriptPersistencePaused(() => {
    initChatUi(document.getElementById('chat-pane'), {
      onSubmit: submitFromChatView,
      onNewChat: resetChatSession,
      onListSessions: listSessionRecordsForMenu,
      onSelectSession: selectChatRecord,
      onMessagesChange: persistCurrentTranscript,
    });
    syncChatUiToCurrentAgent();
  });
  applyViewMode(currentView);

  const drawer = document.getElementById('terminal-drawer');
  if (drawer) drawer.classList.add('dock-right');

  const select = document.getElementById('agent-select');
  if (select && agents.length) {
    select.innerHTML = agents.map(agent => `<option value="${agent}"${agent === currentAgent ? ' selected' : ''}>${agent}</option>`).join('');
    select.value = currentAgent;
    select.onchange = (event) => {
      currentAgent = event.target.value;
      localStorage.setItem(AGENT_STORAGE_KEY, currentAgent);
      setChatAgent(currentAgent);
      clearSessionOutput({ resetChat: false });
      if (currentView === 'raw') {
        logSystem(`Switching to ${currentAgent}...`);
      }
      disconnectSession({ state: drawerVisible ? 'connecting' : 'disconnected' });
      if (drawerVisible) connect();
    };
  }

  document.getElementById('terminal-toggle')?.addEventListener('click', toggle);

  document.getElementById('terminal-view-chat')?.addEventListener('click', () => applyViewMode('chat'));
  document.getElementById('terminal-view-raw')?.addEventListener('click', () => applyViewMode('raw'));

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.key === '`') {
      event.preventDefault();
      toggle();
    }
  });

  if (shouldAutoOpenDrawer()) {
    setTimeout(() => { show({ persist: false }); }, 0);
  } else {
    hide({ persist: false });
  }
}
