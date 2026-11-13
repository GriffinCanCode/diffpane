import assert from 'node:assert/strict'
import type { LanguageRuntime } from '../electron/language.mjs'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isDiagnosticError(value: unknown) {
  return isRecord(value) && value.severity === 1
}

interface SymbolResult {
  name: string
  children?: SymbolResult[]
}

function isSymbol(value: unknown, depth: number): value is SymbolResult {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    (value.children === undefined ||
      (depth < 128 &&
        Array.isArray(value.children) &&
        value.children.every((child: unknown) => isSymbol(child, depth + 1))))
  )
}

export function documentSymbols(result: unknown): SymbolResult[] {
  assert.ok(Array.isArray(result) && result.every((item: unknown) => isSymbol(item, 0)), 'Expected document symbols')
  return result.filter((item: unknown) => isSymbol(item, 0))
}

export function symbolCount(symbols: readonly SymbolResult[]): number {
  return symbols.reduce((total, symbol) => total + 1 + symbolCount(symbol.children ?? []), 0)
}

export function hasHover(result: unknown) {
  return isRecord(result) && Boolean(result.contents)
}

export function tokenCount(result: unknown) {
  return isRecord(result) &&
    Array.isArray(result.data) &&
    result.data.every((item: unknown) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)
    ? result.data.length
    : 0
}

export function serverPid(runtime: LanguageRuntime, language: string) {
  const pid = runtime.status().find(server => server.language === language)?.pid
  assert.ok(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0, `Expected a running ${language} process`)
  return pid
}
