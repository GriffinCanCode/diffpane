export type ColorScheme = 'light' | 'dark'
type Oklch = `oklch(${string})`

// Each semantic role lists its light and dark values in that order.
export const colorPairs = {
  canvas: ['oklch(98.8% 0.003 255)', 'oklch(20.904% 0 0)'],
  surface: ['oklch(97.7% 0.006 255)', 'oklch(23.075% 0 0)'],
  surfaceRaised: ['oklch(95.8% 0.007 255)', 'oklch(26.448% 0 0)'],
  surfaceInset: ['oklch(96.5% 0.007 255)', 'oklch(19.125% 0 0)'],
  workbenchBackground: ['oklch(100% 0 0)', 'oklch(20.904% 0 0)'],
  text: ['oklch(23.5% 0.026 255)', 'oklch(93.403% 0 0)'],
  muted: ['oklch(37% 0.035 255)', 'oklch(78.26% 0 0)'],
  subtle: ['oklch(45.6% 0.034 255)', 'oklch(73% 0 0)'],
  line: ['oklch(88.4% 0.015 255)', 'oklch(34.07% 0 0)'],
  controlBorder: ['oklch(59% 0.031 255)', 'oklch(62% 0 0)'],
  hover: ['oklch(94.3% 0.012 255)', 'oklch(28.908% 0 0)'],
  focusRing: ['oklch(53.1% 0.163 255)', 'oklch(77.9% 0.111 255)'],
  backdrop: ['oklch(20% 0.018 255 / 0.42)', 'oklch(10% 0 0 / 0.72)'],
  shadow: ['oklch(20% 0.018 255 / 0.22)', 'oklch(5% 0 0 / 0.52)'],
  scrollbar: ['oklch(45% 0.027 255 / 0.24)', 'oklch(84% 0 0 / 0.23)'],
  scrollbarHover: ['oklch(45% 0.027 255 / 0.4)', 'oklch(84% 0 0 / 0.39)'],
  scrollbarActive: ['oklch(45% 0.027 255 / 0.56)', 'oklch(84% 0 0 / 0.54)'],

  accent: ['oklch(46.3% 0.15 255)', 'oklch(76.3% 0.118 255)'],
  accentSurface: ['oklch(93.2% 0.031 255)', 'oklch(30.5% 0.051 255)'],
  action: ['oklch(49.2% 0.162 255)', 'oklch(72.6% 0.13 255)'],
  actionHover: ['oklch(43.7% 0.128 255)', 'oklch(78.4% 0.1 255)'],
  actionText: ['oklch(100% 0 0)', 'oklch(19% 0.035 255)'],
  selection: ['oklch(89.8% 0.047 255)', 'oklch(35% 0.066 255)'],
  selectionInactive: ['oklch(93.2% 0.031 255)', 'oklch(30.5% 0.042 255)'],
  matchBackground: ['oklch(90.8% 0.087 85)', 'oklch(37.7% 0.073 75)'],
  matchText: ['oklch(25.8% 0.046 75)', 'oklch(96.8% 0.022 85)'],
  warning: ['oklch(46.4% 0.092 75)', 'oklch(82% 0.125 75)'],
  warningSurface: ['oklch(94.7% 0.036 75)', 'oklch(28.8% 0.041 75)'],
  warningEdge: ['oklch(54% 0.103 75)', 'oklch(72% 0.112 75)'],

  added: ['oklch(42% 0.076 164)', 'oklch(81.7% 0.105 164)'],
  addedSurface: ['oklch(96% 0.028 164)', 'oklch(22.9% 0.032 164)'],
  addedGutter: ['oklch(93% 0.051 164)', 'oklch(26.4% 0.049 164)'],
  addedInline: ['oklch(88.8% 0.078 164)', 'oklch(31% 0.06 164)'],
  addedEdge: ['oklch(55.3% 0.107 164)', 'oklch(71.9% 0.13 164)'],
  removed: ['oklch(43.5% 0.114 15)', 'oklch(82.7% 0.088 15)'],
  removedSurface: ['oklch(95.5% 0.02 15)', 'oklch(23.4% 0.029 15)'],
  removedGutter: ['oklch(92.6% 0.034 15)', 'oklch(26.9% 0.043 15)'],
  removedInline: ['oklch(88.4% 0.059 15)', 'oklch(31.9% 0.068 15)'],
  removedEdge: ['oklch(55.4% 0.153 15)', 'oklch(73.7% 0.123 15)'],
  modified: ['oklch(45% 0.084 225)', 'oklch(81% 0.09 225)'],
  modifiedSurface: ['oklch(94.7% 0.023 225)', 'oklch(27% 0.043 225)'],
  modifiedEdge: ['oklch(54% 0.09 225)', 'oklch(72% 0.1 225)'],
  violet: ['oklch(44% 0.11 305)', 'oklch(82% 0.095 305)'],
  violetSurface: ['oklch(95% 0.025 305)', 'oklch(27.5% 0.043 305)'],

  chartCode: ['oklch(53% 0.145 255)', 'oklch(73% 0.12 255)'],
  chartComments: ['oklch(51% 0.107 164)', 'oklch(72% 0.13 164)'],
  chartDocs: ['oklch(53% 0.1 305)', 'oklch(75% 0.095 305)'],
  chartBlank: ['oklch(61% 0.031 255)', 'oklch(59.8% 0.03 255)'],

  editorText: ['oklch(23.5% 0.026 255)', 'oklch(86.994% 0 0)'],
  editorLineNumber: ['oklch(45.6% 0.034 255)', 'oklch(61.212% 0.01481 262.35)'],
  editorActiveLineNumber: ['oklch(23.5% 0.026 255)', 'oklch(83.563% 0.01026 267.35)'],
  editorChrome: ['oklch(45.6% 0.034 255)', 'oklch(65.335% 0 0)'],
  editorChromeIcon: ['oklch(45.6% 0.034 255)', 'oklch(61.212% 0.01481 262.35)'],
  editorSeparator: ['oklch(88.4% 0.015 255)', 'oklch(25.196% 0 0)'],

  syntaxComment: ['oklch(43.6% 0.027 255)', 'oklch(72.838% 0 0)'],
  syntaxKeyword: ['oklch(40% 0.134 305)', 'oklch(79.119% 0.07547 188.24)'],
  syntaxString: ['oklch(40.1% 0.071 165)', 'oklch(75.49% 0.11652 329.7)'],
  syntaxNumber: ['oklch(41.4% 0.1 49)', 'oklch(77.597% 0.09451 304.99)'],
  syntaxSymbol: ['oklch(41.5% 0.116 254)', 'oklch(79.4% 0.10705 59.37)'],
  syntaxVariable: ['oklch(23.5% 0.026 255)', 'oklch(84.522% 0 0)'],
  transparent: ['oklch(0% 0 0 / 0)', 'oklch(0% 0 0 / 0)'],
} as const satisfies Record<string, readonly [Oklch, Oklch]>

export type ColorRole = keyof typeof colorPairs

export function colorOklch(scheme: ColorScheme, role: ColorRole): Oklch {
  return colorPairs[role][scheme === 'light' ? 0 : 1]
}

export function cssRole(role: string) {
  return `--${role.replaceAll(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`
}

// Convert to linear sRGB before encoding colors for Monaco, Mermaid, and Electron.
export function linearSrgb(color: Oklch): [number, number, number, number] {
  const [lightness = '0', chroma = '0', hue = '0', , opacity = '1'] = color.slice(6, -1).split(' ')
  const light = Number.parseFloat(lightness) / 100
  const angle = (Number(hue) * Math.PI) / 180
  const a = Number(chroma) * Math.cos(angle)
  const b = Number(chroma) * Math.sin(angle)
  const l = (light + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (light - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (light - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    Number(opacity),
  ]
}

function hexByte(channel: number) {
  return Math.round(Math.min(1, Math.max(0, channel)) * 255)
    .toString(16)
    .padStart(2, '0')
}

export function colorHex(scheme: ColorScheme, role: ColorRole): `#${string}` {
  const [red, green, blue, opacity] = linearSrgb(colorOklch(scheme, role))
  const rgb = [red, green, blue].map(channel =>
    hexByte(channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055),
  )
  return `#${rgb.join('')}${opacity < 1 ? hexByte(opacity) : ''}`
}
