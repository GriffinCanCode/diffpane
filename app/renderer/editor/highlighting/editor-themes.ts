import type { editor } from 'monaco-editor'
import { colorHex } from '../../../shared/appearance/palette.ts'
import type { ColorRole, ColorScheme } from '../../../shared/appearance/palette.ts'

function syntaxColors(scheme: ColorScheme) {
  return {
    comment: colorHex(scheme, 'syntaxComment').slice(1),
    keyword: colorHex(scheme, 'syntaxKeyword').slice(1),
    string: colorHex(scheme, 'syntaxString').slice(1),
    number: colorHex(scheme, 'syntaxNumber').slice(1),
    symbol: colorHex(scheme, 'syntaxSymbol').slice(1),
    variable: colorHex(scheme, 'syntaxVariable').slice(1),
    added: colorHex(scheme, 'added').slice(1),
    removed: colorHex(scheme, 'removed').slice(1),
  }
}

export const SYNTAX_COLORS = {
  diffpane: syntaxColors('dark'),
  'diffpane-light': syntaxColors('light'),
}

export type EditorThemeName = keyof typeof SYNTAX_COLORS

export function editorThemeName(scheme: ColorScheme): EditorThemeName {
  return scheme === 'light' ? 'diffpane-light' : 'diffpane'
}

function rules({
  comment,
  keyword,
  string,
  number,
  symbol,
  variable,
  added,
  removed,
}: ReturnType<typeof syntaxColors>) {
  return [
    { token: 'emphasis', fontStyle: 'italic' },
    { token: 'strong', fontStyle: 'bold' },
    { token: 'comment', foreground: comment, fontStyle: 'italic' },
    { token: 'keyword', foreground: keyword },
    { token: 'operator', foreground: keyword },
    { token: 'string', foreground: string },
    { token: 'regexp', foreground: string },
    { token: 'string.key.json', foreground: variable },
    { token: 'number', foreground: number },
    { token: 'invalid', foreground: removed },
    { token: 'deleted', foreground: removed },
    { token: 'inserted', foreground: added },
    ...['class', 'struct', 'interface', 'type', 'typeParameter', 'tag', 'annotation', 'metatag'].map(token => ({
      token,
      foreground: symbol,
    })),
    ...['function', 'method', 'macro', 'member'].map(token => ({ token, foreground: symbol })),
    ...['variable', 'parameter', 'property', 'key', 'attribute.name'].map(token => ({ token, foreground: variable })),
    { token: 'attribute.value', foreground: string },
    ...['constant', 'enumMember', 'variable.readonly', 'property.readonly'].map(token => ({
      token,
      foreground: number,
    })),
  ]
}

const editorRoles = {
  foreground: 'text',
  descriptionForeground: 'muted',
  focusBorder: 'focusRing',
  'textLink.foreground': 'accent',
  'textLink.activeForeground': 'accent',
  'editor.background': 'workbenchBackground',
  'editor.foreground': 'editorText',
  'editorLineNumber.foreground': 'editorLineNumber',
  'editorLineNumber.activeForeground': 'editorActiveLineNumber',
  'editorGutter.background': 'workbenchBackground',
  'editor.selectionBackground': 'selection',
  'editor.inactiveSelectionBackground': 'selectionInactive',
  'editor.selectionHighlightBackground': 'selectionInactive',
  'editor.lineHighlightBackground': 'hover',
  'editorCursor.foreground': 'accent',
  'editorBracketHighlight.foreground1': 'syntaxSymbol',
  'editorBracketHighlight.foreground2': 'syntaxString',
  'editorBracketHighlight.foreground3': 'syntaxNumber',
  'editorBracketHighlight.unexpectedBracket.foreground': 'removed',
  'editorBracketMatch.background': 'accentSurface',
  'editorBracketMatch.border': 'focusRing',
  'editorBracketMatch.foreground': 'text',
  'editorWhitespace.foreground': 'controlBorder',
  'editorRuler.foreground': 'line',
  'editorIndentGuide.background1': 'editorSeparator',
  'editorIndentGuide.activeBackground1': 'controlBorder',
  'editorWidget.background': 'surfaceRaised',
  'editorWidget.foreground': 'text',
  'editorWidget.border': 'controlBorder',
  'editorHoverWidget.statusBarBackground': 'surface',
  'editor.findMatchBackground': 'matchBackground',
  'editor.findMatchBorder': 'warningEdge',
  'editor.findMatchHighlightBackground': 'warningSurface',
  'editorOverviewRuler.findMatchForeground': 'warningEdge',
  'editorOverviewRuler.errorForeground': 'removedEdge',
  'editorOverviewRuler.warningForeground': 'warningEdge',
  'editorOverviewRuler.infoForeground': 'modifiedEdge',
  'editorOverviewRuler.border': 'transparent',
  'editorError.foreground': 'removedEdge',
  'editorWarning.foreground': 'warningEdge',
  'editorInfo.foreground': 'modifiedEdge',
  'editorHint.foreground': 'subtle',
  'scrollbar.shadow': 'transparent',
  'scrollbarSlider.background': 'scrollbar',
  'scrollbarSlider.hoverBackground': 'scrollbarHover',
  'scrollbarSlider.activeBackground': 'scrollbarActive',
  'input.background': 'surfaceInset',
  'input.foreground': 'text',
  'input.border': 'controlBorder',
  'input.placeholderForeground': 'subtle',
  'inputOption.activeBackground': 'accentSurface',
  'inputOption.activeBorder': 'focusRing',
  'inputOption.activeForeground': 'accent',
  'inputOption.hoverBackground': 'hover',
  'menu.background': 'surfaceRaised',
  'menu.foreground': 'text',
  'menu.border': 'controlBorder',
  'menu.selectionBackground': 'selection',
  'menu.selectionForeground': 'text',
  'menu.separatorBackground': 'line',
  'list.activeSelectionBackground': 'selection',
  'list.activeSelectionForeground': 'text',
  'list.hoverBackground': 'hover',
  'list.hoverForeground': 'text',
  'list.highlightForeground': 'accent',
  'diffEditor.border': 'line',
  'diffEditor.insertedTextBackground': 'transparent',
  'diffEditor.removedTextBackground': 'transparent',
  'diffEditor.insertedLineBackground': 'transparent',
  'diffEditor.removedLineBackground': 'transparent',
  'diffEditor.diagonalFill': 'transparent',
  'diffEditorGutter.insertedLineBackground': 'addedGutter',
  'diffEditorGutter.removedLineBackground': 'removedGutter',
  'diffEditorOverview.insertedForeground': 'addedEdge',
  'diffEditorOverview.removedForeground': 'removedEdge',
} satisfies Record<string, ColorRole>

function editorTheme(scheme: ColorScheme): editor.IStandaloneThemeData {
  return {
    base: scheme === 'light' ? 'vs' : 'vs-dark',
    inherit: false,
    rules: rules(SYNTAX_COLORS[editorThemeName(scheme)]),
    colors: Object.fromEntries(Object.entries(editorRoles).map(([key, role]) => [key, colorHex(scheme, role)])),
  }
}

export const EDITOR_THEMES: Record<EditorThemeName, editor.IStandaloneThemeData> = {
  diffpane: editorTheme('dark'),
  'diffpane-light': editorTheme('light'),
}
