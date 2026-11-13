import { marked } from 'marked'

export function parseMarkdown(source: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  const body = frontmatter ? source.slice(frontmatter[0].length) : source
  let words = 0
  const word = /\S+/g
  while (word.test(source)) words++
  return {
    html: marked.parse(body, { gfm: true, async: false }),
    metadata: frontmatter?.[1],
    words,
  }
}
