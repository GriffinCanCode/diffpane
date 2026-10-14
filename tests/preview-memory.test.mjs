import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('cached bounded previews release the large decoded source buffers', () => {
  // Use an isolated GC-enabled process to measure retained external string storage.
  // Heap-only measurements miss the TextDecoder backing memory in this regression.
  const reader = new URL('../electron/file-content.ts', import.meta.url).href;
  const cache = new URL('../electron/document-cache.ts', import.meta.url).href;
  const output = execFileSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '-e',
      `
        import { fileContent, MAX_FILE_BYTES } from ${JSON.stringify(reader)};
        import { DocumentCache } from ${JSON.stringify(cache)};
        global.gc();
        global.gc();
        const initial = process.memoryUsage().external;
        const cache = new DocumentCache(async path => ({
          preview: { after: fileContent(Buffer.alloc(MAX_FILE_BYTES, 65 + Number(path)), 'large.txt') },
        }));
        for (let index = 0; index < 24; index++) await cache.get(String(index), 'head');
        global.gc();
        global.gc();
        console.log(JSON.stringify({
          externalBytes: process.memoryUsage().external - initial,
          stats: cache.stats(),
        }));
        cache.dispose();
      `,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  const result = JSON.parse(output);
  assert.ok(result.stats.entries >= 16, 'the regression must retain many bounded previews');
  assert.ok(result.stats.bytes <= 16 * 1024 * 1024);
  assert.ok(
    result.externalBytes < 8 * 1024 * 1024,
    `small previews pinned large decoded inputs: ${JSON.stringify(result)}`,
  );
});
