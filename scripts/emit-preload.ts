import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2023,
    verbatimModuleSyntax: false,
  },
});
const script = outputText
  .replace('"use strict";\n', '')
  .replace('Object.defineProperty(exports, "__esModule", { value: true });\n', '');
writeFileSync(new URL('../electron/preload.cjs', import.meta.url), script);
