import { parentPort } from 'node:worker_threads';
import { decorations } from './changes.ts';

const port = parentPort;
if (!port) throw new Error('Diff worker requires a parent port');

port.on('message', ({ id, before, after }: { id: number; before: string; after: string }) => {
  try {
    port.postMessage({ id, value: decorations(before, after) });
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
