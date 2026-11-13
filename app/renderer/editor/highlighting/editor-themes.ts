import type { editor } from 'monaco-editor'

export const SYNTAX_COLORS = {
  diffpane: {
    comment: '808080',
    keyword: '80CBC4',
    string: 'D994D3',
    number: 'C4A7E7',
    symbol: 'EFAB74',
    variable: 'CCCCCC',
  },
  'diffpane-light': {
    comment: '59666C',
    keyword: '11675F',
    string: '934077',
    number: '6947A2',
    symbol: '9B481C',
    variable: '34383D',
  },
}

export type EditorThemeName = keyof typeof SYNTAX_COLORS

export function editorThemeName(scheme: 'light' | 'dark'): EditorThemeName {
  return scheme === 'light' ? 'diffpane-light' : 'diffpane'
}

function rules({ comment, keyword, string, number, symbol, variable }: (typeof SYNTAX_COLORS)[EditorThemeName]) {
  return [
    { token: 'comment', foreground: comment, fontStyle: 'italic' },
    { token: 'keyword', foreground: keyword },
    { token: 'string', foreground: string },
    { token: 'string.key.json', foreground: variable },
    { token: 'number', foreground: number },
    { token: 'type.identifier', foreground: symbol },
    ...['class', 'struct', 'interface', 'type', 'typeParameter'].map(token => ({
      token,
      foreground: symbol,
    })),
    ...['function', 'method', 'macro', 'member'].map(token => ({ token, foreground: symbol })),
    ...['variable', 'parameter', 'property'].map(token => ({ token, foreground: variable })),
    ...['enumMember', 'variable.readonly', 'property.readonly'].map(token => ({
      token,
      foreground: number,
    })),
  ]
}

const TRANSPARENT = {
  'editorOverviewRuler.border': '#00000000',
  'scrollbar.shadow': '#00000000',
  'diffEditor.insertedTextBackground': '#00000000',
  'diffEditor.removedTextBackground': '#00000000',
  'diffEditor.insertedLineBackground': '#00000000',
  'diffEditor.removedLineBackground': '#00000000',
  'diffEditor.diagonalFill': '#00000000',
}

export const EDITOR_THEMES: Record<EditorThemeName, editor.IStandaloneThemeData> = {
  diffpane: {
    base: 'vs-dark',
    inherit: true,
    rules: rules(SYNTAX_COLORS.diffpane),
    colors: {
      ...TRANSPARENT,
      'editor.background': '#181818',
      'editor.foreground': '#d4d4d4',
      'editorLineNumber.foreground': '#5c6068',
      'editorLineNumber.activeForeground': '#c6c9d0',
      'editorGutter.background': '#181818',
      'editor.selectionBackground': '#35415c',
      'editor.inactiveSelectionBackground': '#303844',
      'editor.lineHighlightBackground': '#ffffff04',
      'editorCursor.foreground': '#b8c3d7',
      'editorIndentGuide.background1': '#ffffff0c',
      'editorIndentGuide.activeBackground1': '#ffffff20',
      'scrollbarSlider.background': '#ffffff12',
      'scrollbarSlider.hoverBackground': '#ffffff24',
      'scrollbarSlider.activeBackground': '#ffffff30',
      'editorWidget.background': '#22242a',
      'editorWidget.border': '#383b43',
      'editor.findMatchBackground': '#7e622b',
      'editor.findMatchHighlightBackground': '#7e622b70',
      focusBorder: '#748aaf',
    },
  },
  'diffpane-light': {
    base: 'vs',
    inherit: true,
    rules: rules(SYNTAX_COLORS['diffpane-light']),
    colors: {
      ...TRANSPARENT,
      'editor.background': '#ffffff',
      'editor.foreground': '#24272a',
      'editorLineNumber.foreground': '#68737b',
      'editorLineNumber.activeForeground': '#344146',
      'editorGutter.background': '#ffffff',
      'editor.selectionBackground': '#d8e8f5',
      'editor.inactiveSelectionBackground': '#e6edf4',
      'editor.lineHighlightBackground': '#18344f08',
      'editorCursor.foreground': '#293d50',
      'editorIndentGuide.background1': '#24395118',
      'editorIndentGuide.activeBackground1': '#2439513b',
      'scrollbarSlider.background': '#2439511f',
      'scrollbarSlider.hoverBackground': '#2439513b',
      'scrollbarSlider.activeBackground': '#24395159',
      'editorWidget.background': '#f5f7f8',
      'editorWidget.border': '#d4dce0',
      'editor.findMatchBackground': '#f5d987',
      'editor.findMatchHighlightBackground': '#f5d98780',
      focusBorder: '#357d76',
    },
  },
}
