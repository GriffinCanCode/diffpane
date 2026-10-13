const callableKinds = new Set([5, 8, 11]); // Monaco Method, Constructor, Function.
const controls = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'match']);

export type FunctionRange = { startLine: number; endLine: number; name: string };
type LineChange = { startLine: number; endLine?: number };
type OutlineSymbol = {
  kind: number;
  name: string;
  range?: { startLineNumber: number; endLineNumber: number };
  children?: OutlineSymbol[];
};

/** Prefer language-server ranges; a bounded lexical fallback also works before a server starts. */
export function changedFunctionRanges(
  text: string,
  changes: readonly LineChange[],
  symbols: readonly OutlineSymbol[] = [],
) {
  const functions: FunctionRange[] = [];
  const visit = (items: readonly OutlineSymbol[]) => {
    for (const symbol of items) {
      if (callableKinds.has(symbol.kind) && symbol.range)
        functions.push({
          startLine: symbol.range.startLineNumber,
          endLine: symbol.range.endLineNumber,
          name: symbol.name,
        });
      visit(symbol.children ?? []);
    }
  };
  visit(symbols);
  if (!functions.length) functions.push(...lexicalFunctions(text));
  const intervals = changes
    .map(change => ({ start: change.startLine, end: change.endLine ?? change.startLine }))
    .sort((a, b) => a.start - b.start);
  return functions.filter(fn => {
    // Changes are non-overlapping line ranges from the diff worker.
    let low = 0;
    let high = intervals.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (intervals[middle].end < fn.startLine) low = middle + 1;
      else high = middle;
    }
    return low < intervals.length && intervals[low].start <= fn.endLine;
  });
}

function lexicalFunctions(text: string) {
  const lines = text.split('\n');
  const depths: { before: number; after: number }[] = [];
  const clean: string[] = [];
  let depth = 0;
  let quote = '';
  let block = false;
  for (const line of lines) {
    let value = '';
    const before = depth;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      const next = line[index + 1];
      if (block) {
        if (char === '*' && next === '/') {
          block = false;
          index++;
        }
        continue;
      }
      if (quote) {
        if (char === '\\') index++;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '/' && next === '/') break;
      if (char === '#') break;
      if (char === '/' && next === '*') {
        block = true;
        index++;
        continue;
      }
      if (['"', "'", '`'].includes(char)) {
        quote = char;
        continue;
      }
      value += char;
      if (char === '{') depth++;
      if (char === '}') depth--;
    }
    // Ordinary quoted strings cannot continue across a physical line without an escape.
    if (quote !== '`' && !line.endsWith('\\')) quote = '';
    depths.push({ before, after: depth });
    clean.push(value);
  }
  const functions: FunctionRange[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = clean[index];
    const declaration = line.match(
      /\b(?:function\s*\*?\s*|defp?\s+|defmacro\s+|fn\s+|func\s+|fun\s+)([\w$!?]+)/,
    );
    const arrow = line.match(/\b(?:const|let|var)\s+([\w$]+)\s*=.*=>/);
    const method = line.match(
      /^\s*(?:(?:public|private|protected|static|async|override|export)\s+)*([\w$]+)\s*\([^;]*\)\s*(?::[^=]+)?\s*\{/,
    );
    const name = declaration?.[1] ?? arrow?.[1] ?? method?.[1];
    if (!name || controls.has(name)) continue;
    let end = index;
    const indent = lines[index].match(/^\s*/)![0].length;
    if (/\bdef\s/.test(line) && /:\s*$/.test(line)) {
      while (
        end + 1 < lines.length &&
        (!clean[end + 1].trim() || lines[end + 1].match(/^\s*/)![0].length > indent)
      )
        end++;
    } else if (/\bdef(?:p|macro)?\s/.test(line) && /\bdo\s*$/.test(line)) {
      let balance = 1;
      while (end + 1 < lines.length && balance > 0) {
        end++;
        balance +=
          (clean[end].match(/\bdo\b(?!:)/g) ?? []).length -
          (clean[end].match(/\bend\b/g) ?? []).length;
      }
    } else {
      let body = index;
      while (
        body < Math.min(lines.length, index + 12) &&
        !clean[body].includes('{') &&
        !clean[body].includes(';')
      )
        body++;
      if (body < lines.length && clean[body].includes('{')) {
        end = body;
        const base = depths[body].before;
        while (end + 1 < lines.length && depths[end].after > base) end++;
      }
    }
    functions.push({ startLine: index + 1, endLine: end + 1, name });
  }
  return functions;
}
