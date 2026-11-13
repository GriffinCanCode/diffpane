// MONOLITHIC: The panel reconciles streamed activity, the selected context and proposal actions against one request lifecycle. Extract the activity view once its updates can be verified without sharing panel state.
import { attemptAsync } from '../../../shared/recovery/app-errors.ts'
import { reportError, runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import { createEditProposal, createToolActivity, renderAssistantMarkdown } from './assistant-content.js'
import { creatureGlyph } from './creature-glyph.ts'
import './assistant.css'

/**
 * @import { ClaudePrompt } from '../../../electron/tools/assistant/claude-session.mjs'
 * @import { DiffpaneApi } from '../../../electron/runtime/window/preload.ts'
 * @import { Proposal, FileTarget } from './assistant-content.js'
 */
/** @typedef {NonNullable<ClaudePrompt['fileContext']>} FileContext */
/** @typedef {Awaited<ReturnType<DiffpaneApi['claude']['status']>>} Connection */
/** @typedef {{id: string, title: string}} IdeaAttachment */
/** @typedef {{body: HTMLElement, text: string, frame: number, complete: boolean}} ReplyText */
/** @typedef {{id: string, turn: HTMLElement, reply: HTMLElement, sections: HTMLElement, working: HTMLElement, paragraphs: Map<number, ReplyText>, tools: Map<string, ReturnType<typeof createToolActivity>>, toolGroup?: ReturnType<typeof createToolActivity>, started: boolean, stopping: boolean}} SendState */

const KEY_URL = 'https://platform.claude.com/settings/keys'
const CREATURE_SIGN_OFF = 'I am the creature.'
const ICONS = {
  new: '<path d="M8 3.25v9.5m-4.75-4.75h9.5"/>',
  settings: '<path d="M2.75 4h10.5m-10.5 4h10.5m-10.5 4h10.5M5.25 2.5v3m5.5 1v3m-5.5 1v3"/>',
  close: '<path d="m4 4 8 8m0-8-8 8"/>',
  up: '<path d="M8 12.75v-9.5m-3.75 3.75L8 3.25 11.75 7"/>',
  down: '<path d="M8 3.25v9.5m-3.75-3.75L8 12.75 11.75 9"/>',
  next: '<path d="M3.25 8h9.5M9 4.25 12.75 8 9 11.75"/>',
  stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.1" fill="currentColor" stroke="none"/>',
  file: '<path d="M9 2.5H4.75A1.25 1.25 0 0 0 3.5 3.75v8.5a1.25 1.25 0 0 0 1.25 1.25h6.5a1.25 1.25 0 0 0 1.25-1.25V6L9 2.5Z"/><path d="M9 2.5V6h3.5"/>',
  idea: '<path d="M5.75 10.25c0-1.3-1.5-1.9-1.5-3.9a3.75 3.75 0 0 1 7.5 0c0 2-1.5 2.6-1.5 3.9m-4.5 0h4.5m-3.8 2.25h3.1m-2.1 1.75h1.1"/>',
  check: '<path d="m3.75 8.25 2.6 2.6 5.9-5.9"/>',
}

/** @param {keyof typeof ICONS} name */
function icon(name) {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
}

/** @template {keyof HTMLElementTagNameMap} Tag
 * @param {Tag} tag
 * @param {string} className
 * @param {string} [text]
 */
function node(tag, className, text) {
  const element = document.createElement(tag)
  element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

/** @param {HTMLElement} element @param {string} [text] */
function showNotice(element, text = '') {
  element.textContent = text
  element.hidden = !text
}

/** @param {HTMLElement} element @param {Error} error */
function showFailure(element, error) {
  reportError(error, { silent: true })
  showNotice(element, error.message)
}

/** @param {FileContext} file */
function fileLabel(file) {
  const name = file.path.split('/').at(-1) ?? file.path
  const lines = file.startLine
    ? `:${file.startLine}${file.endLine && file.endLine !== file.startLine ? `–${file.endLine}` : ''}`
    : ''
  return `${name}${lines}${file.side === 'head' ? ' · HEAD' : ''}`
}

/**
 * @param {HTMLElement} container
 * @param {HTMLButtonElement} toggle
 * @param {Pick<DiffpaneApi, 'claude' | 'openExternal'>} api
 * @param {{prepareSend: (request: ClaudePrompt) => unknown, getFileContext: () => FileContext | null, openFile?: (target: FileTarget) => unknown, openIdea?: (id: string) => unknown, applyEdit: (proposal: Proposal) => unknown, onOpen?: () => void, colorize?: (text: string, language: string) => string | PromiseLike<string>}} options
 */
export function createAssistant(
  container,
  toggle,
  { claude, openExternal },
  { prepareSend, getFileContext, openFile, openIdea, applyEdit, onOpen, colorize },
) {
  container.className = 'claude-panel'
  container.setAttribute('aria-labelledby', 'claude-title')
  container.innerHTML = `
    <header class="claude-heading">
      <h2 id="claude-title"><span class="claude-brand">${creatureGlyph}</span>The Creature</h2>
      <div class="claude-tools">
        <button type="button" class="claude-icon" data-action="reset" aria-label="New conversation" title="New conversation">${icon('new')}</button>
        <button type="button" class="claude-icon" data-action="settings" aria-label="Creature settings" title="Creature settings" aria-haspopup="dialog">${icon('settings')}</button>
        <button type="button" class="claude-icon" data-action="close" aria-label="Close the Creature panel" title="Close the Creature panel">${icon('close')}</button>
      </div>
    </header>
    <div class="claude-transcript">
      <div class="claude-conversation" role="log" aria-live="off" aria-label="Conversation" tabindex="0">
        <div class="claude-empty">
          <div class="claude-empty-scene" aria-hidden="true">
            <svg viewBox="0 0 110 65" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <path class="claude-scene-paper" d="m54 20 24-8 14 7 8 27a3 3 0 0 1-2 4L69 59a3 3 0 0 1-4-2Z"/>
              <path class="claude-scene-paper" d="m78 12 3 11 11-4"/>
              <path class="claude-scene-lines" d="m70 34 17-5m-15 12 17-5m-15 12 10-3"/>
              <path class="claude-scene-creature" d="M9 37c0-6 3-11 7-14l-2-11 12 7a26 26 0 0 1 12 0l12-7-2 11c4 3 7 8 7 14 0 11-10 17-23 17S9 48 9 37Z"/>
              <path class="claude-scene-highlight" d="M14 35c1-4 3-7 6-9m-1-7 2 5m25-6-1 6"/>
              <path d="M23 35h.1m18 0h.1" stroke="currentColor" stroke-width="4"/>
              <path d="M28.5 43q3.5 3.5 7 0" stroke="currentColor" stroke-width="1.8"/>
            </svg>
          </div>
          <h3></h3>
          <p></p>
          <div class="claude-starters"></div>
          <button type="button" class="claude-button claude-primary" data-action="connect" hidden>Set up API key ${icon('next')}</button>
        </div>
        <div class="claude-turns"></div>
      </div>
      <button class="claude-jump" type="button" data-action="jump" hidden>${icon('down')} Latest</button>
    </div>
    <p class="claude-notice" role="alert" hidden></p>
    <div class="claude-sr-only" role="status"></div>
    <form class="claude-composer">
      <div class="claude-compose-surface">
        <div class="claude-context">
          <button type="button" class="claude-context-chip" data-action="file" aria-pressed="true" hidden>${icon('file')}<span></span></button>
          <div class="claude-context-chip claude-idea" hidden>${icon('idea')}<span></span><button type="button" class="claude-chip-remove" data-action="remove-idea" aria-label="Remove attached idea" title="Remove attached idea">${icon('close')}</button></div>
        </div>
        <div class="claude-input">
          <textarea aria-label="Message the Creature" rows="2" maxlength="8000" placeholder="What should I look into?"></textarea>
          <div class="claude-composer-actions">
            <div class="claude-mode" role="group" aria-label="Request mode">
              <button type="button" data-mode="ask" aria-pressed="true" title="Read files and ideas">Ask</button>
              <button type="button" data-mode="edit" aria-pressed="false" title="Propose file or idea changes for review">Edit</button>
            </div>
            <button class="claude-send" type="submit" aria-label="Send message" title="Send message">${icon('up')}</button>
            <button class="claude-send claude-stop" type="button" data-action="stop" aria-label="Stop response" title="Stop response" hidden>${icon('stop')}</button>
          </div>
        </div>
      </div>
    </form>`
  const settings = node('dialog', 'claude-settings')
  settings.id = 'claude-settings'
  settings.setAttribute('aria-labelledby', 'claude-settings-title')
  settings.innerHTML = `
    <header class="claude-heading">
      <h2 id="claude-settings-title"><span class="claude-brand">${creatureGlyph}</span>Creature settings</h2>
      <button type="button" class="claude-icon" aria-label="Close Creature settings">${icon('close')}</button>
    </header>
    <form>
      <p class="claude-settings-status" role="status"></p>
      <label for="claude-api-key">API key</label>
      <input id="claude-api-key" type="password" autocomplete="off" spellcheck="false" maxlength="2048" placeholder="sk-ant-…" />
      <p class="claude-settings-hint">Use a workspace-scoped Claude API key. Diffpane stores it with your system’s credential protection.</p>
      <a class="claude-settings-link" href="${KEY_URL}">Get an API key ${icon('next')}</a>
      <p class="claude-settings-notice" role="status" hidden></p>
      <div class="claude-settings-actions">
        <button type="submit" class="claude-button claude-primary">Save API key</button>
        <button type="button" class="claude-button claude-remove" hidden>Remove key</button>
        <button type="button" class="claude-button claude-done">Done</button>
      </div>
    </form>`
  document.body.append(settings)

  /** @param {string} selector */
  function select(selector) {
    return requireElement(container, selector, HTMLElement)
  }
  /** @param {string} name */
  function action(name) {
    return requireElement(container, `[data-action="${name}"]`, HTMLButtonElement)
  }
  const conversation = select('.claude-conversation')
  const turns = select('.claude-turns')
  const empty = select('.claude-empty')
  const emptyTitle = requireElement(empty, 'h3', HTMLHeadingElement)
  const emptyText = requireElement(empty, 'p', HTMLParagraphElement)
  const starters = requireElement(empty, '.claude-starters', HTMLDivElement)
  const fileChip = action('file')
  const fileName = requireElement(fileChip, 'span', HTMLSpanElement)
  const ideaChip = select('.claude-idea')
  const ideaLabel = requireElement(ideaChip, 'span', HTMLSpanElement)
  const notice = select('.claude-notice')
  const announcement = select('.claude-sr-only')
  const composer = requireElement(container, '.claude-composer', HTMLFormElement)
  const composerInput = requireElement(composer, '.claude-input', HTMLDivElement)
  const promptInput = requireElement(composer, 'textarea', HTMLTextAreaElement)
  const send = requireElement(composer, '[type="submit"]', HTMLButtonElement)
  const stop = action('stop')
  const jump = action('jump')
  const modes = [...composer.querySelectorAll('button')].filter(button => button.dataset.mode)
  const keyInput = requireElement(settings, 'input', HTMLInputElement)
  const saveKey = requireElement(settings, '[type="submit"]', HTMLButtonElement)
  const removeKey = requireElement(settings, '.claude-remove', HTMLButtonElement)
  const closeSettings = requireElement(settings, '.claude-icon', HTMLButtonElement)
  const settingsStatus = requireElement(settings, '.claude-settings-status', HTMLParagraphElement)
  const settingsNotice = requireElement(settings, '.claude-settings-notice', HTMLParagraphElement)
  const settingsForm = requireElement(settings, 'form', HTMLFormElement)
  const listeners = new AbortController()
  const listenerOptions = { signal: listeners.signal }

  /** @type {Connection | undefined} */
  let connection
  let checking = false
  let changingKey = false
  let mode = 'ask'
  let workspace = false
  /** @type {string | null} */
  let workspaceId = null
  let includeFile = true
  let busy = ''
  /** @type {SendState | null} */
  let activeSend = null
  /** @type {{proposal: Proposal, card: HTMLElement, controls: HTMLElement} | null} */
  let pending = null
  /** @type {IdeaAttachment | null} */
  let attachedIdea = null
  let connectionGeneration = 0
  let following = true
  let starterContext = ''
  /** @type {HTMLElement | null} */
  let settingsOpener = null

  /** @param {string} status */
  function renderStarters(status) {
    if (starterContext === status) return
    starterContext = status
    const prompts = {
      idea: [
        ['Review this idea', 'Review this idea. What is clear, and what still needs a decision?'],
        ['Outline a plan', 'Turn this idea into a short implementation plan.'],
      ],
      file: [
        ['Explain this file', 'Explain how the open file works. Point me to the relevant code.'],
        ['Review this file', 'Review the open file for correctness and point out anything that needs attention.'],
      ],
      project: [
        ['Get oriented', 'Give me a short tour of this project and tell me where to start reading.'],
        ['Find my ideas', 'What ideas are in this workspace?'],
      ],
    }
    const choices = status === 'idea' || status === 'file' || status === 'project' ? prompts[status] : []
    starters.replaceChildren(
      ...choices.map(([label, prompt]) => {
        const button = node('button', 'claude-starter', label)
        button.type = 'button'
        button.dataset.prompt = prompt
        button.insertAdjacentHTML('beforeend', icon('next'))
        return button
      }),
    )
  }

  function render() {
    if (listeners.signal.aborted) return
    const connected = connection?.configured === true
    const checkingConnection = !connection && checking
    const hasTurns = turns.childElementCount > 0
    const canDraft = workspace && connected
    const locked = Boolean(busy || changingKey || pending)
    const currentFile = getFileContext()
    const context = attachedIdea ? 'idea' : currentFile && includeFile ? 'file' : 'project'
    empty.hidden = hasTurns
    empty.toggleAttribute('data-checking', checkingConnection)
    emptyTitle.textContent = checkingConnection
      ? 'Checking connection…'
      : !connected
        ? 'Meet the Creature'
        : !workspace
          ? 'Open a project to start'
          : context === 'idea'
            ? 'Let’s work through this idea'
            : 'What are we figuring out?'
    emptyText.textContent = checkingConnection
      ? ''
      : !connected
        ? 'I live in your code. Set up a Claude API key so we can talk about it.'
        : !workspace
          ? 'Open a project so I can look around.'
          : context === 'idea'
            ? ''
            : 'I live in your code and help you figure things out.'
    emptyText.hidden = !emptyText.textContent
    action('connect').hidden = connected || checking
    renderStarters(canDraft && !hasTurns ? context : '')
    action('reset').disabled = (!hasTurns && !promptInput.value && !attachedIdea) || Boolean(busy) || changingKey
    fileChip.hidden = !currentFile || !canDraft
    fileChip.disabled = locked
    fileChip.setAttribute('aria-pressed', String(includeFile))
    if (currentFile) {
      fileName.textContent = fileLabel(currentFile)
      fileChip.title = `${includeFile ? 'Exclude' : 'Include'} open file context · ${currentFile.path}`
      fileChip.setAttribute('aria-label', `Use open file context for ${fileLabel(currentFile)}`)
    }
    ideaChip.hidden = !attachedIdea
    ideaLabel.textContent = attachedIdea?.title ?? ''
    ideaLabel.title = ideaLabel.textContent
    action('remove-idea').disabled = locked
    composer.hidden = !canDraft && !attachedIdea
    composerInput.hidden = !canDraft
    promptInput.readOnly = locked
    promptInput.disabled = !canDraft
    promptInput.placeholder = pending
      ? 'Review the proposal to continue'
      : mode === 'edit'
        ? 'Describe a change'
        : attachedIdea
          ? 'What should I look for in this idea?'
          : 'What should I look into?'
    for (const button of modes) {
      button.disabled = !canDraft || locked
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
    }
    send.disabled = !canDraft || locked || !promptInput.value.trim()
    send.hidden = Boolean(activeSend)
    stop.hidden = !activeSend
    stop.disabled = activeSend?.stopping ?? false
    if (pending) {
      for (const button of pending.controls.querySelectorAll('button')) {
        button.disabled = Boolean(busy) || changingKey
      }
    }
    keyInput.disabled = checking || changingKey || Boolean(busy) || !connection?.secureStorage
    saveKey.disabled = keyInput.disabled || !keyInput.value.trim()
    saveKey.textContent = connected ? 'Replace API key' : 'Save API key'
    removeKey.hidden = !connected
    removeKey.disabled = checking || changingKey || Boolean(busy)
    settingsStatus.toggleAttribute('data-loading-status', changingKey || checking)
    settingsStatus.textContent = changingKey
      ? 'Updating API key…'
      : checking
        ? 'Checking secure storage…'
        : !connection
          ? ''
          : !connection.secureStorage
            ? 'Secure credential storage is unavailable.'
            : connected
              ? 'API key configured'
              : 'No API key saved'
  }

  function resizeDraft() {
    promptInput.style.height = ''
    promptInput.style.height = `${promptInput.scrollHeight}px`
  }

  function syncScroll() {
    const distance = conversation.scrollHeight - conversation.clientHeight - conversation.scrollTop
    following = distance < 32
    jump.hidden = following || !turns.childElementCount
  }

  function updateScroll() {
    if (container.hidden) return
    if (following) conversation.scrollTop = conversation.scrollHeight
    syncScroll()
  }

  const viewportObserver = new ResizeObserver(updateScroll)
  viewportObserver.observe(conversation)

  function scrollToLatest() {
    following = true
    updateScroll()
  }

  function focusDraft() {
    if (!listeners.signal.aborted && !container.hidden && !settings.open)
      (promptInput.disabled ? action('settings') : promptInput).focus()
  }

  /** @param {string} prompt @param {FileContext | undefined} file @param {IdeaAttachment | null} idea */
  function addTurn(prompt, file, idea) {
    const turn = node('article', 'claude-turn')
    turn.dataset.author = 'You'
    turn.setAttribute('aria-label', 'You')
    if (file || idea) {
      const context = node('div', 'claude-turn-context')
      if (file) {
        const label = node('span', 'claude-turn-tag')
        label.innerHTML = icon('file')
        label.append(fileLabel(file))
        label.title = file.path
        context.append(label)
      }
      if (idea) {
        const label = node('span', 'claude-turn-tag')
        label.innerHTML = icon('idea')
        label.append(idea.title)
        label.title = idea.title
        context.append(label)
      }
      turn.append(context)
    }
    turn.append(node('div', 'claude-turn-content', prompt))
    turns.append(turn)

    const reply = node('article', 'claude-turn')
    reply.dataset.author = 'The Creature'
    const title = node('h3', 'claude-author')
    title.innerHTML = `<span class="claude-brand">${creatureGlyph}</span>The Creature`
    const sections = node('div', 'claude-reply-sections')
    const working = node('div', 'claude-working', 'Thinking…')
    working.setAttribute('data-loading-status', '')
    reply.append(title, sections, working)
    turns.append(reply)
    return { turn, reply, sections, working }
  }

  /** @param {ReplyText} paragraph @param {boolean} streaming */
  function drawReply(paragraph, streaming) {
    if (paragraph.frame) window.clearTimeout(paragraph.frame)
    paragraph.frame = 0
    paragraph.complete = !streaming
    renderAssistantMarkdown(paragraph.body, paragraph.text, {
      colorize,
      openExternal,
      openFile,
      streaming,
      onLayout: updateScroll,
    })
    updateScroll()
  }

  /** @param {SendState} state @param {number} step @param {string} text @param {boolean} streaming */
  function addReplyText(state, step, text, streaming) {
    let paragraph = state.paragraphs.get(step)
    if (!paragraph) {
      const body = node('div', 'claude-turn-content')
      paragraph = { body, text: '', frame: 0, complete: false }
      state.paragraphs.set(step, paragraph)
      state.sections.append(body)
    }
    state.toolGroup = undefined
    paragraph.text = streaming ? paragraph.text + text : text
    if (!streaming || !paragraph.body.childElementCount) drawReply(paragraph, streaming)
    else if (!paragraph.frame) {
      const current = paragraph
      current.frame = window.setTimeout(() => drawReply(current, true), 64)
    }
  }

  const unsubscribeActivity = claude.onActivity(event => {
    const state = activeSend
    if (!state || event.requestId !== state.id || state.stopping) return
    if (event.type === 'text') {
      state.working.hidden = true
      addReplyText(state, event.step, event.text, true)
    } else {
      const paragraph = state.paragraphs.get(event.step)
      if (paragraph && !paragraph.complete) drawReply(paragraph, false)
      let group = state.tools.get(event.id)
      if (!group) {
        if (!state.toolGroup) {
          state.toolGroup = createToolActivity({ openFile })
          state.sections.append(state.toolGroup.element)
        }
        group = state.toolGroup
        state.tools.set(event.id, group)
      }
      group.update(event)
      state.working.hidden = [...state.tools.values()].some(activity => activity.element.dataset.status === 'running')
      state.working.textContent = 'Thinking…'
      updateScroll()
    }
  })

  /** @param {Proposal} proposal @param {HTMLElement} sections */
  function showProposal(proposal, sections) {
    const { card, controls } = createEditProposal(proposal, {
      onApply: () => runTask('Apply proposal', () => resolveProposal(true)),
      onDiscard: () => runTask('Discard proposal', () => resolveProposal(false)),
      onOpenFile: openFile,
      openExternal,
      colorize,
    })
    sections.append(card)
    card.tabIndex = -1
    pending = { proposal, card, controls }
  }

  /** @param {boolean} apply */
  async function resolveProposal(apply) {
    if (!pending || busy || changingKey) return
    const { proposal, card, controls } = pending
    const generation = connectionGeneration
    busy = apply ? 'apply' : 'discard'
    showNotice(notice)
    render()
    try {
      const result = await attemptAsync(() => (apply ? applyEdit(proposal) : claude.discard(proposal.id)), {
        operation: apply ? 'Apply proposal' : 'Discard proposal',
      })
      if (generation !== connectionGeneration) return
      if (!result.ok) {
        showFailure(notice, result.error)
        return
      }
      const label = !apply
        ? 'Discarded'
        : proposal.kind !== 'idea'
          ? 'Applied'
          : proposal.action === 'create'
            ? 'Idea created'
            : 'Idea updated'
      const resolution = node('span', 'claude-resolution')
      if (apply) resolution.innerHTML = icon('check')
      resolution.append(label)
      controls.replaceChildren(resolution)
      if (apply && proposal.kind === 'idea' && openIdea) {
        const open = node('button', 'claude-button', 'Open idea')
        open.type = 'button'
        open.addEventListener(
          'click',
          () => {
            runTask('Open idea', async () => {
              const opened = await attemptAsync(() => openIdea(proposal.ideaId), { operation: 'Open idea' })
              if (!opened.ok && !listeners.signal.aborted) showFailure(notice, opened.error)
            })
          },
          listenerOptions,
        )
        controls.append(open)
      }
      card.dataset.resolution = apply ? 'applied' : 'discarded'
      announcement.textContent = label
      pending = null
    } finally {
      busy = ''
      render()
      updateScroll()
      if (!pending && (document.activeElement === document.body || controls.contains(document.activeElement)))
        focusDraft()
    }
  }

  async function checkConnection() {
    if (checking || changingKey) return
    checking = true
    const generation = connectionGeneration
    render()
    try {
      const result = await attemptAsync(() => claude.status(), {
        operation: 'Check Creature connection',
      })
      if (generation !== connectionGeneration) return
      if (result.ok) connection = result.value
      else showFailure(settings.open ? settingsNotice : notice, result.error)
    } finally {
      checking = false
      render()
      if (settings.open && document.activeElement === closeSettings && !keyInput.disabled) keyInput.focus()
      else if (document.activeElement === action('settings') && !promptInput.disabled) focusDraft()
    }
  }

  function togglePanel(open = container.hidden, restoreFocus = true) {
    container.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    if (open) {
      runTask('Open the Creature panel', () => onOpen?.())
      render()
      resizeDraft()
      updateScroll()
      focusDraft()
      runTask('Check Creature connection', checkConnection)
    } else if (restoreFocus) toggle.focus()
  }

  /** @param {Event} event */
  function openSettings(event) {
    settingsOpener = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
    showNotice(settingsNotice)
    settings.showModal()
    if (!keyInput.disabled) keyInput.focus()
    runTask('Check Creature connection', checkConnection)
  }

  function clearConversation(keepIdea = false) {
    if (activeSend) {
      for (const paragraph of activeSend.paragraphs.values()) window.clearTimeout(paragraph.frame)
      activeSend = null
      busy = ''
    }
    pending = null
    promptInput.value = ''
    includeFile = true
    if (!keepIdea) attachedIdea = null
    turns.replaceChildren()
    announcement.textContent = ''
    showNotice(notice)
    scrollToLatest()
    resizeDraft()
  }

  const unsubscribeReset = claude.onReset(status => {
    connectionGeneration++
    connection = status
    clearConversation(true)
    render()
  })

  /** @param {boolean} save */
  async function updateKey(save) {
    if (checking || busy || changingKey || (save ? saveKey.disabled : removeKey.disabled)) return
    const key = keyInput.value.trim()
    const generation = connectionGeneration
    keyInput.value = ''
    changingKey = true
    showNotice(settingsNotice)
    render()
    try {
      const result = await attemptAsync(() => (save ? claude.saveKey(key) : claude.removeKey()), {
        operation: save ? 'Save Claude API key' : 'Remove Claude API key',
      })
      if (listeners.signal.aborted) return
      if (result.ok) {
        if (generation === connectionGeneration) connection = result.value
        settingsNotice.classList.remove('is-error')
        showNotice(settingsNotice, save ? 'API key saved.' : 'API key removed.')
      } else {
        settingsNotice.classList.add('is-error')
        showFailure(settingsNotice, result.error)
      }
    } finally {
      changingKey = false
      render()
    }
  }

  async function sendMessage() {
    if (send.disabled || busy) return
    const prompt = promptInput.value.trim()
    const idea = attachedIdea
    const file = includeFile ? (getFileContext() ?? undefined) : undefined
    const id = crypto.randomUUID()
    const request = {
      requestId: id,
      prompt,
      fileContext: file,
      proposeEdits: mode === 'edit',
      ideaId: idea?.id,
    }
    const generation = connectionGeneration
    const parts = addTurn(prompt, file, idea)
    /** @type {SendState} */
    const state = {
      ...parts,
      id,
      paragraphs: new Map(),
      tools: new Map(),
      started: false,
      stopping: false,
    }
    activeSend = state
    busy = 'send'
    showNotice(notice)
    announcement.textContent = 'The Creature is thinking.'
    promptInput.value = ''
    render()
    resizeDraft()
    scrollToLatest()
    try {
      const result = await attemptAsync(
        async () => {
          await prepareSend(request)
          if (generation !== connectionGeneration || state.stopping) return undefined
          state.started = true
          return claude.send(request)
        },
        { operation: 'Send message' },
      )
      if (generation !== connectionGeneration) return
      state.working.hidden = true
      for (const group of new Set(state.tools.values())) group.finish()
      if (result.ok && result.value) {
        const response = result.value
        const step = response.step
        const text = response.text.replace(/(?:^|\s+)I am the creature\.$/u, '')
        if ((text || state.paragraphs.has(step)) && state.paragraphs.get(step)?.text !== text) {
          addReplyText(state, step, text, false)
        }
        if (response.proposal) showProposal(response.proposal, state.sections)
        state.sections.append(node('div', 'claude-turn-content', CREATURE_SIGN_OFF))
        attachedIdea = null
        announcement.textContent = response.proposal ? 'Proposal ready to review.' : 'The Creature replied.'
      } else {
        const status = state.stopping ? 'Response stopped.' : 'Response interrupted.'
        announcement.textContent = status
        promptInput.value = prompt
        if (!result.ok && !state.stopping) showFailure(notice, result.error)
        if (!state.sections.childElementCount) {
          state.turn.remove()
          state.reply.remove()
        } else state.sections.append(node('p', 'claude-interrupted', status))
      }
      for (const paragraph of state.paragraphs.values()) {
        if (!paragraph.complete) drawReply(paragraph, false)
      }
    } finally {
      if (activeSend === state) {
        const focused = composer.contains(document.activeElement) || document.activeElement === document.body
        activeSend = null
        busy = ''
        render()
        resizeDraft()
        updateScroll()
        if (!listeners.signal.aborted && focused && !container.hidden && !settings.open) {
          if (pending && following) pending.card.focus({ preventScroll: true })
          else if (!pending) focusDraft()
        }
      }
    }
  }

  async function resetConversation() {
    busy = 'reset'
    render()
    try {
      const result = await attemptAsync(() => claude.reset(), { operation: 'Reset conversation' })
      if (listeners.signal.aborted) return
      if (result.ok) clearConversation()
      else showFailure(notice, result.error)
    } finally {
      busy = ''
      render()
      focusDraft()
    }
  }

  async function stopResponse() {
    const state = activeSend
    if (!state) return
    state.stopping = true
    state.working.hidden = false
    state.working.textContent = 'Stopping…'
    render()
    updateScroll()
    if (!state.started) return
    const result = await attemptAsync(() => claude.cancel(), { operation: 'Stop response' })
    if (!result.ok && activeSend === state) {
      state.stopping = false
      state.working.textContent = 'Thinking…'
      showFailure(notice, result.error)
      render()
    }
  }

  toggle.addEventListener('click', () => togglePanel(), listenerOptions)
  action('close').addEventListener('click', () => togglePanel(false), listenerOptions)
  conversation.addEventListener('scroll', syncScroll, { ...listenerOptions, passive: true })
  conversation.addEventListener('toggle', updateScroll, { ...listenerOptions, capture: true })
  jump.addEventListener(
    'click',
    () => {
      scrollToLatest()
      conversation.focus({ preventScroll: true })
    },
    listenerOptions,
  )
  fileChip.addEventListener(
    'click',
    () => {
      includeFile = !includeFile
      render()
      focusDraft()
    },
    listenerOptions,
  )
  action('remove-idea').addEventListener(
    'click',
    () => {
      attachedIdea = null
      render()
      focusDraft()
    },
    listenerOptions,
  )
  starters.addEventListener(
    'click',
    event => {
      if (!(event.target instanceof Element)) return
      const button = event.target.closest('button')
      if (!button?.dataset.prompt) return
      promptInput.value = button.dataset.prompt
      render()
      resizeDraft()
      focusDraft()
    },
    listenerOptions,
  )
  for (const name of ['settings', 'connect']) action(name).addEventListener('click', openSettings, listenerOptions)
  action('reset').addEventListener('click', () => runTask('Reset conversation', resetConversation), listenerOptions)
  stop.addEventListener('click', () => runTask('Stop response', stopResponse), listenerOptions)
  container.addEventListener(
    'keydown',
    event => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) {
        event.preventDefault()
        togglePanel(false)
      }
    },
    listenerOptions,
  )
  for (const button of modes) {
    button.addEventListener(
      'click',
      () => {
        mode = button.dataset.mode === 'edit' ? 'edit' : 'ask'
        render()
        focusDraft()
      },
      listenerOptions,
    )
  }
  composer.addEventListener(
    'submit',
    event => {
      event.preventDefault()
      runTask('Send message', sendMessage)
    },
    listenerOptions,
  )
  promptInput.addEventListener(
    'input',
    () => {
      render()
      resizeDraft()
      updateScroll()
    },
    listenerOptions,
  )
  promptInput.addEventListener(
    'keydown',
    event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        if (!send.disabled) composer.requestSubmit()
      }
    },
    listenerOptions,
  )
  settingsForm.addEventListener(
    'submit',
    event => {
      event.preventDefault()
      runTask('Save Claude API key', () => updateKey(true))
    },
    listenerOptions,
  )
  keyInput.addEventListener('input', render, listenerOptions)
  removeKey.addEventListener('click', () => runTask('Remove Claude API key', () => updateKey(false)), listenerOptions)
  for (const button of [closeSettings, requireElement(settings, '.claude-done', HTMLButtonElement)]) {
    button.addEventListener('click', () => settings.close(), listenerOptions)
  }
  requireElement(settings, 'a', HTMLAnchorElement).addEventListener(
    'click',
    event => {
      event.preventDefault()
      runTask('Open Claude API settings', async () => {
        const result = await attemptAsync(() => openExternal?.(KEY_URL), { operation: 'Open Claude API settings' })
        if (!result.ok && !listeners.signal.aborted) showFailure(settingsNotice, result.error)
      })
    },
    listenerOptions,
  )
  settings.addEventListener(
    'close',
    () => {
      keyInput.value = ''
      render()
      if (!container.hidden) {
        if (settingsOpener && !settingsOpener.hidden) settingsOpener.focus()
        else focusDraft()
      }
      settingsOpener = null
    },
    listenerOptions,
  )

  render()
  toggle.hidden = false
  return {
    /** @param {IdeaAttachment} idea */
    attachIdea(idea) {
      if (busy || changingKey || pending)
        throw new Error('Finish the current response or proposal before attaching an idea.')
      attachedIdea = { id: idea.id, title: idea.title.trim() || 'Untitled idea' }
      showNotice(notice)
      togglePanel(true)
    },
    /** @param {boolean} hasWorkspace @param {string | null} [id] */
    setContext(hasWorkspace, id = null) {
      if (workspaceId && id && workspaceId !== id) {
        connectionGeneration++
        clearConversation()
      }
      workspace = hasWorkspace
      workspaceId = id
      render()
    },
    refreshContext: render,
    toggle: togglePanel,
    dispose() {
      listeners.abort()
      viewportObserver.disconnect()
      connectionGeneration++
      unsubscribeActivity()
      unsubscribeReset()
      if (activeSend) {
        for (const paragraph of activeSend.paragraphs.values()) window.clearTimeout(paragraph.frame)
      }
      if (activeSend?.started) runTask('Stop response', () => claude.cancel(), { silent: true })
      activeSend = null
      settings.remove()
    },
  }
}
