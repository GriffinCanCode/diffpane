import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { descendants } from './k6/process-memory.ts';

test('memory accounting includes grandchildren, detached servers and Git; excludes harness and unrelated apps', () => {
  const source = `
    94 93 1000 node harness
    97 96 99000 other Electron
    102 101 8000 language-server
    104 100 3000 git status
    101 100 12000 Renderer
    100 94 40000 Electron
    103 101 2000 helper
  `;
  const processes = descendants(source, 100);
  assert.deepEqual(
    processes.map(process => process.pid).sort((a, b) => a - b),
    [100, 101, 102, 103, 104],
  );
  assert.equal(
    processes.reduce((sum, process) => sum + process.rssBytes, 0),
    65000 * 1024,
  );
  assert.equal(processes.find(process => process.pid === 104).command, 'git status');
});
