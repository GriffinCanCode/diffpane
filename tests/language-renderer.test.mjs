import assert from 'node:assert/strict';
import { test, vi } from 'vite-plus/test';
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

function fixture(t, open, request, { language = 'typescript' } = {}) {
  const disposed = { dispose() {} };
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
    languages: Object.fromEntries(
      [
        'Hover',
        'DocumentSymbol',
        'FoldingRange',
        'DocumentSemanticTokens',
        'DocumentRangeSemanticTokens',
        'InlayHints',
      ].map(name => [`register${name}Provider`, () => disposed]),
    ),
    editor: { setModelMarkers() {} },
    MarkerSeverity: { Error: 1 },
  };
  const features = createLanguageFeatures(monaco, {
    language: {
      open,
      request,
      close: async () => {},
      onEvent: () => () => {},
    },
  });
  features.attach(editor, model, filename);
  t.onTestFinished(() => features.dispose());
  return {
    symbols: () => features.symbols(filename),
  };
}

test('TOML models use syntax without opening a language server', async t => {
  const { symbols } = fixture(t, () => assert.fail('Unexpected language server'), null, {
    language: 'toml',
  });
  assert.deepEqual(await symbols(), []);
});

test('TSX documents use the TypeScript server with their own language ID', async t => {
  const opens = [];
  const { symbols } = fixture(
    t,
    async input => {
      opens.push(input);
      return { available: true, capabilities: { documentSymbolProvider: true } };
    },
    async () => [],
    { language: 'tsx' },
  );
  assert.deepEqual(await symbols(), []);
  assert.equal(opens[0]?.language, 'typescript');
  assert.equal(opens[0]?.languageId, 'typescriptreact');
});
