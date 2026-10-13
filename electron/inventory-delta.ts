type InventoryFile = { path: string; submodule: boolean };

/** One explorer baseline per window; changes do not resend a whole large catalog over IPC. */
export class InventoryDelta {
  private baseline?: { revision: number; index: ReadonlyMap<string, InventoryFile> };

  update(baseRevision: number | null, revision: number, index: ReadonlyMap<string, InventoryFile>) {
    const previous = this.baseline;
    this.baseline = { revision, index };
    if (!previous || previous.revision !== baseRevision)
      return { revision, reset: true, files: [...index.values()], removed: [] as string[] };
    const files: InventoryFile[] = [];
    const removed: string[] = [];
    for (const [pathname, file] of index) {
      const prior = previous.index.get(pathname);
      if (!prior || prior.submodule !== file.submodule) files.push(file);
    }
    for (const pathname of previous.index.keys()) if (!index.has(pathname)) removed.push(pathname);
    return { revision, reset: false, files, removed };
  }
}
