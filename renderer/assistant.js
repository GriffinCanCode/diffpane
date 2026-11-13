import DOMPurify from 'dompurify';
import { marked } from 'marked';
import './assistant.css';

const keyUrl = 'https://platform.claude.com/settings/keys';
const settingsIcon =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11m-11 4h11m-11 4h11"/><path d="M5 2.5v3m6 1v3m-5 1v3" stroke-width="1.7"/></svg>';
const resetIcon =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true"><path d="M3 6a5 5 0 1 1 .6 5.5M3 3v3h3"/></svg>';
const closeIcon =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>';

function message(error) {
  return String(error?.message ?? error).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/u,
    '',
  );
}

function showNotice(element, text, error = false) {
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle('is-error', error);
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function createAssistant(
  container,
  toggle,
  { claude, openExternal },
  { prepareSend, applyEdit, onOpen },
) {
  container.className = 'claude-panel';
  container.setAttribute('aria-labelledby', 'claude-title');
  container.innerHTML = `
    <header class="claude-heading">
      <h2 id="claude-title">Claude</h2>
      <div class="claude-tools">
        <button type="button" class="claude-icon" data-action="reset" aria-label="New conversation" title="New conversation">${resetIcon}</button>
        <button type="button" class="claude-icon" data-action="settings" aria-label="Claude settings" title="Claude settings">${settingsIcon}</button>
        <button type="button" class="claude-icon" data-action="close" aria-label="Close Claude" title="Close Claude">${closeIcon}</button>
      </div>
    </header>
    <div class="claude-conversation" role="log" aria-label="Conversation" tabindex="0">
      <div class="claude-empty">
        <p></p>
        <button type="button" class="claude-button" data-action="connect" hidden>Set up API key</button>
      </div>
      <div class="claude-turns"></div>
      <p class="claude-working" role="status" hidden></p>
    </div>
    <p class="claude-notice" role="status" hidden></p>
    <form class="claude-composer">
      <p class="claude-context" hidden></p>
      <textarea aria-label="Message Claude" rows="3" maxlength="8000" placeholder="Ask about this codebase"></textarea>
      <div class="claude-composer-actions">
        <div class="claude-mode" role="group" aria-label="Request mode">
          <button type="button" data-mode="ask" aria-pressed="true" title="Ask a read-only question">Ask</button>
          <button type="button" data-mode="edit" aria-pressed="false" title="Propose an edit for review">Edit</button>
        </div>
        <button class="claude-button claude-primary" type="submit">Send</button>
        <button class="claude-button" type="button" data-action="stop" hidden>Stop</button>
      </div>
    </form>`;
  const settings = node('dialog', 'claude-settings');
  settings.id = 'claude-settings';
  settings.setAttribute('aria-labelledby', 'claude-settings-title');
  settings.innerHTML = `
    <header class="claude-heading">
      <h2 id="claude-settings-title">Claude settings</h2>
      <button type="button" class="claude-icon" aria-label="Close Claude settings">${closeIcon}</button>
    </header>
    <form>
      <p class="claude-settings-status" role="status"></p>
      <label for="claude-api-key">API key</label>
      <input id="claude-api-key" type="password" autocomplete="off" spellcheck="false" maxlength="2048" placeholder="sk-ant-…" />
      <p class="claude-settings-hint">Use a workspace-scoped Claude API key. <a href="${keyUrl}">Get an API key</a></p>
      <p class="claude-settings-hint">DiffPane encrypts the key using your system’s credential protection. Your prompts and relevant project files are sent to Claude when you send a message.</p>
      <p class="claude-settings-notice" role="status" hidden></p>
      <div class="claude-settings-actions">
        <button type="submit" class="claude-button claude-primary">Save API key</button>
        <button type="button" class="claude-button claude-remove" hidden>Remove key</button>
        <button type="button" class="claude-button claude-done">Done</button>
      </div>
    </form>`;
  document.body.append(settings);

  const select = selector => container.querySelector(selector);
  const action = name => select(`[data-action="${name}"]`);
  const conversation = select('.claude-conversation');
  const turns = select('.claude-turns');
  const empty = select('.claude-empty');
  const emptyText = empty.querySelector('p');
  const working = select('.claude-working');
  const context = select('.claude-context');
  const notice = select('.claude-notice');
  const composer = select('.claude-composer');
  const promptInput = composer.querySelector('textarea');
  const send = composer.querySelector('[type="submit"]');
  const stop = action('stop');
  const modes = [...composer.querySelectorAll('[data-mode]')];
  const keyInput = settings.querySelector('input');
  const saveKey = settings.querySelector('[type="submit"]');
  const removeKey = settings.querySelector('.claude-remove');
  const closeSettings = settings.querySelector('.claude-icon');
  const settingsStatus = settings.querySelector('.claude-settings-status');
  const settingsNotice = settings.querySelector('.claude-settings-notice');

  let connection;
  let checking = false;
  let changingKey = false;
  let mode = 'ask';
  let workspace = false;
  let path = null;
  let busy = '';
  let canceled = false;
  let pending = null;
  let connectionGeneration = 0;

  function render() {
    const connected = connection?.configured === true;
    const hasTurns = turns.childElementCount > 0;
    const canChat = workspace && connected && !busy && !changingKey && !pending;
    empty.hidden = hasTurns;
    emptyText.textContent =
      !connection && checking
        ? 'Checking Claude connection…'
        : !connected
          ? 'Connect Claude with an API key to get started.'
          : !workspace
            ? 'Open a file or folder to ask Claude about a project.'
            : 'Ask about this project or switch to Edit to propose a small change.';
    action('connect').hidden = connected || checking;
    action('reset').disabled = (!hasTurns && !promptInput.value) || Boolean(busy) || changingKey;
    context.hidden = !path;
    context.textContent = path ? `Open file · ${path}` : '';
    context.title = path ?? '';
    promptInput.disabled = !canChat;
    promptInput.placeholder =
      mode === 'edit' ? 'Describe a small change' : 'Ask about this codebase';
    for (const button of modes) {
      button.disabled = !canChat;
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    }
    send.disabled = !canChat || !promptInput.value.trim();
    send.hidden = busy === 'send';
    stop.hidden = busy !== 'send';
    stop.disabled = canceled;
    working.hidden = busy !== 'send';
    working.textContent = canceled ? 'Stopping…' : 'Claude is working…';
    if (pending)
      for (const button of pending.controls.querySelectorAll('button'))
        button.disabled = Boolean(busy) || changingKey;
    keyInput.disabled = checking || changingKey || Boolean(busy) || !connection?.secureStorage;
    saveKey.disabled = keyInput.disabled || !keyInput.value.trim();
    saveKey.textContent = connected ? 'Replace API key' : 'Save API key';
    removeKey.hidden = !connected;
    removeKey.disabled = checking || changingKey || Boolean(busy);
    settingsStatus.textContent = changingKey
      ? 'Updating API key…'
      : checking
        ? 'Checking secure storage…'
        : !connection
          ? ''
          : !connection.secureStorage
            ? 'Secure credential storage is unavailable.'
            : connected
              ? 'API key configured.'
              : 'No API key saved.';
  }

  function scrollToLatest() {
    conversation.scrollTop = conversation.scrollHeight;
  }

  function addTurn(author, text) {
    const turn = node('article', 'claude-turn');
    turn.dataset.author = author;
    const label = node('h3', 'claude-author', author);
    const body = node('div', 'claude-turn-content');
    if (author === 'Claude') {
      body.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true }), {
        ALLOWED_TAGS: [
          'p',
          'br',
          'strong',
          'em',
          's',
          'code',
          'pre',
          'ul',
          'ol',
          'li',
          'blockquote',
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
          'hr',
          'table',
          'thead',
          'tbody',
          'tr',
          'th',
          'td',
        ],
        ALLOWED_ATTR: [],
        ALLOW_ARIA_ATTR: false,
        ALLOW_DATA_ATTR: false,
      });
    } else body.textContent = text;
    turn.append(label, body);
    turns.append(turn);
    return turn;
  }

  function showProposal(proposal) {
    const card = node('section', 'claude-proposal');
    card.append(node('h3', 'claude-proposal-title', 'Proposed edit'));
    const filename = node('p', 'claude-proposal-path', proposal.path);
    filename.title = proposal.path;
    card.append(filename);
    for (const [label, text] of [
      ['Before', proposal.before],
      ['After', proposal.after],
    ]) {
      const snippet = node('div', 'claude-snippet');
      snippet.dataset.change = label.toLowerCase();
      snippet.append(node('h4', '', label), node('pre', '', text || 'Empty'));
      card.append(snippet);
    }
    const controls = node('div', 'claude-proposal-controls');
    const apply = node('button', 'claude-button claude-primary', 'Apply edit');
    const discard = node('button', 'claude-button', 'Discard edit');
    apply.type = discard.type = 'button';
    apply.addEventListener('click', () => void resolveProposal(true));
    discard.addEventListener('click', () => void resolveProposal(false));
    controls.append(apply, discard);
    card.append(controls);
    turns.append(card);
    pending = { proposal, controls };
  }

  async function resolveProposal(apply) {
    if (!pending || busy || changingKey) return;
    const { proposal, controls } = pending;
    const generation = connectionGeneration;
    busy = apply ? 'apply' : 'discard';
    showNotice(notice, '');
    render();
    try {
      if (apply) await applyEdit(proposal);
      else await claude.discard(proposal.id);
      if (generation !== connectionGeneration) return;
      controls.replaceChildren(node('span', 'claude-resolution', apply ? 'Applied' : 'Discarded'));
      pending = null;
    } catch (error) {
      if (generation === connectionGeneration) showNotice(notice, message(error), true);
    } finally {
      busy = '';
      render();
      if (!pending && !container.hidden && !settings.open) promptInput.focus();
    }
  }

  async function checkConnection() {
    if (checking || changingKey) return;
    checking = true;
    const generation = connectionGeneration;
    render();
    try {
      const status = await claude.status();
      if (generation === connectionGeneration) connection = status;
    } catch (error) {
      if (generation === connectionGeneration)
        showNotice(settings.open ? settingsNotice : notice, message(error), true);
    } finally {
      checking = false;
      render();
      if (settings.open && document.activeElement === closeSettings && !keyInput.disabled)
        keyInput.focus();
      else if (
        !settings.open &&
        !container.hidden &&
        document.activeElement === action('settings') &&
        !promptInput.disabled
      )
        promptInput.focus();
    }
  }

  function togglePanel(open = container.hidden, restoreFocus = true) {
    container.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      onOpen?.();
      scrollToLatest();
      (promptInput.disabled ? action('settings') : promptInput).focus();
      void checkConnection();
    } else if (restoreFocus) toggle.focus();
  }

  function openSettings() {
    showNotice(settingsNotice, '');
    settings.showModal();
    void checkConnection();
  }

  function clearConversation() {
    pending = null;
    promptInput.value = '';
    turns.replaceChildren();
    showNotice(notice, '');
  }

  const unsubscribeReset = claude.onReset(status => {
    connectionGeneration++;
    connection = status;
    clearConversation();
    render();
  });

  async function updateKey(save) {
    if (checking || busy || changingKey || (save ? saveKey.disabled : removeKey.disabled)) return;
    const key = keyInput.value.trim();
    keyInput.value = '';
    changingKey = true;
    showNotice(settingsNotice, '');
    render();
    try {
      await (save ? claude.saveKey(key) : claude.removeKey());
      showNotice(settingsNotice, save ? 'API key saved.' : 'API key removed.');
    } catch (error) {
      showNotice(settingsNotice, message(error), true);
    } finally {
      changingKey = false;
      render();
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (send.disabled || busy) return;
    const prompt = promptInput.value.trim();
    const request = { prompt, path: path ?? undefined, proposeEdits: mode === 'edit' };
    const generation = connectionGeneration;
    busy = 'send';
    canceled = false;
    showNotice(notice, '');
    const turn = addTurn('You', prompt);
    promptInput.value = '';
    render();
    scrollToLatest();
    try {
      await prepareSend(request.path);
      if (generation !== connectionGeneration) return;
      if (canceled) {
        turn.remove();
        promptInput.value = prompt;
        return;
      }
      const response = await claude.send(request);
      if (generation !== connectionGeneration) return;
      if (response.text) addTurn('Claude', response.text);
      if (response.proposal) showProposal(response.proposal);
    } catch (error) {
      if (generation !== connectionGeneration) return;
      turn.remove();
      promptInput.value = prompt;
      if (!canceled) showNotice(notice, message(error), true);
    } finally {
      const focused =
        composer.contains(document.activeElement) || document.activeElement === document.body;
      busy = '';
      canceled = false;
      render();
      scrollToLatest();
      if (focused && !container.hidden && !settings.open)
        (pending?.controls.querySelector('button') ?? promptInput).focus();
    }
  }

  toggle.addEventListener('click', () => togglePanel());
  action('close').addEventListener('click', () => togglePanel(false));
  for (const name of ['settings', 'connect']) action(name).addEventListener('click', openSettings);
  action('reset').addEventListener('click', async () => {
    busy = 'reset';
    render();
    try {
      await claude.reset();
      clearConversation();
    } catch (error) {
      showNotice(notice, message(error), true);
    } finally {
      busy = '';
      render();
      if (!container.hidden && !settings.open) promptInput.focus();
    }
  });
  stop.addEventListener('click', () => {
    canceled = true;
    render();
    void claude.cancel().catch(error => showNotice(notice, message(error), true));
  });
  container.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      togglePanel(false);
    }
  });
  for (const button of modes)
    button.addEventListener('click', () => {
      mode = button.dataset.mode;
      render();
      promptInput.focus();
    });
  composer.addEventListener('submit', sendMessage);
  promptInput.addEventListener('input', render);
  promptInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  settings.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    void updateKey(true);
  });
  keyInput.addEventListener('input', render);
  removeKey.addEventListener('click', () => void updateKey(false));
  for (const button of [closeSettings, settings.querySelector('.claude-done')])
    button.addEventListener('click', () => settings.close());
  settings.querySelector('a').addEventListener('click', event => {
    event.preventDefault();
    void openExternal(keyUrl).catch(error => showNotice(settingsNotice, message(error), true));
  });
  settings.addEventListener('close', () => {
    keyInput.value = '';
    render();
  });
  render();
  toggle.hidden = false;
  return {
    setContext(hasWorkspace, activePath) {
      if (workspace === hasWorkspace && path === activePath) return;
      workspace = hasWorkspace;
      path = activePath;
      render();
    },
    toggle: togglePanel,
    dispose: unsubscribeReset,
  };
}
