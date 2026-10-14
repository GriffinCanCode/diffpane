import { searchFiles, type SearchableFile } from './file-search.ts';

type Hit<T> = { file: T; positions: number[]; score?: number };
type Query<T> = {
  id: number;
  query: string;
  resolve: (value: Hit<T>[] | null) => void;
  reject: (reason: Error) => void;
  generation: number;
};

/** Small projects stay synchronous; large searches never block input or editor painting. */
export function createFileSearch<T extends SearchableFile>() {
  let files: T[] = [];
  let worker: Worker | undefined;
  let running: Query<T> | undefined;
  let queued: Query<T> | undefined;
  let sequence = 0;
  let generation = 0;

  function dispatch() {
    if (running || !queued) return;
    running = queued;
    queued = undefined;
    worker!.postMessage({ id: running.id, query: running.query });
  }

  function cancelQueued() {
    if (queued) {
      queued.resolve(null);
      queued = undefined;
    }
  }

  function releaseWorker() {
    const previous = worker;
    worker = undefined;
    if (previous) {
      previous.onmessage = previous.onerror = null;
      previous.terminate();
    }
    running?.resolve(null);
    running = undefined;
  }

  return {
    setFiles(next: T[]) {
      files = next;
      generation++;
      cancelQueued();
      if (files.length >= 5000) {
        if (!worker) {
          worker = new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module' });
          worker.onmessage = ({
            data,
          }: MessageEvent<{ id: number; matches: { index: number; positions: number[] }[] }>) => {
            const work = running;
            if (!work || data.id !== work.id) return;
            running = undefined;
            work.resolve(
              work.generation === generation && !queued
                ? data.matches.map(({ index, positions }) => ({ file: files[index], positions }))
                : null,
            );
            dispatch();
          };
          worker.onerror = () => {
            worker?.terminate();
            worker = undefined;
            running?.reject(new Error('File search failed. Close search and try again.'));
            queued?.reject(new Error('File search failed. Close search and try again.'));
            running = queued = undefined;
          };
        }
        worker.postMessage({ files: files.map((file, index) => ({ path: file.path, index })) });
      } else releaseWorker();
    },
    search(query: string): Hit<T>[] | Promise<Hit<T>[] | null> {
      if (files.length < 5000 || !query.trim()) {
        cancelQueued();
        generation++;
        return searchFiles(files, query);
      }
      if (!worker) throw new Error('File search unavailable. Close search and try again.');
      cancelQueued();
      return new Promise((resolve, reject) => {
        queued = { id: ++sequence, query, resolve, reject, generation };
        dispatch();
      });
    },
    cancel() {
      generation++;
      cancelQueued();
    },
    dispose() {
      generation++;
      cancelQueued();
      releaseWorker();
      files = [];
    },
  };
}
