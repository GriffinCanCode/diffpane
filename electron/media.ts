import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { mediaType } from '../media-types.ts';

const within = (root: string, filename: string) => {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// Stream from an opened descriptor, with byte ranges for video seeking. Media never
// passes through the text preview limits or the document cache.
export async function mediaResponse(root: string, filename: string, request: Request) {
  const type = mediaType(filename);
  const absolute = path.resolve(root, filename);
  if (!type || !within(root, absolute)) return new Response(null, { status: 403 });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  let handle: FileHandle | null | undefined;
  try {
    const parent = await realpath(path.dirname(absolute));
    if (!within(root, parent)) return new Response(null, { status: 403 });
    handle = await open(
      path.join(parent, path.basename(absolute)),
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
    );
    const metadata = await handle.stat();
    if (!metadata.isFile()) return new Response(null, { status: 403 });
    const size = metadata.size;
    const headers: Record<string, string> = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
      } else start = NaN;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      ) {
        return new Response(null, {
          status: 416,
          headers: { ...headers, 'Content-Range': `bytes */${size}` },
        });
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = String(Math.max(0, end - start + 1));
    if (request.method === 'HEAD' || !size) return new Response(null, { status, headers });
    const stream = handle.createReadStream({ start, end, autoClose: true });
    handle = null; // The stream owns the descriptor, including when the reader cancels.
    return new Response(Readable.toWeb(stream) as unknown as BodyInit, { status, headers });
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    return new Response(null, { status: ['ENOENT', 'ENOTDIR'].includes(code) ? 404 : 403 });
  } finally {
    await handle?.close();
  }
}
