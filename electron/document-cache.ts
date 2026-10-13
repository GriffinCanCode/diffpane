type PreviewSide = { data?: string; hex?: string; value?: string };

type Cacheable = {
  after?: string;
  before?: string;
  decorations?: readonly unknown[];
  beforeDecorations?: readonly unknown[];
  preview?: { before?: PreviewSide; after?: PreviewSide };
};

type Entry<T> = { path: string; bytes: number; value: T };

type Work<T> = {
  key: string;
  path: string;
  comparison: string;
  epoch: number;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

/** Bounded reads shared by simultaneous callers; invalidated work never enters the cache. */
export class DocumentCache<T extends Cacheable> {
  load!: (path: string, comparison: string) => Promise<T>;
  concurrency!: number;
  maxEntries!: number;
  maxBytes!: number;
  entries = new Map<string, Entry<T>>();
  pending = new Map<string, Work<T>>();
  queue: Work<T>[] = [];
  running = 0;
  bytes = 0;
  metrics = { hits: 0, loads: 0, retries: 0 };
  disposed?: boolean;

  constructor(
    load: (path: string, comparison: string) => Promise<T>,
    { concurrency = 2, maxEntries = 24, maxBytes = 16 * 1024 * 1024 } = {},
  ) {
    Object.assign(this, { load, concurrency, maxEntries, maxBytes });
  }

  get(path: string, comparison: string) {
    if (this.disposed) return Promise.reject(new Error('Document cache closed'));
    const key = `${comparison}\0${path}`;
    const cached = this.entries.get(key);
    if (cached) {
      this.metrics.hits++;
      this.entries.delete(key);
      this.entries.set(key, cached);
      return Promise.resolve(cached.value);
    }
    const pending = this.pending.get(key);
    if (pending) return pending.promise;
    const work = { key, path, comparison, epoch: 0 } as Work<T>;
    work.promise = new Promise((resolve, reject) => Object.assign(work, { resolve, reject }));
    this.pending.set(key, work);
    this.queue.push(work);
    this.pump();
    return work.promise;
  }

  invalidate(paths: readonly string[] = ['*']) {
    const changed = new Set(paths);
    const affected = (path: string) => {
      if (changed.has('*') || changed.has(path)) return true;
      let slash = path.lastIndexOf('/');
      while (slash >= 0) {
        if (changed.has(path.slice(0, slash))) return true;
        slash = path.lastIndexOf('/', slash - 1);
      }
      return false;
    };
    for (const [key, entry] of this.entries) {
      if (affected(entry.path)) {
        this.bytes -= entry.bytes;
        this.entries.delete(key);
      }
    }
    for (const work of this.pending.values()) if (affected(work.path)) work.epoch++;
  }

  pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const work = this.queue.shift();
      if (!work) break;
      this.running++;
      void this.run(work);
    }
  }

  async run(work: Work<T>) {
    const epoch = work.epoch;
    this.metrics.loads++;
    try {
      const value = await this.load(work.path, work.comparison);
      if (this.disposed) return;
      if (epoch !== work.epoch) {
        this.metrics.retries++;
        this.queue.push(work);
        return;
      }
      const side = (preview?: PreviewSide) =>
        (preview?.data?.length ?? 0) + (preview?.hex?.length ?? 0) + (preview?.value?.length ?? 0);
      const bytes =
        ((value.after?.length ?? 0) +
          (value.before?.length ?? 0) +
          side(value.preview?.before) +
          side(value.preview?.after)) *
          2 +
        ((value.decorations?.length ?? 0) + (value.beforeDecorations?.length ?? 0)) * 96;
      if (bytes <= this.maxBytes) {
        this.entries.set(work.key, { path: work.path, bytes, value });
        this.bytes += bytes;
        while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
          const key = this.entries.keys().next().value!;
          this.bytes -= this.entries.get(key)!.bytes;
          this.entries.delete(key);
        }
      }
      this.pending.delete(work.key);
      work.resolve(value);
    } catch (error) {
      if (this.disposed) return;
      if (epoch !== work.epoch) {
        this.metrics.retries++;
        this.queue.push(work);
        return;
      }
      this.pending.delete(work.key);
      work.reject(error);
    } finally {
      this.running--;
      this.pump();
    }
  }

  dispose() {
    this.disposed = true;
    for (const work of this.pending.values()) work.reject(new Error('Document cache closed'));
    this.pending.clear();
    this.queue = [];
    this.entries.clear();
    this.bytes = 0;
  }

  stats() {
    return {
      ...this.metrics,
      entries: this.entries.size,
      bytes: this.bytes,
      running: this.running,
      queued: this.queue.length,
    };
  }
}
