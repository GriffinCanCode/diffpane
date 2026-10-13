/** A bounded frame batch; event storms never retain a growing history of paths. */
export class LivePathBatch {
  private paths = new Set<string>();

  add(paths: readonly string[]) {
    for (const path of paths) {
      if (this.paths.has('*')) break;
      if (path === '*' || this.paths.size >= 256) {
        this.paths.clear();
        this.paths.add('*');
        break;
      }
      this.paths.add(path);
    }
  }

  take() {
    const paths = [...this.paths];
    this.paths.clear();
    return paths;
  }
}

export function subscribeLivePaths(
  api: { onPaths?: (callback: (paths: string[]) => void) => () => void },
  apply: (paths: string[]) => void,
) {
  const batch = new LivePathBatch();
  let frame: number | null = null;
  const unsubscribe = api.onPaths?.(paths => {
    batch.add(paths);
    if (frame === null)
      frame = requestAnimationFrame(() => {
        frame = null;
        apply(batch.take());
      });
  });
  return () => {
    unsubscribe?.();
    if (frame !== null) cancelAnimationFrame(frame);
  };
}
