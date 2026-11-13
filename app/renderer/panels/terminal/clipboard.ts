// xterm 6.0.0 wraps bracketed paste without escaping embedded ESC characters.
// Display control characters as text so clipboard data cannot end the paste early.
export function terminalPasteText(text: string) {
  return Array.from(text, character => {
    const code = character.charCodeAt(0)
    if (code < 32 && character !== '\r' && character !== '\n' && character !== '\t')
      return String.fromCharCode(0x2400 + code)
    if (code === 127) return '\u2421'
    if (code >= 128 && code < 160) return '\uFFFD'
    return character
  }).join('')
}
