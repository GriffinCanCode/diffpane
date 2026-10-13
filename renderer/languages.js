import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js';
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js';
import 'monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js';

const LANGUAGES = new Set(['python', 'rust', 'elixir', 'go', 'swift', 'typescript', 'tsx', 'jsx', 'javascript']);
const TYPESCRIPT = new Map([['tsx', 'typescriptreact'], ['jsx', 'javascriptreact'], ['javascript', 'javascript']]);
// One protocol legend lets each server keep its own token order; `member` is TypeScript's legacy method kind.
const LEGEND = {
  tokenTypes: ['namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable', 'property', 'enumMember', 'event', 'function', 'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator', 'member'],
  tokenModifiers: ['declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary'],
};

function signal() {
  const listeners = new Set();
  return {
    event(listener, receiver, disposables) {
      const callback = receiver ? listener.bind(receiver) : listener;
      listeners.add(callback);
      const subscription = { dispose: () => listeners.delete(callback) };
      disposables?.push(subscription);
      return subscription;
    },
    fire(value) { for (const listener of listeners) listener(value); },
    dispose() { listeners.clear(); },
  };
}

function toPosition(position) {
  return { lineNumber: position.line + 1, column: position.character + 1 };
}

function fromPosition(position) {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

function toRange(range, model) {
  if (!range?.start || !range?.end) return undefined;
  const result = {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
  return model ? model.validateRange(result) : result;
}

function fromRange(range) {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

function markdown(content) {
  if (content == null) return undefined;
  if (typeof content === 'string') return { value: content, isTrusted: false, supportHtml: false };
  if (content.language) {
    // Choose a fence longer than any run in the source, so docs stay code.
    let fenceLength = 3;
    for (const match of String(content.value).matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = '`'.repeat(fenceLength);
    return { value: `${fence}${content.language}\n${content.value}\n${fence}`, isTrusted: false, supportHtml: false };
  }
  const value = String(content.value ?? '');
  return {
    value: content.kind === 'plaintext' ? value.replace(/[\\`*_{}[\]()<>#+\-.!|]/g, '\\$&') : value,
    isTrusted: false,
    supportHtml: false,
  };
}

function semanticTokens(result, sourceLegend, model) {
  const source = result?.data;
  if (!source || source.length % 5 || !sourceLegend?.tokenTypes) return null;
  const typeMap = sourceLegend.tokenTypes.map(type => LEGEND.tokenTypes.indexOf(type));
  const modifierMap = (sourceLegend.tokenModifiers ?? []).map(type => LEGEND.tokenModifiers.indexOf(type));
  const data = new Uint32Array(source.length);
  let output = 0;
  let line = 0;
  let column = 0;
  let previousLine = 0;
  let previousColumn = 0;
  for (let index = 0; index < source.length; index += 5) {
    const deltaLine = source[index];
    const deltaColumn = source[index + 1];
    const length = source[index + 2];
    const type = source[index + 3];
    const modifiers = source[index + 4];
    for (let part = index; part < index + 5; part++) {
      if (!Number.isInteger(source[part]) || source[part] < 0) return null;
    }
    line += deltaLine;
    column = deltaLine ? deltaColumn : column + deltaColumn;
    const targetType = typeMap[type];
    // Server-specific token types retain their lexical color rather than an invented meaning.
    if (targetType == null || targetType < 0 || length === 0 || line >= model.getLineCount()) continue;
    const available = model.getLineMaxColumn(line + 1) - column - 1;
    if (available <= 0) continue;
    let targetModifiers = 0;
    for (let bit = 0; bit < modifierMap.length && bit < 32; bit++) {
      if (modifierMap[bit] >= 0 && (modifiers & (1 << bit))) targetModifiers |= 1 << modifierMap[bit];
    }
    data[output++] = line - previousLine;
    data[output++] = line === previousLine ? column - previousColumn : column;
    data[output++] = Math.min(length, available);
    data[output++] = targetType;
    data[output++] = targetModifiers >>> 0;
    previousLine = line;
    previousColumn = column;
  }
  return { data: output === data.length ? data : data.slice(0, output), resultId: result.resultId };
}

function documentSymbols(result, model) {
  if (!Array.isArray(result)) return [];
  return result.flatMap(symbol => {
    const range = toRange(symbol.range ?? symbol.location?.range, model);
    if (!range || typeof symbol.name !== 'string') return [];
    return [{
      name: symbol.name,
      detail: symbol.detail ?? '',
      kind: Math.max(0, Math.min(25, (symbol.kind ?? 1) - 1)),
      tags: symbol.tags ?? (symbol.deprecated ? [1] : []),
      containerName: symbol.containerName,
      range,
      selectionRange: toRange(symbol.selectionRange, model) ?? range,
      children: documentSymbols(symbol.children, model),
    }];
  });
}

/** Lazily connects visible Monaco models to their workspace's real language servers. */
export function createLanguageFeatures(monaco, api, { onState = () => {} } = {}) {
  const runtime = api.language;
  const states = new Map();
  const paths = new Map();
  const attachments = new Set();
  const disposables = [];
  const semanticChanged = signal();
  const hintsChanged = signal();
  const foldingChanged = signal();
  const metrics = { requests: 0, discarded: 0, errors: 0, semanticTokens: 0, inlayHints: 0, hovers: 0 };
  let disposed = false;
  let sequence = 0;
  const requestPrefix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

  function publish(state, status, message = '') {
    state.status = status;
    state.message = message;
    onState({ path: state.path, language: state.language, status, message, capabilities: state.capabilities });
  }

  function cancel(work) {
    if (work.canceled) return;
    work.canceled = true;
    if (runtime?.cancel) Promise.resolve(runtime.cancel(work.id)).catch(() => {});
  }

  function invalidate(state) {
    state.epoch++;
    state.cache.clear();
    for (const work of state.pending.values()) cancel(work);
    state.pending.clear();
    semanticChanged.fire();
    hintsChanged.fire();
    foldingChanged.fire();
  }

  function payload(state) {
    return { path: state.path, language: state.language, languageId: state.languageId, text: state.model.getValue(), version: state.model.getVersionId() };
  }

  async function open(state) {
    if (state.closed || disposed || !state.visible || !state.active || !runtime) return false;
    const version = state.model.getVersionId();
    if (state.openVersion === version && state.available) return true;
    if (state.opening) {
      await state.opening;
      return state.closed ? false : open(state);
    }
    const request = payload(state);
    publish(state, state.openVersion == null ? 'starting' : state.status, state.message);
    state.opening = runtime.open(request).then(result => {
      if (state.closed || disposed) return false;
      state.openVersion = request.version;
      state.available = Boolean(result?.available);
      state.capabilities = result?.capabilities ?? result?.caps ?? {};
      state.legend = result?.legend ?? state.capabilities.semanticTokensProvider?.legend;
      const status = state.available ? 'ready' : ['missing', 'error'].includes(state.status) ? state.status : 'unavailable';
      publish(state, status, result?.message ?? state.message);
      if (state.available) {
        semanticChanged.fire();
        hintsChanged.fire();
        foldingChanged.fire();
      }
      return state.available;
    }).catch(error => {
      if (!state.closed && !disposed) {
        metrics.errors++;
        state.openVersion = request.version;
        publish(state, 'error', error.message ?? String(error));
      }
      return false;
    }).finally(() => { state.opening = null; });
    return state.opening;
  }

  async function request(state, method, params, token, cache = false) {
    if (!state || state.closed || token?.isCancellationRequested || !state.visible || !state.active) return null;
    const epoch = state.epoch;
    if (!await open(state) || state.closed || epoch !== state.epoch || token?.isCancellationRequested) return null;
    const capability = ({
      'textDocument/hover': 'hoverProvider',
      'textDocument/inlayHint': 'inlayHintProvider',
      'textDocument/documentSymbol': 'documentSymbolProvider',
      'textDocument/foldingRange': 'foldingRangeProvider',
      'textDocument/semanticTokens/full': 'semanticTokensProvider',
      'textDocument/semanticTokens/range': 'semanticTokensProvider',
    })[method];
    const supported = state.capabilities[capability];
    if (capability && !supported) return null;
    if (method === 'textDocument/semanticTokens/full' && !supported.full) return null;
    if (method === 'textDocument/semanticTokens/range' && !supported.range) return null;
    const key = `${method}:${JSON.stringify(params)}`;
    if (cache && state.cache.has(key)) return state.cache.get(key);
    let work = state.pending.get(key);
    if (!work) {
      metrics.requests++;
      work = { id: `${requestPrefix}:${++sequence}`, canceled: false, clients: new Set(), promise: null };
      work.promise = runtime.request({ path: state.path, language: state.language, method, params, version: state.model.getVersionId(), requestId: work.id })
        .catch(error => {
          if (!state.closed && epoch === state.epoch && !work.canceled) {
            metrics.errors++;
            publish(state, 'error', error.message ?? String(error));
          }
          return null;
        }).finally(() => { if (state.pending.get(key) === work) state.pending.delete(key); });
      state.pending.set(key, work);
    }
    const client = {};
    work.clients.add(client);
    const cancellation = token?.onCancellationRequested(() => {
      work.clients.delete(client);
      if (!work.clients.size) {
        cancel(work);
        if (state.pending.get(key) === work) state.pending.delete(key);
      }
    });
    const result = await work.promise;
    cancellation?.dispose();
    work.clients.delete(client);
    if (disposed || state.closed || epoch !== state.epoch || token?.isCancellationRequested || work.canceled) {
      metrics.discarded++;
      return null;
    }
    // An initialized server may still be indexing; an empty first answer is not a proof of absence.
    if (cache && result != null && (!Array.isArray(result) || result.length) && (!result.data || result.data.length)) state.cache.set(key, result);
    return result;
  }

  function stateFor(model) {
    return states.get(model.uri.toString());
  }

  for (const language of LANGUAGES) {
    const selector = { language, scheme: 'file' };
    disposables.push(monaco.languages.registerHoverProvider(selector, {
      async provideHover(model, position, token) {
        const state = stateFor(model);
        if (state) state.active = true;
        const result = await request(state, 'textDocument/hover', { position: fromPosition(position) }, token);
        if (!result) return null;
        metrics.hovers++;
        return { contents: (Array.isArray(result.contents) ? result.contents : [result.contents]).map(markdown).filter(Boolean), range: toRange(result.range, model) };
      },
    }));
    disposables.push(monaco.languages.registerDocumentSymbolProvider(selector, {
      displayName: 'Language server',
      async provideDocumentSymbols(model, token) {
        return documentSymbols(await request(stateFor(model), 'textDocument/documentSymbol', {}, token, true), model);
      },
    }));
    disposables.push(monaco.languages.registerFoldingRangeProvider(selector, {
      onDidChange: foldingChanged.event,
      async provideFoldingRanges(model, _context, token) {
        const result = await request(stateFor(model), 'textDocument/foldingRange', {}, token, true);
        if (!Array.isArray(result)) return null;
        return result.filter(range => Number.isInteger(range.startLine) && Number.isInteger(range.endLine) && range.endLine > range.startLine)
          .map(range => ({ start: range.startLine + 1, end: Math.min(range.endLine + 1, model.getLineCount()), kind: range.kind ? new monaco.languages.FoldingRangeKind(range.kind) : undefined }));
      },
    }));
    disposables.push(monaco.languages.registerDocumentSemanticTokensProvider(selector, {
      onDidChange: semanticChanged.event,
      getLegend: () => LEGEND,
      async provideDocumentSemanticTokens(model, _lastResultId, token) {
        const state = stateFor(model);
        const result = await request(state, 'textDocument/semanticTokens/full', {}, token, true);
        const tokens = semanticTokens(result, state?.legend, model);
        metrics.semanticTokens += (tokens?.data.length ?? 0) / 5;
        return tokens;
      },
      releaseDocumentSemanticTokens() {},
    }));
    disposables.push(monaco.languages.registerDocumentRangeSemanticTokensProvider(selector, {
      getLegend: () => LEGEND,
      async provideDocumentRangeSemanticTokens(model, range, token) {
        const state = stateFor(model);
        const result = await request(state, 'textDocument/semanticTokens/range', { range: fromRange(range) }, token);
        const tokens = semanticTokens(result, state?.legend, model);
        metrics.semanticTokens += (tokens?.data.length ?? 0) / 5;
        return tokens;
      },
    }));
    disposables.push(monaco.languages.registerInlayHintsProvider(selector, {
      displayName: 'Language server',
      onDidChangeInlayHints: hintsChanged.event,
      async provideInlayHints(model, range, token) {
        const result = await request(stateFor(model), 'textDocument/inlayHint', { range: fromRange(range) }, token);
        if (!Array.isArray(result)) return null;
        const hints = result.filter(hint => hint.position && (typeof hint.label === 'string' || Array.isArray(hint.label))).map(hint => ({
          position: toPosition(hint.position),
          label: Array.isArray(hint.label) ? hint.label.map(part => ({ label: part.value, tooltip: markdown(part.tooltip) })) : hint.label,
          kind: hint.kind,
          tooltip: markdown(hint.tooltip),
          paddingLeft: hint.paddingLeft,
          paddingRight: hint.paddingRight,
        }));
        metrics.inlayHints += hints.length;
        return { hints, dispose() {} };
      },
    }));
  }

  const unsubscribe = runtime?.onEvent(event => {
    if (disposed) return;
    if (event.type === 'status') {
      for (const state of states.values()) {
        if (state.language !== event.language) continue;
        if (['available', 'missing', 'error'].includes(event.status)) {
          state.available = false;
          state.openVersion = null;
          // An evicted server stays asleep until its file is used again.
          if (event.status === 'available') state.active = false;
        }
        publish(state, event.status, event.message ?? '');
      }
      return;
    }
    if (event.type === 'refresh') {
      for (const state of states.values()) {
        if (state.language !== event.language) continue;
        state.openVersion = null;
        invalidate(state);
        if (state.active && state.visible) void open(state);
      }
      return;
    }
    if (event.type !== 'diagnostics') return;
    const state = paths.get(event.path);
    if (!state || state.closed || state.model.isDisposed()) return;
    if (event.version != null && event.version !== state.model.getVersionId()) return;
    const severities = [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint];
    const markers = (event.diagnostics ?? []).flatMap(diagnostic => {
      const range = toRange(diagnostic.range, state.model);
      if (!range) return [];
      return [{
        ...range,
        message: diagnostic.message,
        severity: severities[(diagnostic.severity ?? 1) - 1] ?? monaco.MarkerSeverity.Error,
        source: diagnostic.source,
        code: diagnostic.code == null ? undefined : String(diagnostic.code),
        tags: diagnostic.tags,
        modelVersionId: state.model.getVersionId(),
        relatedInformation: diagnostic.relatedInformation?.map(info => ({
          ...toRange(info.location.range), resource: monaco.Uri.parse(info.location.uri), message: info.message,
        })),
      }];
    });
    monaco.editor.setModelMarkers(state.model, 'diffpane-lsp', markers);
    state.diagnostics = markers.length;
    onState({ path: state.path, language: state.language, status: state.status, message: state.message, capabilities: state.capabilities, diagnostics: markers.length });
  });

  function attachModel(editor, model, path, { active = true } = {}) {
    const language = model.getLanguageId();
    if (disposed || !LANGUAGES.has(language)) return () => {};
    const key = model.uri.toString();
    states.get(key)?.cleanup();
    const state = {
      editor, model, path, language: TYPESCRIPT.has(language) ? 'typescript' : language,
      languageId: TYPESCRIPT.get(language) ?? language, active, visible: false, closed: false, available: false,
      epoch: 0, openVersion: null, opening: null, capabilities: {}, legend: null,
      status: runtime ? 'idle' : 'unavailable', message: '', diagnostics: 0,
      pending: new Map(), cache: new Map(), timer: null, idle: null,
    };
    states.set(key, state);
    paths.set(path, state);
    publish(state, state.status, runtime ? '' : 'Language services unavailable');
    editor.updateOptions({
      folding: true, foldingStrategy: 'auto', showFoldingControls: 'mouseover',
      inlayHints: { enabled: 'on', fontSize: 12, padding: true },
      'semanticHighlighting.enabled': true,
      renderValidationDecorations: 'on',
      hover: { enabled: true, delay: 350 },
    });

    const cancelScheduled = () => {
      clearTimeout(state.timer);
      if (state.idle != null) {
        if (globalThis.cancelIdleCallback) cancelIdleCallback(state.idle);
        else clearTimeout(state.idle);
      }
      state.timer = state.idle = null;
    };
    const schedule = (delay = 150) => {
      cancelScheduled();
      if (!state.visible || !state.active || state.closed) return;
      state.timer = setTimeout(() => {
        const run = () => { state.idle = null; void open(state); };
        state.idle = globalThis.requestIdleCallback ? requestIdleCallback(run, { timeout: 1000 }) : setTimeout(run, 0);
      }, delay);
    };
    const dom = editor.getDomNode();
    const observer = globalThis.IntersectionObserver && dom ? new IntersectionObserver(entries => {
      state.visible = entries.some(entry => entry.isIntersecting);
      if (state.visible) schedule();
      else cancelScheduled();
    }) : null;
    if (observer) observer.observe(dom);
    else { state.visible = true; schedule(); }
    const content = model.onDidChangeContent(() => {
      invalidate(state);
      monaco.editor.setModelMarkers(model, 'diffpane-lsp', []);
      state.diagnostics = 0;
      schedule();
    });
    const focus = editor.onDidFocusEditorText(() => { state.visible = state.active = true; schedule(0); });
    const modelDisposal = model.onWillDispose(() => state.cleanup());
    state.cleanup = () => {
      if (state.closed) return;
      state.closed = true;
      cancelScheduled();
      observer?.disconnect();
      content.dispose();
      focus.dispose();
      modelDisposal.dispose();
      state.cache.clear();
      for (const work of state.pending.values()) cancel(work);
      state.pending.clear();
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, 'diffpane-lsp', []);
      if (states.get(key) === state) states.delete(key);
      if (paths.get(path) === state) paths.delete(path);
      // The backend closes only this document; its idle policy owns server lifetime.
      if (runtime) Promise.resolve(runtime.close(path)).catch(() => {});
    };
    return state.cleanup;
  }

  function attach(editor, model, path, options) {
    if (disposed) return () => {};
    let cleanup = () => {};
    const bind = () => {
      cleanup();
      cleanup = attachModel(editor, model, path, options);
    };
    const languageChange = model.onDidChangeLanguage(bind);
    bind();
    const detach = () => { languageChange.dispose(); cleanup(); attachments.delete(detach); };
    attachments.add(detach);
    return detach;
  }

  return {
    attach,
    async symbols(path) {
      const state = paths.get(path);
      if (!state) return [];
      state.visible = state.active = true;
      return documentSymbols(await request(state, 'textDocument/documentSymbol', {}, null, true), state.model);
    },
    stats() {
      return {
        ...metrics, documents: states.size,
        languages: [...new Set([...states.values()].filter(state => state.available).map(state => state.language))],
        pending: [...states.values()].reduce((sum, state) => sum + state.pending.size, 0),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      for (const detach of [...attachments]) detach();
      for (const disposable of disposables) disposable.dispose();
      semanticChanged.dispose();
      hintsChanged.dispose();
      foldingChanged.dispose();
    },
  };
}
