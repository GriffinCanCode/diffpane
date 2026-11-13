import { isUtf8 } from 'node:buffer'
import path from 'node:path'

export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024
const MAX_HEX_BYTES = 64 * 1024
const BINARY_EXTENSIONS = new Set([
  'bin',
  'zip',
  'gz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'tar',
  'dmg',
  'iso',
  'exe',
  'dll',
  'so',
  'dylib',
  'o',
  'a',
  'class',
  'pyc',
  'wasm',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'db',
  'sqlite',
  'sqlite3',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'heic',
  'heif',
  'tif',
  'tiff',
  'psd',
])
const MEDIA_EXTENSIONS = [
  ['image', ['png', 'jpeg', 'jpg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']],
  ['audio', ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus']],
  ['video', ['mp4', 'm4v', 'webm', 'ogv', 'mov']],
  ['pdf', ['pdf']],
] as const
type MediaKind = (typeof MEDIA_EXTENSIONS)[number][0]
const MEDIA_KINDS = new Map(
  MEDIA_EXTENSIONS.flatMap(([kind, extensions]) =>
    extensions.map((extension): [string, MediaKind] => [extension, kind]),
  ),
)
const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogv: 'video/ogg',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
}
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const utf16le = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true })
const utf16be = new TextDecoder('utf-16be', { fatal: true, ignoreBOM: true })
const windows1252 = new TextDecoder('windows-1252')
const mediaSignatures = (
  [
    ['png', '\x89PNG\r\n\x1a\n'],
    ['jpg', '\xff\xd8\xff'],
    ['gif', 'GIF87a'],
    ['gif', 'GIF89a'],
    ['pdf', '%PDF-'],
    ['flac', 'fLaC'],
    ['mp3', 'ID3'],
    ['webm', '\x1a\x45\xdf\xa3'],
  ] as const
).map(([extension, signature]) => [extension, Buffer.from(signature, 'latin1')] as const)
const riffSignature = Buffer.from('RIFF')
const oggSignature = Buffer.from('OggS')
const theoraSignature = Buffer.from('theora')
const hexDigits = Buffer.from('0123456789abcdef')
let legacyBytes: Map<string, number> | undefined

interface ContentInput {
  note?: string | null
  bytes?: Buffer
  size?: number
  streamed?: boolean
}

interface FilePreview {
  size: number
  note: string | null
  hex?: string
  hexBytes?: number
}

export type FileContent =
  | (FilePreview & { kind: 'unavailable' })
  | (FilePreview & { kind: 'text'; value: string; limited?: boolean })
  | (FilePreview & { kind: 'binary'; mime?: string })
  | (FilePreview & { kind: MediaKind; mime: string; data?: string })

export function readLimit(filename: string) {
  return MEDIA_KINDS.has(path.extname(filename).slice(1).toLowerCase()) ? MAX_MEDIA_BYTES : MAX_FILE_BYTES
}

export function searchableText(bytes: Buffer, filename: string) {
  const { extension, format } = documentFormat(bytes, filename)
  if (format) return null
  const text = textContent(bytes, extension, false)
  return text && !text.limited ? text.value : null
}

export function fileByteView(input: Buffer | ContentInput) {
  const bytes = Buffer.isBuffer(input) ? input : input.bytes
  if (!bytes) throw new Error('The file preview has no bytes.')
  return {
    hex: hexDump(bytes.subarray(0, MAX_HEX_BYTES)),
    hexBytes: Math.min(bytes.length, MAX_HEX_BYTES),
  }
}

/** Every regular file has a bounded byte view, even when its format cannot be rendered. */
export function fileContent(input: Buffer | ContentInput, filename: string, includeRaw = false): FileContent {
  const isBuffer = Buffer.isBuffer(input)
  if (!isBuffer && input.note) return { kind: 'unavailable', note: input.note, size: 0 }
  const bytes = isBuffer ? input : input.bytes
  if (!bytes) throw new Error('The file preview has no bytes.')
  const size = (isBuffer ? undefined : input.size) ?? bytes.length
  const truncated = size > bytes.length
  const streamed = !isBuffer && input.streamed === true
  if (!size) return { kind: 'text', value: '', note: null, size: 0 }
  const { extension, format } = documentFormat(bytes, filename)
  if (format) {
    const byteView = fileByteView(bytes)
    const { kind, extension: type } = format
    const mime = MIME_TYPES[type] ?? `${kind}/${type}`
    return {
      size,
      ...byteView,
      kind: truncated && !streamed ? 'binary' : kind,
      mime,
      ...(truncated || streamed ? {} : { data: bytes.toString('base64') }),
      note:
        truncated && !streamed
          ? `File exceeds the ${readLimit(filename) / 1024 / 1024} MiB media preview limit. Inspect its first ${byteView.hexBytes.toLocaleString()} bytes below.`
          : null,
    }
  }
  const text = textContent(bytes, extension, truncated)
  if (!text)
    return {
      size,
      ...fileByteView(bytes),
      kind: 'binary',
      note: 'Binary file. Showing hexadecimal bytes and ASCII.',
    }
  return {
    size,
    ...(text.limited || includeRaw ? fileByteView(bytes) : {}),
    kind: 'text',
    ...text,
  }
}

function documentFormat(bytes: Buffer, filename: string) {
  const extension = path.extname(filename).slice(1).toLowerCase()
  const detected = detectMedia(bytes) ?? extension
  const kind = MEDIA_KINDS.get(detected)
  return { extension, format: kind ? { kind, extension: detected } : null }
}

function textContent(bytes: Buffer, extension: string, truncated: boolean) {
  const decoded = BINARY_EXTENSIONS.has(extension) ? null : decodeText(bytes, truncated)
  if (!decoded) return null
  let value = decoded.value
  let note = decoded.note
  if (truncated) note = 'File exceeds the 2 MiB text preview limit. Showing the beginning of the file.'
  let longLineEnd = -1
  let start = 0
  let lines = 0
  while (start < value.length) {
    if (lines === 50_000) {
      value = value.slice(0, start - 1)
      note = 'File exceeds the 50000-line preview limit. Showing the first 50000 lines.'
      break
    }
    const newline = value.indexOf('\n', start)
    const end = newline < 0 ? value.length : newline
    // UTF-8 uses at most three bytes per UTF-16 code unit; short lines need no slice.
    if (longLineEnd < 0 && (end - start) * 3 > 16 * 1024 && Buffer.byteLength(value.slice(start, end)) > 16 * 1024)
      longLineEnd = end
    lines++
    start = newline < 0 ? value.length : newline + 1
  }
  if (longLineEnd >= 0) {
    value = value.slice(0, Math.min(longLineEnd, 64 * 1024))
    note = `${note ? `${note} ` : ''}File contains a line longer than 16 KiB. Showing a bounded text preview.`
  }
  // A cached substring must not pin the entire decoded input behind a small preview.
  // UTF-16 preserves every code unit, including a surrogate at the preview boundary.
  if (value.length !== decoded.value.length) value = Buffer.from(value, 'utf16le').toString('utf16le')
  const limited = truncated ? true : note === null ? undefined : /preview|50000/u.test(note)
  return { value, note, limited }
}

function decodeText(bytes: Buffer, truncated: boolean) {
  let decoder = utf8
  let start = 0
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    decoder = utf16le
    start = 2
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    decoder = utf16be
    start = 2
  }
  // A streaming decode can retain an incomplete code point at the preview boundary.
  // Keep that state local to this read so the next file starts with a clean decoder.
  const activeDecoder = truncated ? new TextDecoder(decoder.encoding, { fatal: true, ignoreBOM: true }) : decoder
  try {
    const value = activeDecoder.decode(start ? bytes.subarray(start) : bytes, { stream: truncated })
    if (hasBinaryControls(value)) return null
    return { value, note: decoder === utf8 ? null : `Decoded as ${decoder.encoding.toUpperCase()}.` }
  } catch {
    if (decoder !== utf8) return null
    // Unmarked legacy text has no universal encoding; expose the chosen fallback explicitly.
    const value = windows1252.decode(bytes)
    if (hasBinaryControls(value) || value.includes('\uFFFD')) return null
    return { value, note: 'Decoded as Windows-1252 (no Unicode encoding marker).' }
  }
}

/** Keep the source encoding; never silently replace unsupported legacy characters. */
export function encodeText(value: string, original: Buffer) {
  if (original[0] === 0xff && original[1] === 0xfe)
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')])
  if (original[0] === 0xfe && original[1] === 0xff)
    return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(value, 'utf16le').swap16()])
  if (isUtf8(original)) return Buffer.from(value, 'utf8')
  legacyBytes ??= new Map(Array.from({ length: 256 }, (_, byte) => [windows1252.decode(Uint8Array.of(byte)), byte]))
  const bytes = Buffer.allocUnsafe(value.length)
  for (let offset = 0; offset < value.length; offset++) {
    const byte = legacyBytes.get(value.charAt(offset))
    if (byte === undefined) throw new Error('This character cannot be saved in Windows-1252. The edits are still open.')
    bytes[offset] = byte
  }
  return bytes
}

function hasBinaryControls(value: string) {
  // oxlint-disable-next-line no-control-regex -- Binary detection intentionally matches control bytes.
  return /[\u0000-\u0008\u000e-\u001a\u001c-\u001f\u007f-\u009f]/.test(value)
}

function detectMedia(bytes: Buffer) {
  for (const [extension, signature] of mediaSignatures) {
    if (bytes[0] === signature[0] && bytes.subarray(0, signature.length).equals(signature)) return extension
  }
  if (bytes[0] === riffSignature[0] && bytes.subarray(0, 4).equals(riffSignature)) {
    const format = bytes.toString('ascii', 8, 12)
    if (format === 'WEBP') return 'webp'
    if (format === 'WAVE') return 'wav'
  }
  if (bytes[0] === oggSignature[0] && bytes.subarray(0, 4).equals(oggSignature))
    return bytes.includes(theoraSignature) ? 'ogv' : 'ogg'
  if (bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12)
    return brand === 'avif' || brand === 'avis' ? 'avif' : brand === 'M4A ' ? 'm4a' : 'mp4'
  }
  return undefined
}

function hexDump(bytes: Buffer) {
  const bytesPerRow = 16
  const addressWidth = 8
  const hexStart = addressWidth + 2
  const firstBar = hexStart + bytesPerRow * 3 + 1
  const asciiStart = firstBar + 1
  const rowWidth = asciiStart + bytesPerRow + 2
  const space = 32
  const dot = 46
  const bar = 124
  const newline = 10
  const output = Buffer.allocUnsafe(Math.ceil(bytes.length / bytesPerRow) * rowWidth)
  let row = 0
  for (let offset = 0; offset < bytes.length; offset += bytesPerRow) {
    let address = offset
    for (let digit = addressWidth - 1; digit >= 0; digit--) {
      output[row + digit] = hexDigits.readUInt8(address & 0xf)
      address >>>= 4
    }
    output[row + addressWidth] = space
    output[row + addressWidth + 1] = space
    let hex = row + hexStart
    let ascii = row + asciiStart
    const end = Math.min(offset + bytesPerRow, bytes.length)
    for (let index = offset; index < end; index++) {
      const byte = bytes.readUInt8(index)
      output[hex++] = hexDigits.readUInt8(byte >>> 4)
      output[hex++] = hexDigits.readUInt8(byte & 0xf)
      output[hex++] = space
      output[ascii++] = byte >= 32 && byte <= 126 ? byte : dot
    }
    output.fill(space, hex, row + firstBar)
    output[row + firstBar] = bar
    output[ascii++] = bar
    output[ascii++] = newline
    row = ascii
  }
  return output.toString('latin1', 0, Math.max(0, row - 1))
}
