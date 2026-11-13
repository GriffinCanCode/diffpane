import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { terminalPasteText } from '../../../renderer/panels/terminal/clipboard.ts'

test('paste escapes bracketed-paste delimiters and terminal controls', () => {
  const text = 'first\u001b[201~\u009b201~\u0000\u0003\u007f\nsecond'
  assert.equal(terminalPasteText(text), 'first␛[201~�201~␀␃␡\nsecond')
})

test('paste preserves Unicode, tabs and line endings for multiline confirmation', () => {
  const text = '修正\t— 🐈‍⬛\nmañana\r\n'
  assert.equal(terminalPasteText(text), text)
})
