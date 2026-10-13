import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { isMarkdown, markdownTarget } from '../renderer/markdown-paths.ts';

test('Markdown paths resolve relative links and Unicode anchors within the project', () => {
  assert.equal(isMarkdown('docs/README.MD'), true);
  assert.equal(isMarkdown('readme.md.js'), false);
  assert.deepEqual(markdownTarget('docs/guide.md', '../README.md#hello%20world'), {
    path: 'README.md',
    anchor: 'hello world',
  });
  assert.deepEqual(markdownTarget('docs/guide.md', '#details'), {
    path: 'docs/guide.md',
    anchor: 'details',
  });
  assert.deepEqual(markdownTarget('docs/guide.md', '/images/photo%20%23%20%E9%9B%AA.png'), {
    path: 'images/photo # 雪.png',
    anchor: '',
  });
});

test('Markdown file links reject external schemes, malformed encoding and project escapes', () => {
  for (const href of [
    '../../secret',
    '%2e%2e/%2e%2e/secret',
    'file:///etc/passwd',
    'https://example.com',
    '//example.com/a',
    'javascript:alert(1)',
    'data:text/html,x',
    '%00secret',
    '..%5csecret',
    '%ff',
  ])
    assert.equal(markdownTarget('docs/guide.md', href), null, href);
});
