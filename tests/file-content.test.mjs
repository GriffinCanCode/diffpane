import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import {
  fileContent,
  MAX_FILE_BYTES,
  MAX_MEDIA_BYTES,
  readLimit,
} from '../electron/file-content.ts';

test('unknown extensions, extensionless files, Unicode and legacy encodings remain readable', () => {
  for (const name of ['custom.weird', 'README', '.config', 'data.json']) {
    assert.equal(fileContent(Buffer.from('hello 雪\r\n'), name).value, 'hello 雪\r\n');
  }
  const utf16 = Buffer.from('hello 雪\n', 'utf16le');
  for (const [bom, bytes, encoding] of [
    [[0xff, 0xfe], utf16, 'UTF-16LE'],
    [[0xfe, 0xff], Buffer.from(utf16).swap16(), 'UTF-16BE'],
  ]) {
    const result = fileContent(Buffer.concat([Buffer.from(bom), bytes]), 'text');
    assert.equal(result.value, 'hello 雪\n');
    assert.match(result.note, new RegExp(encoding));
  }
  const legacy = fileContent(
    Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x78, 0x94]),
    'legacy.txt',
  );
  assert.equal(legacy.value, 'café “x”');
  assert.match(legacy.note, /Windows-1252/);
});

test('binary inspection preserves byte offsets and ASCII and bounds its payload', () => {
  const bytes = Buffer.alloc(128 * 1024, 0);
  bytes.write('Test');
  const result = fileContent(bytes, 'unknown');
  assert.equal(result.kind, 'binary');
  assert.equal(result.size, bytes.length);
  assert.equal(result.hexBytes, 65536);
  assert.match(result.hex, /^00000000  54 65 73 74 00/);
  assert.match(result.hex, /\|Test\.{12}\|/);
  assert.equal(result.hex.split('\n').length, 4096);
});

test('native formats use explicit MIME types and common magic identifies extensionless media', () => {
  const fixtures = [
    ['photo.PNG', [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10], 'image', 'image/png'],
    ['unknown', [...Buffer.from('%PDF-1.7')], 'pdf', 'application/pdf'],
    ['sound.wav', [...Buffer.from('RIFF0000WAVE')], 'audio', 'audio/wav'],
    ['clip.webm', [0x1a, 0x45, 0xdf, 0xa3], 'video', 'video/webm'],
    ['vector.svg', [...Buffer.from('<svg/>')], 'image', 'image/svg+xml'],
  ];
  for (const [name, bytes, kind, mime] of fixtures) {
    const result = fileContent(Buffer.from(bytes), name);
    assert.equal(result.kind, kind, name);
    assert.equal(result.mime, mime, name);
    assert.deepEqual(Buffer.from(result.data, 'base64'), Buffer.from(bytes));
    assert.ok(result.hex);
  }
  assert.equal(readLimit('movie.mp4'), MAX_MEDIA_BYTES);
  assert.equal(readLimit('source.unknown'), MAX_FILE_BYTES);
});

test('oversized and malformed inputs retain bounded text or byte previews', () => {
  const text = fileContent({ bytes: Buffer.from('readable\n'), size: MAX_FILE_BYTES + 1 }, 'large');
  assert.equal(text.value, 'readable\n');
  assert.ok(text.limited);
  assert.match(text.note, /2 MiB/);
  const media = fileContent(
    { bytes: Buffer.from('%PDF-1.7'), size: MAX_MEDIA_BYTES + 1 },
    'large.pdf',
  );
  assert.equal(media.kind, 'binary');
  assert.match(media.note, /16 MiB/);
  assert.equal(media.data, undefined);
  assert.equal(fileContent(Buffer.from([0xff, 0xfe, 0]), 'bad').kind, 'binary');
  assert.equal(fileContent(Buffer.alloc(0), 'deleted.png').kind, 'text');
});
