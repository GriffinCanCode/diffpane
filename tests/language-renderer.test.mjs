import { test, vi } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { createLanguageFeatures } from '../renderer/languages.js';

vi.mock('monaco-editor/editor/contrib/folding/browser/folding.js', () => ({}));
vi.mock('monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js', () => ({}));
vi.mock(
  'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js',
  () => ({}),
);
vi.mock(
  'monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js',
  () => ({}),
);

function fixture(t, open, request, { language = 'typescript', status } = {}) {
  const disposed = { dispose() {} };
  const events = [];
  const markers = [];
  const canceled = [];
  const providers = [];
  let receive;
  const filename = 'example.ts';
  const model = {
    uri: { toString: () => `file:///${filename}` },
    getLanguageId: () => language,
    getVersionId: () => 1,
    getValue: () => 'const example = 1;',
    validateRange: range => range,
    onDidChangeContent: () => disposed,
    onDidChangeLanguage: () => disposed,
    onWillDispose: () => disposed,
    isDisposed: () => false,
  };
  const editor = {
    getDomNode: () => null,
    updateOptions() {},
    onDidFocusEditorText: () => disposed,
  };
  const monaco = {
    languages: {
      getLanguages: () => [{ id: language }],
      ...Object.fromEntries(
        [
          'Hover',
          'DocumentSymbol',
          'FoldingRange',
          'DocumentSemanticTokens',
          'DocumentRangeSemanticTokens',
          'InlayHints',
        ].map(name => [
          `register${name}Provider`,
          selector => {
            providers.push({ name, ...selector });
            return disposed;
          },
        ]),
      ),
    },
    editor: { setModelMarkers: (_model, _owner, values) => markers.push(values) },
    MarkerSeverity: { Error: 1 },
  };
  const features = createLanguageFeatures(
    monaco,
    {
      language: {
        open,
        request,
        status,
        close: async () => {},
        cancel: async id => canceled.push(id),
        onEvent: listener => {
          receive = listener;
          return () => {};
        },
      },
    },
    { onState: state => events.push(state) },
  );
  features.attach(editor, model, filename);
  t.onTestFinished(() => features.dispose());
  return {
    symbols: () => features.symbols(filename),
    receive: event => receive({ path: filename, language: 'typescript', ...event }),
    events,
    markers,
    canceled,
    providers,
  };
}

test('Box discovery binds providers for a known syntax without a built-in language server', async t => {
  const opens = [];
  const requests = [];
  const { symbols, providers } = fixture(
    t,
    async input => {
      opens.push(input);
      return { available: true, capabilities: { documentSymbolProvider: true } };
    },
    async input => {
      requests.push(input);
      return [];
    },
    {
      language: 'lua',
      status: async () => [
        { language: 'box:lua', languageIds: ['lua'] },
        { language: 'box:other', languageIds: ['lua'] },
      ],
    },
  );
  assert.deepEqual(await symbols(), []);
  assert.equal(
    providers.filter(value => value.language === 'lua' && value.name === 'Hover').length,
    1,
  );
  assert.equal(opens.length, 1);
  assert.equal(opens[0].languageId, 'lua');
  assert.equal(opens[0].language, 'box:lua');
  assert.equal(requests[0].language, 'box:lua');
});

test('a Box TypeScript declaration leaves undeclared TSX documents on the built-in server', async t => {
  const opens = [];
  const { symbols } = fixture(
    t,
    async input => {
      opens.push(input);
      return { available: true, capabilities: { documentSymbolProvider: true } };
    },
    async () => [],
    {
      language: 'tsx',
      status: async () => [{ language: 'box:typescript', languageIds: ['typescript'] }],
    },
  );
  assert.deepEqual(await symbols(), []);
  assert.equal(opens[0]?.language, 'typescript');
  assert.equal(opens[0]?.languageId, 'typescriptreact');
});
