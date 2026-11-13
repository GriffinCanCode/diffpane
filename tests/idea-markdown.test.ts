import assert from 'node:assert/strict'
import { describe, expect, it } from 'vite-plus/test'
import { formatIdeaSelection, nextIdeaListItem } from '../renderer/ideas.ts'

function apply(source: string, replacement: NonNullable<ReturnType<typeof nextIdeaListItem>>) {
  return source.slice(0, replacement.from) + replacement.text + source.slice(replacement.to)
}

describe('Idea Builder Markdown editing', () => {
  it.each([
    ['  - Details', '  - Details\n  - '],
    ['8. Step', '8. Step\n9. '],
    ['2) Step', '2) Step\n3) '],
    ['- [x] Done', '- [x] Done\n- [ ] '],
    ['- [ ] ', ''],
    ['- [ ]', ''],
    ['- First\n- ', '- First\n'],
  ])('continues or ends the item in %j', (source, expected) => {
    const replacement = nextIdeaListItem(source, source.length)
    expect(replacement && apply(source, replacement)).toBe(expected)
  })

  it('leaves fenced code alone and resumes after the closing fence', () => {
    const code = '~~~js\n- Example'
    expect(nextIdeaListItem(code, code.length)).toBeNull()
    const note = `${code}\n~~~\n- Details`
    const replacement = nextIdeaListItem(note, note.length)
    assert.ok(replacement)
    expect(apply(note, replacement)).toBe(`${note}\n- `)
  })

  it('handles inline selection with whitespace and embedded backticks', () => {
    const source = 'A short note'
    expect(apply(source, formatIdeaSelection(source, 1, 8, 'bold'))).toBe('A **short** note')
    expect(apply('A **short** note', formatIdeaSelection('A **short** note', 4, 9, 'bold'))).toBe(source)
    const expression = 'open(`README.md`)'
    expect(apply(expression, formatIdeaSelection(expression, 0, expression.length, 'code'))).toBe(
      '``open(`README.md`)``',
    )
  })

  it('formats a multiline selection without consuming the following line', () => {
    const source = 'Step A\nStep B\nNext'
    const list = '1. Step A\n2. Step B\nNext'
    expect(apply(source, formatIdeaSelection(source, 0, 14, 'ordered'))).toBe(list)
    expect(apply(list, formatIdeaSelection(list, 0, 20, 'ordered'))).toBe(source)
  })
})
