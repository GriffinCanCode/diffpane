import { diffLines } from 'diff';
import { countLines } from '../text-lines.ts';

export type LineDecoration = {
  startLine: number;
  endLine: number;
  kind: 'added' | 'modified' | 'deleted';
};

/** Line markers on both versions. Character-level diffs are deliberately never computed. */
export type DiffDecorations = {
  decorations: LineDecoration[];
  beforeDecorations: LineDecoration[];
  additions: number | null;
  deletions: number | null;
  diffNote?: string;
};

export function decorations(before: string, after: string): DiffDecorations {
  if (before === after)
    return { decorations: [], beforeDecorations: [], additions: 0, deletions: 0 };
  const segments = diffLines(before.replaceAll('\r\n', '\n'), after.replaceAll('\r\n', '\n'), {
    timeout: 150,
  });
  const maxLine = countLines(after);
  const beforeMaxLine = countLines(before);
  const coarse = (note: string): DiffDecorations => ({
    decorations: [{ startLine: 1, endLine: maxLine, kind: 'modified' }],
    beforeDecorations: [{ startLine: 1, endLine: beforeMaxLine, kind: 'modified' }],
    additions: null,
    deletions: null,
    diffNote: note,
  });
  if (!segments) return coarse('Detailed change highlighting exceeded its time budget.');
  let line = 1;
  let originalLine = 1;
  let removed = 0;
  let additions = 0;
  let deletions = 0;
  const output: LineDecoration[] = [];
  const original: LineDecoration[] = [];
  const range = (
    list: LineDecoration[],
    startLine: number,
    count: number,
    kind: LineDecoration['kind'],
  ) => {
    if (count) list.push({ startLine, endLine: startLine + count - 1, kind });
  };
  const deletion = () => range(output, Math.min(line, maxLine), 1, 'deleted');
  for (let index = 0; index < segments.length; index++) {
    if (output.length + original.length > 10000)
      return coarse('Detailed change highlighting exceeded its decoration budget.');
    const segment = segments[index];
    if (segment.removed) {
      deletions += segment.count;
      removed = segment.count;
      const replaced = Math.min(
        removed,
        segments[index + 1]?.added ? segments[index + 1].count : 0,
      );
      range(original, originalLine, replaced, 'modified');
      range(original, originalLine + replaced, removed - replaced, 'deleted');
      originalLine += removed;
    } else if (segment.added) {
      additions += segment.count;
      const replaced = Math.min(removed, segment.count);
      range(output, line, replaced, 'modified');
      range(output, line + replaced, segment.count - replaced, 'added');
      if (segment.count > replaced)
        range(original, Math.min(originalLine, beforeMaxLine), 1, 'added');
      line += segment.count;
      if (removed > replaced) deletion();
      removed = 0;
    } else {
      if (removed) deletion();
      removed = 0;
      line += segment.count;
      originalLine += segment.count;
    }
  }
  if (removed) deletion();
  return { decorations: output, beforeDecorations: original, additions, deletions };
}
