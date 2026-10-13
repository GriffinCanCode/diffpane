import path from 'node:path';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
const MAX_HEX_BYTES = 64 * 1024;
const binaryExtensions = new Set([
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
]);
const media = new Map<string, string>(
  (
    [
      ['image', ['png', 'jpeg', 'jpg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']],
      ['audio', ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus']],
      ['video', ['mp4', 'm4v', 'webm', 'ogv', 'mov']],
      ['pdf', ['pdf']],
    ] as const
  ).flatMap(([kind, extensions]) =>
    extensions.map(extension => [extension, kind] as [string, string]),
  ),
);
const mimeTypes: Record<string, string> = {
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
};

type ContentInput = { note?: string | null; bytes?: Buffer; size?: number; streamed?: boolean };

export function readLimit(filename: string) {
  return media.has(path.extname(filename).slice(1).toLowerCase())
    ? MAX_MEDIA_BYTES
    : MAX_FILE_BYTES;
}

/** Every regular file has a bounded byte view, even when its format cannot be rendered. */
export function fileContent(input: Buffer | ContentInput, filename: string, includeRaw = false) {
  if (!Buffer.isBuffer(input) && input.note)
    return { kind: 'unavailable' as const, note: input.note, size: 0 };
  const bytes = Buffer.isBuffer(input) ? input : input.bytes!;
  const size = (!Buffer.isBuffer(input) ? input.size : undefined) ?? bytes.length;
  const truncated = size > bytes.length;
  const streamed = !Buffer.isBuffer(input) && input.streamed === true;
  if (!size) return { kind: 'text' as const, value: '', note: null, size: 0 };
  const extension = path.extname(filename).slice(1).toLowerCase();
  const format =
    detectMedia(bytes) ?? (media.has(extension) ? { kind: media.get(extension), extension } : null);
  const byteView = () => ({
    size,
    hex: hexDump(bytes.subarray(0, MAX_HEX_BYTES)),
    hexBytes: Math.min(bytes.length, MAX_HEX_BYTES),
  });
  if (format) {
    const base = byteView();
    const { kind, extension: type } = format;
    const mime = mimeTypes[type] ?? `${kind}/${type}`;
    return {
      ...base,
      kind: truncated && !streamed ? 'binary' : kind,
      mime,
      ...(truncated || streamed ? {} : { data: bytes.toString('base64') }),
      note:
        truncated && !streamed
          ? `File exceeds the ${readLimit(filename) / 1024 / 1024} MiB media preview limit. Inspect its first ${base.hexBytes.toLocaleString()} bytes below.`
          : null,
    };
  }
  const decoded = binaryExtensions.has(extension) ? null : decodeText(bytes, truncated);
  if (!decoded)
    return {
      ...byteView(),
      kind: 'binary' as const,
      note: 'Binary file. Showing hexadecimal bytes and ASCII.',
    };
  let value = decoded.value;
  let note = decoded.note;
  if (truncated)
    note = 'File exceeds the 2 MiB text preview limit. Showing the beginning of the file.';
  const lines = value.split('\n');
  if (lines.length > 50_001 || (lines.length === 50_001 && lines.at(-1) !== '')) {
    value = lines.slice(0, 50_000).join('\n');
    note = 'File exceeds the 50000-line preview limit. Showing the first 50000 lines.';
  }
  const longLine = value.split('\n').findIndex(line => Buffer.byteLength(line) > 16 * 1024);
  if (longLine >= 0) {
    value = value
      .split('\n')
      .slice(0, longLine + 1)
      .join('\n')
      .slice(0, 64 * 1024);
    note = `${note ? `${note} ` : ''}File contains a line longer than 16 KiB. Showing a bounded text preview.`;
  }
  const limited = truncated || note?.includes('preview') || note?.includes('50000');
  return {
    ...(limited || includeRaw ? byteView() : { size }),
    kind: 'text' as const,
    value,
    note,
    limited,
  };
}

function decodeText(bytes: Buffer, truncated: boolean) {
  let encoding = 'utf-8';
  let start = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    start = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    start = 2;
  }
  try {
    const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
    const value = decoder.decode(bytes.subarray(start), { stream: truncated });
    if (hasBinaryControls(value)) return null;
    return { value, note: encoding === 'utf-8' ? null : `Decoded as ${encoding.toUpperCase()}.` };
  } catch {
    if (encoding !== 'utf-8') return null;
    // Unmarked legacy text has no universal encoding; expose the chosen fallback explicitly.
    const value = new TextDecoder('windows-1252').decode(bytes);
    if (hasBinaryControls(value) || value.includes('\uFFFD')) return null;
    return { value, note: 'Decoded as Windows-1252 (no Unicode encoding marker).' };
  }
}

/** Keep the source encoding; never silently replace unsupported legacy characters. */
export function encodeText(value: string, original: Buffer) {
  if (original[0] === 0xff && original[1] === 0xfe)
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')]);
  if (original[0] === 0xfe && original[1] === 0xff)
    return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(value, 'utf16le').swap16()]);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(original);
    return Buffer.from(value, 'utf8');
  } catch {
    const decoder = new TextDecoder('windows-1252');
    const characters = new Map(
      Array.from({ length: 256 }, (_, byte) => [decoder.decode(Uint8Array.of(byte)), byte]),
    );
    return Buffer.from(
      Array.from(value, character => {
        const byte = characters.get(character);
        if (byte === undefined)
          throw new Error(
            'This character cannot be saved in Windows-1252. The edits are still open.',
          );
        return byte;
      }),
    );
  }
}

function hasBinaryControls(value: string) {
  // oxlint-disable-next-line no-control-regex -- Binary detection intentionally matches control bytes.
  return /[\u0000-\u0008\u000e-\u001a\u001c-\u001f\u007f-\u009f]/.test(value);
}

function detectMedia(bytes: Buffer) {
  const starts = (signature: string) =>
    bytes.subarray(0, signature.length).equals(Buffer.from(signature, 'binary'));
  let extension: string | undefined;
  if (starts('\x89PNG\r\n\x1a\n')) extension = 'png';
  else if (starts('\xff\xd8\xff')) extension = 'jpg';
  else if (starts('GIF87a') || starts('GIF89a')) extension = 'gif';
  else if (starts('%PDF-')) extension = 'pdf';
  else if (starts('RIFF') && bytes.toString('ascii', 8, 12) === 'WEBP') extension = 'webp';
  else if (starts('RIFF') && bytes.toString('ascii', 8, 12) === 'WAVE') extension = 'wav';
  else if (starts('fLaC')) extension = 'flac';
  else if (starts('ID3')) extension = 'mp3';
  else if (starts('OggS')) extension = bytes.includes(Buffer.from('theora')) ? 'ogv' : 'ogg';
  else if (starts('\x1a\x45\xdf\xa3')) extension = 'webm';
  else if (bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12);
    extension = ['avif', 'avis'].includes(brand) ? 'avif' : brand === 'M4A ' ? 'm4a' : 'mp4';
  }
  return extension ? { kind: media.get(extension), extension } : null;
}

function hexDump(bytes: Buffer) {
  const rows = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.subarray(offset, offset + 16);
    const hex = [...row].map(byte => byte.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...row]
      .map(byte => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.'))
      .join('');
    rows.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  |${ascii}|`);
  }
  return rows.join('\n');
}
