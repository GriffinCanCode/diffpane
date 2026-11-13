import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import {
  fileContent,
  MAX_FILE_BYTES,
  MAX_MEDIA_BYTES,
  readLimit,
} from '../../../electron/workspace/documents/file-content.ts'

/** @param {Buffer | {bytes: Buffer, size: number}} bytes @param {string} filename */
function readText(bytes, filename) {
  const result = fileContent(bytes, filename)
  assert.equal(result.kind, 'text')
  return result
}

/** @param {string | null} note @param {RegExp} pattern */
function matchNote(note, pattern) {
  assert.ok(typeof note === 'string', 'Expected a file preview note')
  assert.match(note, pattern)
}

test('unknown extensions, extensionless files, Unicode and legacy encodings remain readable', () => {
  for (const name of ['custom.weird', 'README', '.config', 'data.json']) {
    assert.equal(readText(Buffer.from('hello 雪\r\n'), name).value, 'hello 雪\r\n')
  }
  const utf16 = Buffer.from('hello 雪\n', 'utf16le')
  /** @type {ReadonlyArray<readonly [number[], Buffer, string]>} */
  const encodings = [
    [[0xff, 0xfe], utf16, 'UTF-16LE'],
    [[0xfe, 0xff], Buffer.from(utf16).swap16(), 'UTF-16BE'],
  ]
  for (const [bom, bytes, encoding] of encodings) {
    const result = readText(Buffer.concat([Buffer.from(bom), bytes]), 'text')
    assert.equal(result.value, 'hello 雪\n')
    matchNote(result.note, new RegExp(encoding))
  }
  const legacy = readText(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x78, 0x94]), 'legacy.txt')
  assert.equal(legacy.value, 'café “x”')
  matchNote(legacy.note, /Windows-1252/)
})

test('binary inspection preserves byte offsets and ASCII and bounds its payload', () => {
  const bytes = Buffer.alloc(128 * 1024, 0)
  bytes.write('Test')
  const result = fileContent(bytes, 'unknown')
  assert.equal(result.kind, 'binary')
  assert.equal(result.size, bytes.length)
  assert.equal(result.hexBytes, 65536)
  assert.ok(result.hex)
  assert.match(result.hex, /^00000000  54 65 73 74 00/)
  assert.match(result.hex, /\|Test\.{12}\|/)
  assert.equal(result.hex.split('\n').length, 4096)
})

test('native formats use explicit MIME types and common magic identifies extensionless media', () => {
  /** @type {ReadonlyArray<readonly [string, number[], 'image' | 'pdf' | 'audio' | 'video', string]>} */
  const fixtures = [
    ['photo.PNG', [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10], 'image', 'image/png'],
    ['unknown', [...Buffer.from('%PDF-1.7')], 'pdf', 'application/pdf'],
    ['sound.wav', [...Buffer.from('RIFF0000WAVE')], 'audio', 'audio/wav'],
    ['clip.webm', [0x1a, 0x45, 0xdf, 0xa3], 'video', 'video/webm'],
    ['vector.svg', [...Buffer.from('<svg/>')], 'image', 'image/svg+xml'],
  ]
  for (const [name, bytes, kind, mime] of fixtures) {
    const result = fileContent(Buffer.from(bytes), name)
    assert.equal(result.kind, kind, name)
    assert.ok('mime' in result && 'data' in result && typeof result.data === 'string')
    assert.equal(result.mime, mime, name)
    assert.deepEqual(Buffer.from(result.data, 'base64'), Buffer.from(bytes))
    assert.ok(result.hex)
  }
  assert.equal(readLimit('movie.mp4'), MAX_MEDIA_BYTES)
  assert.equal(readLimit('source.unknown'), MAX_FILE_BYTES)
})

test('oversized and malformed inputs retain bounded text or byte previews', () => {
  const text = readText({ bytes: Buffer.from('readable\n'), size: MAX_FILE_BYTES + 1 }, 'large')
  assert.equal(text.value, 'readable\n')
  assert.ok(text.limited)
  matchNote(text.note, /2 MiB/)
  const media = fileContent({ bytes: Buffer.from('%PDF-1.7'), size: MAX_MEDIA_BYTES + 1 }, 'large.pdf')
  assert.equal(media.kind, 'binary')
  matchNote(media.note, /16 MiB/)
  assert.ok(!('data' in media) || media.data === undefined)
  assert.equal(fileContent(Buffer.from([0xff, 0xfe, 0]), 'bad').kind, 'binary')
  assert.equal(fileContent(Buffer.alloc(0), 'deleted.png').kind, 'text')
})

test('line bounds preserve the final newline and truncate only past 50000 complete lines', () => {
  const source = 'line\n'.repeat(50_000)
  const complete = readText(Buffer.from(source), 'lines.txt')
  assert.equal(complete.value, source)
  assert.equal(Boolean(complete.limited), false)
  for (const extra of ['last', '\n']) {
    const limited = readText(Buffer.from(source + extra), 'lines.txt')
    assert.equal(limited.value, source.slice(0, -1))
    matchNote(limited.note, /50000-line/)
  }
})

test('long-line bounds measure UTF-8 bytes and retain the prefix through the first long line', () => {
  for (const line of ['x'.repeat(16 * 1024 + 1), '雪'.repeat(5462), '😀'.repeat(4097)]) {
    const result = readText(Buffer.from(`short\n${line}\nhidden\n`), 'lines.txt')
    assert.equal(result.value, `short\n${line}`)
    matchNote(result.note, /line longer than 16 KiB/)
    assert.ok(result.limited)
  }
  const boundary = `short\n${'x'.repeat(16 * 1024)}\n`
  assert.equal(readText(Buffer.from(boundary), 'lines.txt').value, boundary)
  assert.equal(readText(Buffer.from('x'.repeat(100 * 1024)), 'lines.txt').value.length, 64 * 1024)
})
