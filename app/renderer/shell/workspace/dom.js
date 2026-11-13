/**
 * @template {Element} T
 * @param {ParentNode} parent
 * @param {string} selector
 * @param {abstract new (...args: never[]) => T} elementType
 */
export function requireElement(parent, selector, elementType) {
  const element = parent.querySelector(selector)
  if (!(element instanceof elementType)) {
    throw new Error(`Missing ${elementType.name} for ${selector}.`)
  }
  return element
}
