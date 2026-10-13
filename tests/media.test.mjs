import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vite-plus/test';
import { mediaResponse } from '../electron/media.ts';
import { mediaType } from '../media-types.ts';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-media-')));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

const request = (range, method = 'GET') =>
  new Request('https://media.invalid/file', { method, headers: range ? { range } : {} });

test('media streams beyond the text limit and supports video byte ranges and HEAD', async t => {
  const root = await fixture(t);
  const bytes = Buffer.alloc(3 * 1024 * 1024, 42);
  await writeFile(path.join(root, 'space # 雪.MP4'), bytes);
  let response = await mediaResponse(root, 'space # 雪.MP4', request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  for (const [range, start, end] of [
    ['bytes=100-199', 100, 199],
    ['bytes=3145720-', 3145720, bytes.length - 1],
    ['bytes=-10', bytes.length - 10, bytes.length - 1],
    ['bytes=3145720-9999999', 3145720, bytes.length - 1],
  ]) {
    response = await mediaResponse(root, 'space # 雪.MP4', request(range));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  response = await mediaResponse(root, 'space # 雪.MP4', request(null, 'HEAD'));
  assert.equal(response.headers.get('Content-Length'), String(bytes.length));
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  for (const range of ['bytes=9999999-', 'bytes=3-1', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=-']) {
    response = await mediaResponse(root, 'space # 雪.MP4', request(range));
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('Content-Range'), `bytes */${bytes.length}`);
  }
});

test('media rejects traversal, unsupported files, directories and symlinks outside the repository', async t => {
  const root = await fixture(t);
  const external = await fixture(t);
  await writeFile(path.join(external, 'secret.png'), 'external');
  await mkdir(path.join(root, 'directory.png'));
  await writeFile(path.join(root, 'script.js'), 'alert(1)');
  assert.equal((await mediaResponse(root, '../secret.png', request())).status, 403);
  assert.equal((await mediaResponse(root, 'script.js', request())).status, 403);
  assert.equal((await mediaResponse(root, 'directory.png', request())).status, 403);
  assert.equal((await mediaResponse(root, 'missing.png', request())).status, 404);
  if (process.platform !== 'win32') {
    await symlink(path.join(external, 'secret.png'), path.join(root, 'link.png'));
    await symlink(external, path.join(root, 'outside'));
    assert.equal((await mediaResponse(root, 'link.png', request())).status, 403);
    assert.equal((await mediaResponse(root, 'outside/secret.png', request())).status, 403);
  }
});

test('images have explicit types and empty files finish without a stream', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'empty.svg'), '');
  const response = await mediaResponse(root, 'empty.svg', request());
  assert.equal(response.headers.get('Content-Type'), 'image/svg+xml');
  assert.equal(response.headers.get('Content-Length'), '0');
  assert.equal(await response.text(), '');
  assert.equal(mediaType('photo.PNG'), 'image/png');
  assert.equal(mediaType('animation.gif'), 'image/gif');
  assert.equal(mediaType('notes.md'), null);
  assert.equal(mediaType('png'), null);
  assert.equal(mediaType('file.constructor'), null);
});
