import test from 'node:test';
import assert from 'node:assert/strict';
import { decorations } from '../electron/changes.mjs';

test('decorations only address modified text and preserve UTF-16 editor columns', () => {
  const result = decorations('const value = "😀 before";\nold();\n', 'const value = "😀 after";\nnew();\nadded();\n');
  assert.equal(result.additions, 3);
  assert.equal(result.deletions, 2);
  assert.ok(result.decorations.some(decoration => decoration.kind === 'modified'));
  for (const decoration of result.decorations) {
    assert.ok(decoration.startLine >= 1 && decoration.endLine <= 3);
    if (decoration.kind === 'word') assert.ok(decoration.endColumn >= decoration.startColumn);
  }
});
test('pure removals use a current-line marker without original content', () => {
  const result = decorations('one\nremoved\nthree\n', 'one\nthree\n');
  assert.deepEqual(result.decorations, [{ startLine: 2, endLine: 2, kind: 'deleted' }]);
  assert.equal(result.deletions, 1);
});
test('CRLF alone does not repaint lines', () => {
  assert.deepEqual(decorations('one\r\ntwo\r\n', 'one\ntwo\n').decorations, []);
});
