import { performance } from 'node:perf_hooks';
import { diffLines, diffChars } from 'diff';

export function decorations(before, after) {
  const start = performance.now();
  const segments = diffLines(before.replaceAll('\r\n', '\n'), after.replaceAll('\r\n', '\n'), { timeout: 150 });
  const maxLine = Math.max(1, after.split('\n').length);
  if (!segments) return { decorations: [{ startLine: 1, endLine: maxLine, kind: 'modified' }], additions: null, deletions: null, diffNote: 'Detailed change highlighting exceeded its time budget.' };
  let line = 1;
  let removed = [];
  let additions = 0;
  let deletions = 0;
  const output = [];
  for (const segment of segments) {
    if (segment.removed) {
      deletions += segment.count;
      removed = segment.value.split('\n');
      if (removed.at(-1) === '') removed.pop();
    } else if (segment.added) {
      additions += segment.count;
      output.push({ startLine: line, endLine: line + segment.count - 1, kind: removed.length ? 'modified' : 'added' });
      const inserted = segment.value.split('\n');
      for (let index = 0; index < Math.min(removed.length, inserted.length); index++) {
        if (performance.now() - start > 200) break;
        const chars = diffChars(removed[index], inserted[index], { timeout: 5 });
        if (!chars) continue;
        let column = 1;
        for (const part of chars) {
          if (part.added) output.push({ startLine: line + index, endLine: line + index, startColumn: column, endColumn: column + part.value.length, kind: 'word' });
          if (!part.removed) column += part.value.length;
        }
      }
      line += segment.count;
      removed = [];
    } else {
      if (removed.length) output.push({ startLine: Math.min(line, maxLine), endLine: Math.min(line, maxLine), kind: 'deleted' });
      removed = [];
      line += segment.count;
    }
  }
  if (removed.length) output.push({ startLine: Math.min(line, maxLine), endLine: Math.min(line, maxLine), kind: 'deleted' });
  return { decorations: output, additions, deletions };
}

