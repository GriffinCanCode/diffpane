import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { changedFunctionRanges } from '../renderer/function-ranges.ts';

const changes = (...lines) =>
  lines.map(startLine => ({ startLine, endLine: startLine, kind: 'modified' }));
test('whole changed functions are selected while unchanged siblings stay unmarked', () => {
  const source = [
    'export function first() {',
    '  return "{";',
    '}',
    '',
    'export function second() {',
    '  return 2;',
    '}',
    '',
    'const arrow = () => {',
    '  return 3;',
    '};',
  ].join('\n');
  assert.deepEqual(changedFunctionRanges(source, changes(6, 10)), [
    { startLine: 5, endLine: 7, name: 'second' },
    { startLine: 9, endLine: 11, name: 'arrow' },
  ]);
  assert.deepEqual(changedFunctionRanges(source, changes(4)), []);
});
test('Python indentation and Elixir end blocks bound function context', () => {
  const python = 'def first():\n    return 1\n\ndef second():\n    return 2\n';
  assert.deepEqual(changedFunctionRanges(python, changes(5)), [
    { startLine: 4, endLine: 6, name: 'second' },
  ]);
  const elixir = 'def first do\n  if true do\n    1\n  end\nend\ndef second do\n  2\nend';
  assert.deepEqual(changedFunctionRanges(elixir, changes(3)), [
    { startLine: 1, endLine: 5, name: 'first' },
  ]);
});
test('language-server function ranges take precedence and nested methods are found', () => {
  const symbols = [
    {
      kind: 4,
      children: [{ kind: 5, name: 'method', range: { startLineNumber: 3, endLineNumber: 12 } }],
    },
  ];
  assert.deepEqual(changedFunctionRanges('non-JavaScript syntax', changes(7), symbols), [
    { startLine: 3, endLine: 12, name: 'method' },
  ]);
});
