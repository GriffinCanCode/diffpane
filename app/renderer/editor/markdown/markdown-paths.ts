export function isMarkdown(filename: string) {
  return /\.(md|markdown|mdown|mkd|mdc)$/i.test(filename)
}

// Resolve documentation links inside the project; never let a URL become a file path.
export function markdownTarget(filename: string, href: string | null | undefined) {
  if (!href || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null
  const hash = href.indexOf('#')
  const fragment = hash < 0 ? '' : href.slice(hash + 1)
  let pathname: string
  let anchor: string
  try {
    const target = hash < 0 ? href : href.slice(0, hash)
    const query = target.indexOf('?')
    pathname = decodeURIComponent(query < 0 ? target : target.slice(0, query))
    anchor = decodeURIComponent(fragment)
  } catch {
    return null
  }
  // oxlint-disable-next-line no-control-regex -- Reject encoded control characters in link paths.
  if (pathname.includes('\\') || /[\u0000-\u001f]/.test(pathname)) return null
  if (!pathname) return { path: filename, anchor }
  const parts = pathname.startsWith('/') ? [] : filename.split('/').slice(0, -1)
  for (const part of pathname.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  return parts.length ? { path: parts.join('/'), anchor } : null
}
