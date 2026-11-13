export interface NavigationFile {
  path: string
  directory?: boolean
  index?: string
  worktree?: string
  conflicted?: boolean
  submodule?: boolean
  ignored?: boolean
  originalPath?: string | null
  reviewVersion?: number
}
export interface NavigationNode {
  key: string
  path: string
  name: string
  kind: string
  parentKey: string | null
  children: NavigationNode[] | null
  changedCount: number
  file?: NavigationFile | null
  inventoryEpoch?: number
  searchPath?: string
}
export interface NavigationTree {
  root: NavigationNode
  nodes: Map<string, NavigationNode>
  files: Map<string, NavigationNode>
  directories: Map<string, NavigationNode>
  searchFiles?: NavigationNode[]
  searchDirectories?: NavigationNode[]
  inventoryEpoch?: number
}
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
function order(a: NavigationNode, b: NavigationNode) {
  return a.kind !== b.kind
    ? a.kind === 'directory'
      ? -1
      : 1
    : COLLATOR.compare(a.name, b.name) || COLLATOR.compare(a.path, b.path)
}

function entry(tree: NavigationTree, file: NavigationFile) {
  return (file.directory ? tree.directories : tree.files).get(file.path)
}

function insert(tree: NavigationTree, file: NavigationFile, touched: Set<NavigationNode>) {
  const existing = entry(tree, file)
  if (existing) {
    existing.file = file
    return existing
  }
  const basePath = tree.root.path
  if (file.path === basePath && file.directory) {
    tree.root.file = file
    tree.directories.set(file.path, tree.root)
    return tree.root
  }
  const prefix = basePath ? `${basePath}/` : ''
  if (prefix && !file.path.startsWith(prefix)) return null
  const relative = file.path.slice(prefix.length)
  if (!relative) return null
  const parts = relative.split('/')
  let parent = tree.root
  let pathname = basePath
  for (const [index, part] of parts.entries()) {
    pathname = pathname ? `${pathname}/${part}` : part
    const directory = index < parts.length - 1 || file.directory === true
    const key = `${directory ? 'dir' : 'file'}:${pathname}`
    let child = tree.nodes.get(key)
    if (!child) {
      child = {
        key,
        path: pathname,
        name: part,
        kind: directory ? 'directory' : 'file',
        parentKey: parent.key,
        children: directory ? [] : null,
        changedCount: 0,
        file: directory ? null : file,
      }
      if (!parent.children) throw new Error(`Expected a navigation directory at ${parent.path}`)
      tree.nodes.set(key, child)
      if (directory) tree.searchDirectories = undefined
      parent.children.push(child)
      touched.add(parent)
      if (!directory) tree.files.set(pathname, child)
    }
    parent = child
  }
  parent.file = file
  if (file.directory) tree.directories.set(file.path, parent)
  if (!file.directory) tree.searchFiles = undefined
  return parent
}

function remove(tree: NavigationTree, node: NavigationNode, touched: Set<NavigationNode>) {
  if (node.kind === 'file') {
    tree.files.delete(node.path)
    tree.nodes.delete(node.key)
    tree.searchFiles = undefined
  } else {
    tree.directories.delete(node.path)
    node.file = null
    touched.add(node)
  }
  const parent = node.parentKey === null ? undefined : tree.nodes.get(node.parentKey)
  if (parent) touched.add(parent)
}

function finish(tree: NavigationTree, touched: Set<NavigationNode>) {
  // Count surviving children before pruning, then compact each affected array once.
  const remaining = new Map<NavigationNode, number>()
  const empty: NavigationNode[] = []
  for (const parent of touched) {
    if (!parent.children) continue
    let count = 0
    for (const child of parent.children) if (tree.nodes.get(child.key) === child) count++
    remaining.set(parent, count)
    if (!count && !parent.file && parent !== tree.root) empty.push(parent)
  }
  for (let node = empty.pop(); node; node = empty.pop()) {
    tree.nodes.delete(node.key)
    tree.searchDirectories = undefined
    const parent = node.parentKey === null ? undefined : tree.nodes.get(node.parentKey)
    if (!parent?.children) continue
    const count = (remaining.get(parent) ?? parent.children.length) - 1
    remaining.set(parent, count)
    touched.add(parent)
    if (!count && !parent.file && parent !== tree.root) empty.push(parent)
  }
  for (const node of touched) {
    if (!node.children || !tree.nodes.has(node.key)) continue
    if (remaining.get(node) !== node.children.length)
      node.children = node.children.filter(child => tree.nodes.get(child.key) === child)
    node.children.sort(order)
  }
  return tree
}

/** Retain unchanged nodes and sort only touched folders during large-repository churn. */
export function reconcileNavigationTree(tree: NavigationTree, inventory: readonly NavigationFile[], basePath = '') {
  if (tree.root.path !== basePath) return null
  const epoch = (tree.inventoryEpoch ?? 0) + 1
  tree.inventoryEpoch = epoch
  const touched = new Set<NavigationNode>()
  for (const file of inventory) {
    if (entry(tree, file)?.inventoryEpoch === epoch) continue
    const node = insert(tree, file, touched)
    if (node) node.inventoryEpoch = epoch
  }
  for (const node of tree.files.values()) if (node.inventoryEpoch !== epoch) remove(tree, node, touched)
  for (const node of tree.directories.values()) if (node.inventoryEpoch !== epoch) remove(tree, node, touched)
  return finish(tree, touched)
}

/** IPC deltas touch only changed nodes; the rest of the catalog stays in place. */
export function applyNavigationDelta(
  tree: NavigationTree,
  files: readonly NavigationFile[],
  removed: readonly string[],
) {
  const touched = new Set<NavigationNode>()
  const removePath = (pathname: string) => {
    const file = tree.files.get(pathname)
    const directory = tree.directories.get(pathname)
    if (file) remove(tree, file, touched)
    if (directory) remove(tree, directory, touched)
  }
  for (const pathname of removed) removePath(pathname)
  for (const file of files) {
    // Each IPC delta carries a single inventory entry per path; a new kind replaces its marker.
    const previous = (file.directory ? tree.files : tree.directories).get(file.path)
    if (previous) remove(tree, previous, touched)
    insert(tree, file, touched)
  }
  return finish(tree, touched)
}
