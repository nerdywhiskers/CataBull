import { createAnsiLineParser, isPermissionLine, normalizeComparable } from '../lib/ansi.mjs';
import { renderMarkdown } from '../components/markdown.mjs';
import { listModes } from '../lib/modes.mjs';

const MAX_ECHO_AGE_MS = 30000;
const COMMAND_PREFIX = '/catabull';

let root = null;
let onSubmitPrompt = null;
let onNewChatRequest = null;
let messagesEl = null;
let formEl = null;
let inputEl = null;
let sendEl = null;
let newChatEl = null;
let suggestionsEl = null;
let currentAgent = '';
let messages = [];
let pendingEchoes = [];
let messageId = 0;
let visibleSuggestions = [];
let activeSuggestionIndex = -1;
let commandSuggestions = null;
let workingMessageId = null;

const parser = createAnsiLineParser(handleParsedLine);

function esc(value = '') {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function consumeEcho(line) {
  const now = Date.now();
  const normalized = normalizeComparable(line);
  pendingEchoes = pendingEchoes.filter(item => now - item.createdAt < MAX_ECHO_AGE_MS);
  const index = pendingEchoes.findIndex(item => item.line === normalized);
  if (index === -1) return false;
  pendingEchoes.splice(index, 1);
  return true;
}

function queueUserEchoes(text) {
  const createdAt = Date.now();
  const lines = text
    .split(/\r?\n/)
    .map(line => normalizeComparable(line))
    .filter(Boolean);
  pendingEchoes.push(...lines.map(line => ({ line, createdAt })));
}

function createMessage(role, text, meta = {}) {
  return { id: ++messageId, role, text, tone: meta.tone || 'default', agent: meta.agent || '' };
}

function removeMessageById(id) {
  if (!id) return;
  messages = messages.filter(message => message.id !== id);
}

function pushMessage(role, text, meta = {}) {
  messages.push(createMessage(role, text, meta));
  renderMessages();
}

function appendAssistantLine(line) {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') {
    last.text += `${last.text ? '\n' : ''}${line}`;
  } else {
    messages.push(createMessage('assistant', line, { agent: currentAgent }));
  }
  renderMessages();
}

function handleParsedLine(line) {
  if (!line) return;
  if (consumeEcho(line)) return;
  if (isPermissionLine(line)) {
    pushMessage('permission', line);
    return;
  }
  appendAssistantLine(line);
}

function renderMessage(message) {
  if (message.role === 'working') {
    return `
      <article class="chat-bubble assistant working">
        <div class="chat-meta">${esc(message.agent || currentAgent || 'assistant')}</div>
        <div class="chat-working">
          <span class="chat-working-label">${esc(message.text || 'Working')}</span>
          <span class="chat-working-dots" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </span>
        </div>
      </article>
    `;
  }

  if (message.role === 'assistant') {
    return `
      <article class="chat-bubble assistant">
        <div class="chat-meta">${esc(message.agent || currentAgent || 'assistant')}</div>
        <div class="chat-markdown markdown-body">${renderMarkdown(message.text)}</div>
      </article>
    `;
  }

  if (message.role === 'permission') {
    return `<div class="permission-chip">${esc(message.text)}</div>`;
  }

  if (message.role === 'system') {
    return `<div class="chat-system ${message.tone === 'error' ? 'error' : ''}">${esc(message.text)}</div>`;
  }

  return `
    <article class="chat-bubble user">
      <div class="chat-meta">you</div>
      <div class="chat-text">${esc(message.text)}</div>
    </article>
  `;
}

function renderMessages() {
  if (!messagesEl) return;
  messagesEl.innerHTML = messages.length
    ? messages.map(renderMessage).join('')
    : `
      <div class="chat-empty-state">
        <span class="chat-empty-icon" aria-hidden="true">
          <svg width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12h26a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H17l-7 7v-7H9a3 3 0 0 1-3-3V15a3 3 0 0 1 3-3z"/><circle cx="17" cy="22" r="1.6" fill="currentColor" stroke="none"/><circle cx="22" cy="22" r="1.6" fill="currentColor" stroke="none"/><circle cx="27" cy="22" r="1.6" fill="currentColor" stroke="none"/></svg>
        </span>
        <h3>Chat View</h3>
        <p>Send a prompt here or launch a mode from the dashboard. Raw terminal stays one click away.</p>
      </div>
    `;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function getCommandSuggestions() {
  if (commandSuggestions) return commandSuggestions;
  commandSuggestions = listModes().map((mode) => ({
    id: mode.id,
    command: `${COMMAND_PREFIX} ${mode.slash}`,
    description: mode.description,
    needsTarget: mode.needsTarget,
    targetKind: mode.targetKind,
    search: [mode.label, mode.description, mode.group, mode.slash, `${COMMAND_PREFIX} ${mode.slash}`]
      .join(' ')
      .toLowerCase(),
  }));
  return commandSuggestions;
}

function suggestionHint(item) {
  if (!item.needsTarget) return 'Runs immediately.';
  if (item.targetKind === 'url') return 'Add a job URL after the command.';
  if (item.targetKind === 'company') return 'Add a company name after the command.';
  if (item.targetKind === 'jd-text') return 'Paste the job text or prompt context after the command.';
  return 'Add any required context after the command.';
}

function escapeAttribute(value = '') {
  return esc(value).replace(/'/g, '&#39;');
}

function parseCommandQuery(value = '') {
  const [firstLine = ''] = value.split(/\r?\n/, 1);
  const query = firstLine.trim();
  if (!query.startsWith('/')) return null;

  const lower = query.toLowerCase();
  if (COMMAND_PREFIX.startsWith(lower)) {
    return '';
  }

  if (lower === COMMAND_PREFIX) {
    return '';
  }

  if (!lower.startsWith(`${COMMAND_PREFIX} `)) {
    return null;
  }

  return lower.slice(COMMAND_PREFIX.length + 1).trim();
}

function closeSuggestions() {
  visibleSuggestions = [];
  activeSuggestionIndex = -1;
  renderSuggestions();
}

function renderSuggestions() {
  if (!suggestionsEl) return;
  if (!visibleSuggestions.length) {
    suggestionsEl.hidden = true;
    suggestionsEl.innerHTML = '';
    return;
  }

  suggestionsEl.hidden = false;
  suggestionsEl.innerHTML = `
    <div class="chat-command-header">CataBull commands</div>
    <div class="chat-command-list" role="listbox" aria-label="CataBull commands">
      ${visibleSuggestions.map((item, index) => `
        <button
          type="button"
          class="chat-command-item${index === activeSuggestionIndex ? ' active' : ''}"
          data-command-index="${index}"
          data-command-value="${escapeAttribute(item.command)}"
          role="option"
          aria-selected="${index === activeSuggestionIndex ? 'true' : 'false'}"
        >
          <span class="chat-command-name">${esc(item.command)}</span>
          <span class="chat-command-desc">${esc(item.description)}</span>
          <span class="chat-command-hint">${esc(suggestionHint(item))}</span>
        </button>
      `).join('')}
    </div>
  `;
}

function updateSuggestions() {
  const query = parseCommandQuery(inputEl?.value || '');
  if (query === null) {
    closeSuggestions();
    return;
  }

  visibleSuggestions = getCommandSuggestions().filter((item) => (
    !query || item.search.includes(query)
  ));
  activeSuggestionIndex = visibleSuggestions.length ? 0 : -1;
  renderSuggestions();
}

function applySuggestion(index) {
  const item = visibleSuggestions[index];
  if (!item || !inputEl) return false;
  inputEl.value = item.command + (item.needsTarget ? ' ' : '');
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  closeSuggestions();
  return true;
}

function moveSuggestion(delta) {
  if (!visibleSuggestions.length) return false;
  const total = visibleSuggestions.length;
  activeSuggestionIndex = activeSuggestionIndex < 0
    ? 0
    : (activeSuggestionIndex + delta + total) % total;
  renderSuggestions();
  return true;
}

function bindComposer() {
  if (!formEl || !inputEl || !sendEl || !suggestionsEl) return;

  formEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = inputEl.value.trim();
    if (!value || !onSubmitPrompt) return;
    inputEl.value = '';
    closeSuggestions();
    await onSubmitPrompt(value);
  });

  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && visibleSuggestions.length) {
      event.preventDefault();
      moveSuggestion(1);
      return;
    }

    if (event.key === 'ArrowUp' && visibleSuggestions.length) {
      event.preventDefault();
      moveSuggestion(-1);
      return;
    }

    if ((event.key === 'Enter' || event.key === 'Tab') && visibleSuggestions.length && activeSuggestionIndex >= 0) {
      event.preventDefault();
      applySuggestion(activeSuggestionIndex);
      return;
    }

    if (event.key === 'Escape' && visibleSuggestions.length) {
      event.preventDefault();
      closeSuggestions();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      formEl.requestSubmit();
    }
  });

  inputEl.addEventListener('input', updateSuggestions);
  inputEl.addEventListener('focus', updateSuggestions);

  suggestionsEl.addEventListener('mousedown', (event) => {
    const button = event.target.closest('[data-command-index]');
    if (!button) return;
    event.preventDefault();
    applySuggestion(Number(button.dataset.commandIndex));
  });
}

export function init(container, { onSubmit, onNewChat } = {}) {
  root = container;
  onSubmitPrompt = onSubmit || null;
  onNewChatRequest = onNewChat || null;

  if (!root) return;
  root.innerHTML = `
    <div class="chatui-shell">
      <div class="chat-messages" id="chat-messages"></div>
      <form class="chat-composer" id="chat-composer">
        <textarea id="chat-composer-input" class="form-textarea chat-composer-input" placeholder="Ask CataBull something or type /catabull to show a list of commands" rows="3"></textarea>
        <div class="chat-command-suggestions" id="chat-command-suggestions" hidden></div>
        <div class="chat-composer-actions">
          <button type="button" class="btn btn-ghost btn-sm chat-new-btn" id="chat-new-btn" title="Start a new chat">+ New</button>
          <span class="chat-composer-hint">Enter to send, Shift+Enter for a new line.</span>
          <button type="submit" class="btn btn-primary btn-sm" id="chat-composer-send">Send</button>
        </div>
      </form>
    </div>
  `;

  messagesEl = root.querySelector('#chat-messages');
  formEl = root.querySelector('#chat-composer');
  inputEl = root.querySelector('#chat-composer-input');
  sendEl = root.querySelector('#chat-composer-send');
  newChatEl = root.querySelector('#chat-new-btn');
  suggestionsEl = root.querySelector('#chat-command-suggestions');

  bindComposer();
  if (newChatEl) {
    newChatEl.addEventListener('click', () => {
      if (typeof onNewChatRequest === 'function') onNewChatRequest();
    });
  }
  renderMessages();
}

export function reset(agent = '') {
  currentAgent = agent || currentAgent;
  messages = [];
  pendingEchoes = [];
  workingMessageId = null;
  parser.reset();
  renderMessages();
}

export function setAgent(agent) {
  currentAgent = agent || '';
}

export function addUserMessage(text) {
  queueUserEchoes(text);
  pushMessage('user', text);
}

export function addSystemMessage(text, tone = 'default') {
  pushMessage('system', text, { tone });
}

export function addAssistantMessage(text, agent = '') {
  if (!text) return;
  hideWorkingMessage();
  pushMessage('assistant', text, { agent: agent || currentAgent });
}

export function showWorkingMessage(text = 'Working', agent = '') {
  hideWorkingMessage();
  const message = createMessage('working', text, { agent: agent || currentAgent });
  workingMessageId = message.id;
  messages.push(message);
  renderMessages();
}

export function hideWorkingMessage() {
  if (!workingMessageId) return;
  removeMessageById(workingMessageId);
  workingMessageId = null;
  renderMessages();
}

export function handleOutput(chunk) {
  parser.push(chunk);
}

export function handleError(text) {
  hideWorkingMessage();
  addSystemMessage(text, 'error');
}

export function handleExit(code) {
  addSystemMessage(`Session ended (exit code: ${code})`);
}

export function focusInput() {
  inputEl?.focus();
}
