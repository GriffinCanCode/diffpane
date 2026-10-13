import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

async function documents(directory = '.') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'release', 'target', 'test-results'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await documents(file));
    else if (entry.name.endsWith('.md')) result.push(file);
  }
  return result;
}

test('documentation source assertions remain true', async () => {
  for (const file of await documents()) {
    const text = await readFile(file, 'utf8');
    assert.ok(text.startsWith('---\n'), `${file}: missing doc radar frontmatter`);
    const end = text.indexOf('\n---', 4);
    assert.ok(end > 0, `${file}: invalid frontmatter`);
    const metadata = parse(text.slice(4, end));
    for (const sentinel of metadata.doc_radar.sentinels) {
      const source = await readFile(sentinel.file, 'utf8');
      for (const claim of sentinel.contains) assert.ok(source.includes(claim), `${file}: ${sentinel.file} no longer contains ${claim}`);
    }
  }
});
