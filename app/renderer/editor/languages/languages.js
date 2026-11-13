// MONOLITHIC: Monaco registrations, document versions and language-service cancellation share one editor attachment. Extract providers once their disposer and request ownership can be tested independently.
import 'monaco-editor/editor/contrib/folding/browser/folding.js'
import 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js'
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js'
import 'monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js'
import { attemptAsync } from '../../../shared/recovery/app-errors.ts'
import { reportError, runTask } from '../../shell/recovery/errors.ts'
import {
  documentSymbols,
  fromPosition,
  fromRange,
  isArray,
  isCoordinate,
  isDiagnostic,
  isPosition,
  isRecord,
  markdown,
  tokenLegend,
  toPosition,
  toRange,
} from './language-protocol.js'

/**
 * @import { CancellationToken, IDisposable, IRange } from 'monaco-editor'
 * @import { ProtocolPosition, ProtocolRange } from './language-protocol.js'
 */
/** @typedef {'idle' | 'starting' | 'ready' | 'unavailable' | 'available' | 'missing' | 'error'} LanguageStatus */
/** @typedef {{ path: string, language: string, status: LanguageStatus, message: string, capabilities: Record<string, unknown>, diagnostics: number }} LanguageStateNotice */
/** @typedef {{ path: string, language: string, languageId: string, text: string, version: number }} LanguageOpenInput */
/** @typedef {{ path: string, language: string, method: LanguageMethod, params: LanguageParams, version: number, requestId: string }} LanguageRequestInput */
/** @typedef {{ position?: ProtocolPosition, range?: ProtocolRange }} LanguageParams */
/** @typedef {keyof typeof CAPABILITIES} LanguageMethod */
/**
 * @typedef {{
 *   open: (input: LanguageOpenInput) => Promise<unknown>,
 *   request: (input: LanguageRequestInput) => Promise<unknown>,
 *   cancel?: (id: string) => Promise<unknown>,
 *   close: (path: string) => Promise<unknown>,
 *   onEvent: (listener: (value: unknown) => void) => () => void,
 * }} LanguageBridge
 */
/** @typedef {{ id: string, canceled: boolean, clients: Set<object>, promise: Promise<unknown> }} LanguageWork */
/** @typedef {Pick<import('monaco-editor').editor.ITextModel, 'getLanguageId' | 'getValue' | 'getVersionId' | 'isDisposed' | 'onDidChangeContent' | 'onDidChangeLanguage' | 'onWillDispose'> & { uri: Pick<import('monaco-editor').Uri, 'toString'>, validateRange: (range: IRange) => IRange }} LanguageModel */
/** @typedef {Pick<import('monaco-editor').editor.ICodeEditor, 'getDomNode' | 'updateOptions' | 'onDidFocusEditorText'>} LanguageEditor */
/**
 * @template {LanguageModel} Model
 * @typedef {{
 *   languages: Pick<typeof import('monaco-editor').languages, 'registerHoverProvider' | 'registerDocumentSymbolProvider' | 'registerFoldingRangeProvider' | 'registerDocumentSemanticTokensProvider' | 'registerDocumentRangeSemanticTokensProvider' | 'registerInlayHintsProvider'> & { FoldingRangeKind: new (kind: string) => import('monaco-editor').languages.FoldingRangeKind },
 *   editor: { setModelMarkers: (model: Model, owner: string, markers: import('monaco-editor').editor.IMarkerData[]) => void },
 *   Uri: Pick<typeof import('monaco-editor').Uri, 'parse'>,
 *   MarkerSeverity: Pick<typeof import('monaco-editor').MarkerSeverity, 'Error' | 'Warning' | 'Info' | 'Hint'>,
 * }} LanguageMonaco
 */
/**
 * @template {LanguageModel} Model
 * @typedef {{
 *   model: Model,
 *   path: string,
 *   language: string,
 *   languageId: string,
 *   active: boolean,
 *   visible: boolean,
 *   closed: boolean,
 *   available: boolean,
 *   epoch: number,
 *   openVersion: number | null,
 *   opening: { version: number, refresh: number, promise: Promise<boolean> } | null,
 *   refresh: number,
 *   capabilities: Record<string, unknown>,
 *   legend: import('monaco-editor').languages.SemanticTokensLegend | undefined,
 *   status: LanguageStatus,
 *   message: string,
 *   diagnostics: number,
 *   pending: Map<string, LanguageWork>,
 *   cache: Map<string, unknown>,
 *   cancelScheduled: (() => void) | null,
 *   cleanup?: () => void,
 * }} LanguageDocumentState
 */

const CAPABILITIES = {
  'textDocument/hover': 'hoverProvider',
  'textDocument/inlayHint': 'inlayHintProvider',
  'textDocument/documentSymbol': 'documentSymbolProvider',
  'textDocument/foldingRange': 'foldingRangeProvider',
  'textDocument/semanticTokens/full': 'semanticTokensProvider',
  'textDocument/semanticTokens/range': 'semanticTokensProvider',
}

const LANGUAGES = new Set(['python', 'rust', 'elixir', 'go', 'swift', 'typescript', 'tsx', 'jsx', 'javascript'])
const TYPESCRIPT = new Map([
  ['tsx', 'typescriptreact'],
  ['jsx', 'javascriptreact'],
  ['javascript', 'javascript'],
])
// One protocol legend lets each server keep its own token order; `member` is TypeScript's legacy method kind.
const LEGEND = {
  tokenTypes: [
    'namespace',
    'type',
    'class',
    'enum',
    'interface',
    'struct',
    'typeParameter',
    'parameter',
    'variable',
    'property',
    'enumMember',
    'event',
    'function',
    'method',
    'macro',
    'keyword',
    'modifier',
    'comment',
    'string',
    'number',
    'regexp',
    'operator',
    'decorator',
    'member',
  ],
  tokenModifiers: [
    'declaration',
    'definition',
    'readonly',
    'static',
    'deprecated',
    'abstract',
    'async',
    'modification',
    'documentation',
    'defaultLibrary',
  ],
}

/** @template T @returns {{ event: import('monaco-editor').IEvent<T>, fire: (value: T) => void, dispose: () => void }} */
function signal() {
  /** @type {Set<(value: T) => void>} */
  const listeners = new Set()
  return {
    /** @this {void} @param {(value: T) => void} listener @param {unknown} [receiver] @param {IDisposable[]} [disposables] */
    event(listener, receiver, disposables) {
      const callback = receiver ? listener.bind(receiver) : listener
      listeners.add(callback)
      const subscription = { dispose: () => listeners.delete(callback) }
      disposables?.push(subscription)
      return subscription
    },
    fire(value) {
      for (const listener of listeners) listener(value)
    },
    dispose() {
      listeners.clear()
    },
  }
}

/**
 * @param {unknown} result
 * @param {import('monaco-editor').languages.SemanticTokensLegend | undefined} sourceLegend
 * @param {import('monaco-editor').editor.ITextModel} model
 */
function semanticTokens(result, sourceLegend, model) {
  if (!isRecord(result) || !isArray(result.data) || !sourceLegend || result.data.length % 5) return null
  const source = result.data
  const typeMap = sourceLegend.tokenTypes.map(type => LEGEND.tokenTypes.indexOf(type))
  const modifierMap = (sourceLegend.tokenModifiers ?? []).map(type => LEGEND.tokenModifiers.indexOf(type))
  const data = new Uint32Array(source.length)
  let output = 0
  let line = 0
  let column = 0
  let previousLine = 0
  let previousColumn = 0
  for (let index = 0; index < source.length; index += 5) {
    const deltaLine = source[index]
    const deltaColumn = source[index + 1]
    const length = source[index + 2]
    const type = source[index + 3]
    const modifiers = source[index + 4]
    if (
      !isCoordinate(deltaLine) ||
      !isCoordinate(deltaColumn) ||
      !isCoordinate(length) ||
      !isCoordinate(type) ||
      !isCoordinate(modifiers) ||
      modifiers > 0xffffffff
    )
      return null
    line += deltaLine
    column = deltaLine ? deltaColumn : column + deltaColumn
    const targetType = typeMap[type]
    // Server-specific token types retain their lexical color rather than an invented meaning.
    if (targetType === undefined || targetType < 0 || length === 0 || line >= model.getLineCount()) continue
    const available = model.getLineMaxColumn(line + 1) - column - 1
    if (available <= 0) continue
    let targetModifiers = 0
    for (let bit = 0; bit < modifierMap.length && bit < 32; bit++) {
      const mapped = modifierMap[bit]
      if (mapped !== undefined && mapped >= 0 && modifiers & (1 << bit)) targetModifiers |= 1 << mapped
    }
    data[output++] = line - previousLine
    data[output++] = line === previousLine ? column - previousColumn : column
    data[output++] = Math.min(length, available)
    data[output++] = targetType
    data[output++] = targetModifiers >>> 0
    previousLine = line
    previousColumn = column
  }
  return {
    data: output === data.length ? data : data.slice(0, output),
    resultId: typeof result.resultId === 'string' ? result.resultId : undefined,
  }
}

/** @param {Pick<LanguageDocumentState<LanguageModel>, 'path' | 'language' | 'languageId' | 'model'>} state @returns {LanguageOpenInput} */
function documentInput(state) {
  return {
    path: state.path,
    language: state.language,
    languageId: state.languageId,
    text: state.model.getValue(),
    version: state.model.getVersionId(),
  }
}

/**
 * @template {LanguageModel} Model
 * @param {LanguageMonaco<Model>} monaco
 * @param {{ language?: LanguageBridge }} api
 * @param {{ onState?: (state: LanguageStateNotice) => void }} [options]
 */
export function createLanguageFeatures(monaco, api, { onState = () => {} } = {}) {
  const runtime = api.language
  /** @type {Map<string, LanguageDocumentState<Model>>} */
  const states = new Map()
  /** @type {Map<string, LanguageDocumentState<Model>>} */
  const paths = new Map()
  /** @type {Set<() => void>} */
  const attachments = new Set()
  /** @type {IDisposable[]} */
  const disposables = []
  /** @type {ReturnType<typeof signal<void>>} */
  const semanticChanged = signal()
  /** @type {ReturnType<typeof signal<void>>} */
  const hintsChanged = signal()
  /** @type {ReturnType<typeof signal<import('monaco-editor').languages.FoldingRangeProvider>>} */
  const foldingChanged = signal()
  const metrics = {
    requests: 0,
    discarded: 0,
    errors: 0,
    semanticTokens: 0,
    inlayHints: 0,
    hovers: 0,
  }
  let disposed = false
  let sequence = 0
  const requestPrefix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`

  /** @param {LanguageDocumentState<Model>} state @param {LanguageStatus} status */
  function publish(state, status, message = '') {
    state.status = status
    state.message = message
    onState({
      path: state.path,
      language: state.language,
      status,
      message,
      capabilities: state.capabilities,
      diagnostics: state.diagnostics,
    })
  }

  /** @param {LanguageWork} work */
  function cancel(work) {
    if (work.canceled) return
    work.canceled = true
    if (runtime?.cancel) runTask('Cancel language request', () => runtime.cancel?.(work.id), { silent: true })
  }

  /** @param {LanguageDocumentState<Model>} state */
  function invalidate(state) {
    state.epoch++
    state.cache.clear()
    for (const work of state.pending.values()) cancel(work)
    state.pending.clear()
    semanticChanged.fire()
    hintsChanged.fire()
    foldingChanged.fire(foldingProvider)
  }

  /** @param {LanguageDocumentState<Model>} state @returns {Promise<boolean>} */
  async function open(state) {
    if (state.closed || disposed || !state.visible || !state.active || !runtime) return false
    const version = state.model.getVersionId()
    const refresh = state.refresh
    if (state.openVersion === version && state.available) return true
    if (state.opening) {
      const opening = state.opening
      const available = await opening.promise
      return opening.version === version && opening.refresh === refresh ? available : open(state)
    }
    const input = documentInput(state)
    publish(state, state.openVersion === null ? 'starting' : state.status, state.message)
    const promise = attemptAsync(() => runtime.open(input), { operation: 'Open language document' })
      .then(opened => {
        if (state.closed || disposed || state.refresh !== refresh || state.model.getVersionId() !== input.version)
          return false
        if (!opened.ok) {
          reportError(opened.error, { silent: true })
          metrics.errors++
          state.openVersion = null
          state.available = false
          publish(state, 'error', opened.error.message)
          return false
        }
        const result = isRecord(opened.value) ? opened.value : undefined
        if (result?.stale === true) return false
        state.openVersion = input.version
        state.available = result?.available === true
        const capabilities = result?.capabilities ?? result?.caps
        state.capabilities = isRecord(capabilities) ? capabilities : {}
        const semantic = state.capabilities.semanticTokensProvider
        state.legend = tokenLegend(result?.legend ?? (isRecord(semantic) ? semantic.legend : undefined))
        const status = state.available
          ? 'ready'
          : state.status === 'missing' || state.status === 'error'
            ? state.status
            : 'unavailable'
        publish(state, status, typeof result?.message === 'string' ? result.message : state.message)
        if (state.available) {
          semanticChanged.fire()
          hintsChanged.fire()
          foldingChanged.fire(foldingProvider)
        }
        return state.available
      })
      .finally(() => {
        state.opening = null
      })
    state.opening = { version: input.version, refresh, promise }
    return promise
  }

  /**
   * @param {LanguageDocumentState<Model> | undefined} state
   * @param {LanguageMethod} method
   * @param {LanguageParams} params
   * @param {CancellationToken | null} token
   */
  async function request(state, method, params, token, cache = false) {
    if (!runtime || !state || state.closed || token?.isCancellationRequested || !state.visible || !state.active)
      return null
    const epoch = state.epoch
    if (
      !(await open(state)) ||
      state.closed ||
      !state.available ||
      epoch !== state.epoch ||
      token?.isCancellationRequested
    )
      return null
    const supported = state.capabilities[CAPABILITIES[method]]
    if (!supported) return null
    if (method === 'textDocument/semanticTokens/full' && (!isRecord(supported) || !supported.full)) return null
    if (method === 'textDocument/semanticTokens/range' && (!isRecord(supported) || !supported.range)) return null
    const key = `${method}:${JSON.stringify(params)}`
    if (cache && state.cache.has(key)) return state.cache.get(key)
    let work = state.pending.get(key)
    if (!work) {
      metrics.requests++
      /** @type {LanguageWork} */
      const current = {
        id: `${requestPrefix}:${++sequence}`,
        canceled: false,
        clients: new Set(),
        promise: Promise.resolve(null),
      }
      current.promise = attemptAsync(
        () =>
          runtime.request({
            path: state.path,
            language: state.language,
            method,
            params,
            version: state.model.getVersionId(),
            requestId: current.id,
          }),
        { operation: 'Request language information' },
      )
        .then(result => {
          if (result.ok) return result.value
          if (!state.closed && epoch === state.epoch && !current.canceled) {
            reportError(result.error, { silent: true })
            metrics.errors++
            publish(state, 'error', result.error.message)
          }
          return null
        })
        .finally(() => {
          if (state.pending.get(key) === current) state.pending.delete(key)
        })
      state.pending.set(key, current)
      work = current
    }
    const pending = work
    const client = {}
    pending.clients.add(client)
    const cancellation = token?.onCancellationRequested(() => {
      pending.clients.delete(client)
      if (!pending.clients.size) {
        cancel(pending)
        if (state.pending.get(key) === pending) state.pending.delete(key)
      }
    })
    let result
    try {
      result = await pending.promise
    } finally {
      cancellation?.dispose()
      pending.clients.delete(client)
    }
    if (disposed || state.closed || epoch !== state.epoch || token?.isCancellationRequested || work.canceled) {
      metrics.discarded++
      return null
    }
    if (result !== null && result !== undefined && state.status === 'error' && state.available) publish(state, 'ready')
    // An initialized server may still be indexing; an empty first answer is not a proof of absence.
    if (
      cache &&
      result !== null &&
      result !== undefined &&
      (!isArray(result) || result.length > 0) &&
      (!isRecord(result) || !isArray(result.data) || result.data.length > 0)
    )
      state.cache.set(key, result)
    return result
  }

  /** @param {import('monaco-editor').editor.ITextModel} model */
  function stateFor(model) {
    return states.get(model.uri.toString())
  }

  /** @type {import('monaco-editor').languages.FoldingRangeProvider} */
  const foldingProvider = {
    onDidChange: foldingChanged.event,
    async provideFoldingRanges(model, _context, token) {
      const result = await request(stateFor(model), 'textDocument/foldingRange', {}, token, true)
      if (!isArray(result)) return null
      return result.flatMap(range => {
        if (!isRecord(range) || !isCoordinate(range.startLine) || !isCoordinate(range.endLine)) return []
        const start = range.startLine + 1
        const end = Math.min(range.endLine + 1, model.getLineCount())
        if (end <= start) return []
        return [
          {
            start,
            end,
            kind:
              typeof range.kind === 'string' && range.kind
                ? new monaco.languages.FoldingRangeKind(range.kind)
                : undefined,
          },
        ]
      })
    },
  }

  for (const language of LANGUAGES) {
    const selector = { language, scheme: 'file' }
    disposables.push(
      monaco.languages.registerHoverProvider(selector, {
        async provideHover(model, position, token) {
          const state = stateFor(model)
          if (state) state.active = true
          const result = await request(state, 'textDocument/hover', { position: fromPosition(position) }, token)
          if (!isRecord(result)) return null
          metrics.hovers++
          return {
            contents: (isArray(result.contents) ? result.contents : [result.contents])
              .map(markdown)
              .filter(content => content !== undefined),
            range: toRange(result.range, model),
          }
        },
      }),
    )
    disposables.push(
      monaco.languages.registerDocumentSymbolProvider(selector, {
        displayName: 'Language server',
        async provideDocumentSymbols(model, token) {
          return documentSymbols(await request(stateFor(model), 'textDocument/documentSymbol', {}, token, true), model)
        },
      }),
    )
    disposables.push(monaco.languages.registerFoldingRangeProvider(selector, foldingProvider))
    disposables.push(
      monaco.languages.registerDocumentSemanticTokensProvider(selector, {
        onDidChange: semanticChanged.event,
        getLegend: () => LEGEND,
        async provideDocumentSemanticTokens(model, _lastResultId, token) {
          const state = stateFor(model)
          const result = await request(state, 'textDocument/semanticTokens/full', {}, token, true)
          const tokens = semanticTokens(result, state?.legend, model)
          metrics.semanticTokens += (tokens?.data.length ?? 0) / 5
          return tokens
        },
        releaseDocumentSemanticTokens() {},
      }),
    )
    disposables.push(
      monaco.languages.registerDocumentRangeSemanticTokensProvider(selector, {
        getLegend: () => LEGEND,
        async provideDocumentRangeSemanticTokens(model, range, token) {
          const state = stateFor(model)
          const result = await request(state, 'textDocument/semanticTokens/range', { range: fromRange(range) }, token)
          const tokens = semanticTokens(result, state?.legend, model)
          metrics.semanticTokens += (tokens?.data.length ?? 0) / 5
          return tokens
        },
      }),
    )
    disposables.push(
      monaco.languages.registerInlayHintsProvider(selector, {
        displayName: 'Language server',
        onDidChangeInlayHints: hintsChanged.event,
        async provideInlayHints(model, range, token) {
          const result = await request(stateFor(model), 'textDocument/inlayHint', { range: fromRange(range) }, token)
          if (!isArray(result)) return null
          const hints = result.flatMap(hint => {
            if (!isRecord(hint) || !isPosition(hint.position)) return []
            const label =
              typeof hint.label === 'string'
                ? hint.label
                : isArray(hint.label)
                  ? hint.label.flatMap(part =>
                      isRecord(part) && typeof part.value === 'string'
                        ? [{ label: part.value, tooltip: markdown(part.tooltip) }]
                        : [],
                    )
                  : undefined
            if (label === undefined) return []
            return [
              {
                position: toPosition(hint.position),
                label,
                kind: hint.kind === 1 || hint.kind === 2 ? hint.kind : undefined,
                tooltip: markdown(hint.tooltip),
                paddingLeft: hint.paddingLeft === true,
                paddingRight: hint.paddingRight === true,
              },
            ]
          })
          metrics.inlayHints += hints.length
          return { hints, dispose() {} }
        },
      }),
    )
  }

  const unsubscribe = runtime?.onEvent(event => {
    if (disposed || !isRecord(event) || typeof event.language !== 'string') return
    if (event.type === 'status') {
      const status = event.status
      if (
        status !== 'available' &&
        status !== 'starting' &&
        status !== 'missing' &&
        status !== 'error' &&
        status !== 'ready'
      )
        return
      for (const state of states.values()) {
        if (state.language !== event.language) continue
        if (status === 'available' || status === 'missing' || status === 'error') {
          state.available = false
          state.openVersion = null
          // An evicted server stays asleep until its file is used again.
          if (status === 'available' && !state.opening) state.active = false
          monaco.editor.setModelMarkers(state.model, 'diffpane-lsp', [])
          state.diagnostics = 0
          invalidate(state)
        }
        publish(state, status, typeof event.message === 'string' ? event.message : '')
      }
      return
    }
    if (event.type === 'refresh') {
      for (const state of states.values()) {
        if (state.language !== event.language) continue
        state.refresh++
        state.openVersion = null
        invalidate(state)
        if (state.active && state.visible) runTask('Open language document', () => open(state))
      }
      return
    }
    if (event.type !== 'diagnostics' || typeof event.path !== 'string' || !isArray(event.diagnostics)) return
    const state = paths.get(event.path)
    if (!state || state.closed || state.model.isDisposed() || state.language !== event.language) return
    if (event.version !== null && event.version !== undefined && event.version !== state.model.getVersionId()) return
    const severities = [
      monaco.MarkerSeverity.Error,
      monaco.MarkerSeverity.Warning,
      monaco.MarkerSeverity.Info,
      monaco.MarkerSeverity.Hint,
    ]
    /** @type {import('monaco-editor').editor.IMarkerData[]} */
    const markers = event.diagnostics.flatMap(diagnostic => {
      if (!isDiagnostic(diagnostic)) return []
      const range = toRange(diagnostic.range, state.model)
      if (!range) return []
      return [
        {
          startLineNumber: range.startLineNumber,
          endLineNumber: range.endLineNumber,
          startColumn: range.startColumn,
          endColumn: range.endColumn,
          message: diagnostic.message,
          severity: severities[(diagnostic.severity ?? 1) - 1] ?? monaco.MarkerSeverity.Error,
          source: diagnostic.source,
          code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
          tags: diagnostic.tags?.filter(tag => tag === 1 || tag === 2),
          modelVersionId: state.model.getVersionId(),
          relatedInformation: diagnostic.relatedInformation?.flatMap(info => {
            if (
              !isRecord(info) ||
              typeof info.message !== 'string' ||
              !isRecord(info.location) ||
              typeof info.location.uri !== 'string'
            )
              return []
            const relatedRange = toRange(info.location.range)
            return relatedRange
              ? [
                  {
                    startLineNumber: relatedRange.startLineNumber,
                    endLineNumber: relatedRange.endLineNumber,
                    startColumn: relatedRange.startColumn,
                    endColumn: relatedRange.endColumn,
                    resource: monaco.Uri.parse(info.location.uri),
                    message: info.message,
                  },
                ]
              : []
          }),
        },
      ]
    })
    monaco.editor.setModelMarkers(state.model, 'diffpane-lsp', markers)
    state.diagnostics = markers.length
    publish(state, state.status, state.message)
  })

  /**
   * @param {LanguageEditor} editor
   * @param {Model} model
   * @param {string} path
   * @param {{ active?: boolean }} [options]
   */
  function attachModel(editor, model, path, { active = true } = {}) {
    const language = model.getLanguageId()
    if (disposed || !LANGUAGES.has(language)) return () => {}
    const key = model.uri.toString()
    states.get(key)?.cleanup?.()
    /** @type {LanguageDocumentState<Model>} */
    const state = {
      model,
      path,
      language: TYPESCRIPT.has(language) ? 'typescript' : language,
      languageId: TYPESCRIPT.get(language) ?? language,
      active,
      visible: false,
      closed: false,
      available: false,
      epoch: 0,
      refresh: 0,
      openVersion: null,
      opening: null,
      capabilities: {},
      legend: undefined,
      status: runtime ? 'idle' : 'unavailable',
      message: '',
      diagnostics: 0,
      pending: new Map(),
      cache: new Map(),
      cancelScheduled: null,
    }
    states.set(key, state)
    paths.set(path, state)
    publish(state, state.status, runtime ? '' : 'Language services unavailable')
    /** @type {import('monaco-editor').editor.IStandaloneEditorConstructionOptions} */
    const editorOptions = {
      folding: true,
      foldingStrategy: 'auto',
      showFoldingControls: 'mouseover',
      inlayHints: { enabled: 'on', fontSize: 12, padding: true },
      'semanticHighlighting.enabled': true,
      renderValidationDecorations: 'on',
      hover: { enabled: 'on', delay: 350 },
    }
    editor.updateOptions(editorOptions)

    function cancelScheduled() {
      state.cancelScheduled?.()
      state.cancelScheduled = null
    }
    function openScheduled() {
      state.cancelScheduled = null
      runTask('Open language document', () => open(state))
    }
    function schedule(delay = 150) {
      cancelScheduled()
      if (!state.visible || !state.active || state.closed) return
      const timer = setTimeout(() => {
        if (typeof globalThis.requestIdleCallback === 'function') {
          const idle = requestIdleCallback(openScheduled, { timeout: 1000 })
          state.cancelScheduled = () => cancelIdleCallback(idle)
        } else {
          const deferred = setTimeout(openScheduled, 0)
          state.cancelScheduled = () => clearTimeout(deferred)
        }
      }, delay)
      state.cancelScheduled = () => clearTimeout(timer)
    }
    const dom = editor.getDomNode()
    const observer =
      globalThis.IntersectionObserver && dom
        ? new IntersectionObserver(entries => {
            state.visible = entries.some(entry => entry.isIntersecting)
            if (state.visible) schedule()
            else cancelScheduled()
          })
        : null
    if (observer && dom) observer.observe(dom)
    else {
      state.visible = true
      schedule()
    }
    const content = model.onDidChangeContent(() => {
      invalidate(state)
      monaco.editor.setModelMarkers(model, 'diffpane-lsp', [])
      state.diagnostics = 0
      publish(state, state.status, state.message)
      schedule()
    })
    const focus = editor.onDidFocusEditorText(() => {
      state.visible = state.active = true
      schedule(0)
    })
    const modelDisposal = model.onWillDispose(() => state.cleanup?.())
    state.cleanup = () => {
      if (state.closed) return
      state.closed = true
      cancelScheduled()
      observer?.disconnect()
      content.dispose()
      focus.dispose()
      modelDisposal.dispose()
      state.cache.clear()
      for (const work of state.pending.values()) cancel(work)
      state.pending.clear()
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, 'diffpane-lsp', [])
      if (states.get(key) === state) states.delete(key)
      if (paths.get(path) === state) paths.delete(path)
      // The backend closes only this document; its idle policy owns server lifetime.
      if (runtime) runTask('Close language document', () => runtime.close(path), { silent: true })
    }
    return state.cleanup
  }

  /**
   * @param {LanguageEditor} editor
   * @param {Model} model
   * @param {string} path
   * @param {{ active?: boolean }} [options]
   */
  function attach(editor, model, path, options) {
    if (disposed) return () => {}
    /** @type {(() => void) | undefined} */
    let cleanup
    const bind = () => {
      cleanup?.()
      cleanup = attachModel(editor, model, path, options)
    }
    const languageChange = model.onDidChangeLanguage(bind)
    bind()
    const detach = () => {
      languageChange.dispose()
      cleanup?.()
      attachments.delete(detach)
    }
    attachments.add(detach)
    return detach
  }

  return {
    attach,
    /** @param {string} path */
    async symbols(path) {
      const state = paths.get(path)
      if (!state) return []
      state.visible = state.active = true
      return documentSymbols(await request(state, 'textDocument/documentSymbol', {}, null, true), state.model)
    },
    stats() {
      return {
        ...metrics,
        documents: states.size,
        languages: [...new Set([...states.values()].filter(state => state.available).map(state => state.language))],
        pending: [...states.values()].reduce((sum, state) => sum + state.pending.size, 0),
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe?.()
      for (const detach of attachments) detach()
      for (const disposable of disposables) disposable.dispose()
      semanticChanged.dispose()
      hintsChanged.dispose()
      foldingChanged.dispose()
    },
  }
}
