import { creatureGlyph } from '../../panels/assistant/creature-glyph.ts'

export function startWorkspaceOpeningPeeks(opening: HTMLElement | null) {
  if (!opening) return
  const pieces = Array.from(opening.querySelectorAll('.workspace-opening__piece'))
  for (const [earliest, latest] of [
    [140, 360],
    [1700, 1950],
  ] as const) {
    const [piece] = pieces.splice(Math.floor(Math.random() * pieces.length), 1)
    if (!piece) break
    const peek = document.createElement('span')
    peek.className = 'workspace-opening__peek'
    peek.style.setProperty('--peek-delay', `${earliest + Math.floor(Math.random() * (latest - earliest))}ms`)
    peek.innerHTML = creatureGlyph
    piece.prepend(peek)
  }
}

export function waitForWorkspaceOpeningPeeks(opening: HTMLElement | null) {
  const peeks = Array.from(opening?.querySelectorAll('.workspace-opening__peek') ?? [])
  return Promise.allSettled(peeks.flatMap(peek => peek.getAnimations().map(animation => animation.finished)))
}
