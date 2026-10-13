import { Worker } from 'node:worker_threads';
import type { DiffDecorations } from './changes.ts';

type Pending = {
  resolve: (value: DiffDecorations) => void;
  reject: (reason: Error) => void;
};

/** Keep CPU-heavy diffing off the Git/watch/language event loop. Callers bound the queue. */
export class DiffRuntime {
  pending = new Map<number, Pending>();
  sequence = 0;
  worker?: Worker | null;
  disposed?: boolean;

  calculate(before: string, after: string): Promise<DiffDecorations> {
    if (this.disposed) return Promise.reject(new Error('Diff worker closed'));
    if (before === after)
      return Promise.resolve({
        decorations: [],
        beforeDecorations: [],
        additions: 0,
        deletions: 0,
      });
    if (!this.worker) {
      const worker = new Worker(new URL('./diff-worker.ts', import.meta.url));
      this.worker = worker;
      worker.on(
        'message',
        ({ id, value, error }: { id: number; value: DiffDecorations; error?: string }) => {
          const request = this.pending.get(id);
          if (!request) return;
          this.pending.delete(id);
          if (error) request.reject(new Error(error));
          else request.resolve(value);
        },
      );
      const fail = (error: Error) => {
        if (this.worker !== worker) return;
        this.worker = null;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        void worker.terminate();
      };
      worker.on('error', fail);
      worker.on('exit', code => fail(new Error(`Diff worker exited (${code})`)));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, before, after });
    });
  }

  async dispose() {
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    for (const request of this.pending.values()) request.reject(new Error('Diff worker closed'));
    this.pending.clear();
    await worker?.terminate();
  }
}
