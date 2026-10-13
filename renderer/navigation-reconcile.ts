export type NavigationFile = { path: string; [key: string]: unknown };
export type NavigationNode = {
  key: string;
  path: string;
  name: string;
  kind: string;
  parentKey: string | null;
  children: NavigationNode[] | null;
  changedCount: number;
  file?: NavigationFile | null;
  inventoryEpoch?: number;
};
export type NavigationTree = {
  root: NavigationNode;
  nodes: Map<string, NavigationNode>;
  files: Map<string, NavigationNode>;
  directories: Map<string, NavigationNode>;
  searchFiles?: NavigationNode[];
  inventoryEpoch?: number;
};
const compare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
const order = (a: NavigationNode, b: NavigationNode) =>
  a.kind !== b.kind
    ? a.kind === 'directory'
      ? -1
      : 1
    : compare(a.name, b.name) || compare(a.path, b.path);

function insert(tree: NavigationTree, file: NavigationFile, touched: Set<NavigationNode>) {
  let node = tree.files.get(file.path) ?? tree.directories.get(file.path);
  const kind = file.directory ? 'directory' : 'file';
  if (node && node.kind === kind) {
    node.file = file;
    return node;
  }
  if (node) remove(tree, file.path, touched);
  const basePath = tree.root.path;
  if (file.path === basePath && file.directory) {
    tree.root.file = file;
    tree.directories.set(file.path, tree.root);
    return tree.root;
  }
  const prefix = basePath ? `${basePath}/` : '';
  if (prefix && !file.path.startsWith(prefix)) return null;
  const relative = file.path.slice(prefix.length);
  if (!relative) return null;
  const parts = relative.split('/');
  let parent = tree.root;
  let pathname = basePath;
  for (let index = 0; index < parts.length; index++) {
    pathname = pathname ? `${pathname}/${parts[index]}` : parts[index];
    const directory = index < parts.length - 1 || file.directory === true;
    const key = `${directory ? 'dir' : 'file'}:${pathname}`;
    let child = tree.nodes.get(key);
    if (!child) {
      child = {
        key,
        path: pathname,
        name: parts[index],
        kind: directory ? 'directory' : 'file',
        parentKey: parent.key,
        children: directory ? [] : null,
        changedCount: 0,
        file: directory ? null : file,
      };
      tree.nodes.set(key, child);
      parent.children!.push(child);
      touched.add(parent);
      if (!directory) tree.files.set(pathname, child);
    }
    parent = child;
  }
  node = parent;
  node.file = file;
  if (file.directory) tree.directories.set(file.path, node);
  tree.searchFiles = undefined;
  return node;
}

function remove(tree: NavigationTree, pathname: string, touched: Set<NavigationNode>) {
  const node = tree.files.get(pathname) ?? tree.directories.get(pathname);
  if (!node) return;
  tree.directories.delete(pathname);
  if (node.kind === 'file') {
    tree.files.delete(pathname);
    tree.nodes.delete(node.key);
  } else {
    node.file = null;
    touched.add(node);
  }
  const parent = tree.nodes.get(node.parentKey!);
  if (parent) touched.add(parent);
  tree.searchFiles = undefined;
}

function finish(tree: NavigationTree, touched: Set<NavigationNode>) {
  // Filter each child array once, including when an entire large folder moves.
  for (const parent of touched)
    parent.children = parent.children!.filter(child => tree.nodes.get(child.key) === child);
  const empty = [...touched].filter(
    node => node !== tree.root && !node.file && !node.children!.length,
  );
  while (empty.length) {
    const node = empty.pop()!;
    if (!tree.nodes.delete(node.key)) continue;
    const parent = tree.nodes.get(node.parentKey!);
    if (!parent) continue;
    parent.children = parent.children!.filter(child => child !== node);
    touched.add(parent);
    if (parent !== tree.root && !parent.file && !parent.children.length) empty.push(parent);
  }
  for (const node of touched) node.children!.sort(order);
  return tree;
}

/** Retain unchanged nodes and sort only touched folders during large-repository churn. */
export function reconcileNavigationTree(
  tree: NavigationTree,
  inventory: NavigationFile[],
  basePath = '',
) {
  if (tree.root.path !== basePath) return null;
  const epoch = (tree.inventoryEpoch ?? 0) + 1;
  tree.inventoryEpoch = epoch;
  const touched = new Set<NavigationNode>();
  for (const file of inventory) {
    if ((tree.files.get(file.path) ?? tree.directories.get(file.path))?.inventoryEpoch === epoch)
      continue;
    const node = insert(tree, file, touched);
    if (node) node.inventoryEpoch = epoch;
  }
  for (const [pathname, node] of tree.files)
    if (node.inventoryEpoch !== epoch) remove(tree, pathname, touched);
  for (const [pathname, node] of tree.directories)
    if (node.inventoryEpoch !== epoch) remove(tree, pathname, touched);
  return finish(tree, touched);
}

/** IPC deltas touch only changed nodes; the rest of the catalog stays in place. */
export function applyNavigationDelta(
  tree: NavigationTree,
  files: NavigationFile[],
  removed: string[],
) {
  const touched = new Set<NavigationNode>();
  for (const pathname of removed) remove(tree, pathname, touched);
  for (const file of files) insert(tree, file, touched);
  return finish(tree, touched);
}
