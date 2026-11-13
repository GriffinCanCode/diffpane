import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vite-plus/test'
import { colorHex, colorOklch, colorPairs, linearSrgb } from '../../../shared/appearance/palette.ts'
import type { ColorRole, ColorScheme } from '../../../shared/appearance/palette.ts'
import { renderThemeTokens, themeTokensPath } from '../../../tooling/appearance/theme-css.ts'

test('first-paint CSS matches the shared theme tokens', async () => {
  assert.equal(await readFile(themeTokensPath, 'utf8'), renderThemeTokens())
})

test('the dark app and editor share the reference charcoal', () => {
  assert.equal(colorHex('dark', 'canvas'), '#181818')
  assert.equal(colorHex('dark', 'workbenchBackground'), '#181818')
})

const readingSurfaces = [
  'workbenchBackground',
  'canvas',
  'surface',
  'surfaceRaised',
  'surfaceInset',
  'hover',
  'selection',
  'accentSurface',
] as const
const codeSurfaces = [
  'workbenchBackground',
  'hover',
  'selection',
  'addedSurface',
  'addedInline',
  'removedSurface',
  'removedInline',
] as const
const syntaxInks = [
  'syntaxComment',
  'syntaxKeyword',
  'syntaxString',
  'syntaxNumber',
  'syntaxSymbol',
  'syntaxVariable',
] as const

function luminance(scheme: ColorScheme, role: ColorRole) {
  const [red, green, blue, opacity] = linearSrgb(colorOklch(scheme, role))
  assert.equal(opacity, 1, `${scheme} ${role} needs a composited background to measure contrast`)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

const contrastGroups: readonly [number, readonly ColorRole[], readonly ColorRole[]][] = [
  [4.5, ['text', 'muted', 'subtle', 'accent'], readingSurfaces],
  [4.5, [...syntaxInks, 'editorText'], codeSurfaces],
  [4.5, ['editorLineNumber', 'editorActiveLineNumber', 'editorChrome'], ['workbenchBackground']],
  [3, ['editorChromeIcon'], ['workbenchBackground']],
  [4.5, ['actionText'], ['action', 'actionHover']],
  [4.5, ['matchText'], ['matchBackground']],
  [4.5, ['warning'], ['warningSurface']],
  [4.5, ['added'], ['addedSurface', 'addedGutter', 'addedInline']],
  [4.5, ['removed'], ['removedSurface', 'removedGutter', 'removedInline']],
  [4.5, ['modified'], ['modifiedSurface']],
  [4.5, ['violet'], ['violetSurface']],
  [4.5, ['text'], ['addedSurface', 'removedSurface', 'warningSurface', 'violetSurface']],
  [4.5, ['added', 'removed', 'warning', 'modified'], ['surface', 'surfaceRaised', 'selection']],
  [3, ['focusRing', 'controlBorder'], readingSurfaces],
  [3, ['chartCode', 'chartComments', 'chartDocs', 'chartBlank'], ['surfaceInset', 'workbenchBackground']],
  [3, ['addedEdge'], ['addedGutter', 'workbenchBackground']],
  [3, ['removedEdge'], ['removedGutter', 'workbenchBackground']],
  [3, ['modifiedEdge'], ['modifiedSurface', 'workbenchBackground']],
]

for (const scheme of ['light', 'dark'] as const) {
  test(`${scheme} colors fit the editor's sRGB gamut`, () => {
    for (const [role, pair] of Object.entries(colorPairs)) {
      const rgb = linearSrgb(pair[scheme === 'light' ? 0 : 1]).slice(0, 3)
      assert.ok(
        rgb.every(channel => channel >= -0.000001 && channel <= 1.000001),
        `${role} is outside sRGB`,
      )
    }
  })

  test(`${scheme} text and state indicators meet their contrast thresholds`, () => {
    for (const [minimum, inks, surfaces] of contrastGroups) {
      for (const ink of inks) {
        for (const surface of surfaces) {
          const foreground = luminance(scheme, ink)
          const background = luminance(scheme, surface)
          const ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
          assert.ok(ratio >= minimum, `${scheme} ${ink} on ${surface} is ${ratio.toFixed(2)}:1, expected ${minimum}:1`)
        }
      }
    }
  })
}
