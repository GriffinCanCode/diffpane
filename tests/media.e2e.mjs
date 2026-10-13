import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-media-app-'));
const profile = await mkdtemp(path.join(os.tmpdir(), 'diffpane-media-profile-'));
const errors = [];
let processOutput = '';
let application;
let page;
const imagePath = 'media/photo # 雪.png';
const svg = width =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="600" viewBox="0 0 ${width} 600"><rect width="100%" height="100%" fill="#182835"/><circle cx="300" cy="300" r="180" fill="#80cbc4"/><text x="550" y="320" fill="white" font-family="sans-serif" font-size="48">Image preview</text><!--${'x'.repeat(2 * 1024 * 1024)}--></svg>`;

async function pick(file) {
  await page.bringToFront();
  await page.locator('.navigator-action[data-action="open-file"]').click();
  await page.locator('#file-search').fill(file);
  await page
    .locator('#file-list button[data-path]')
    .filter({ hasText: path.basename(file) })
    .first()
    .click();
  await page.waitForFunction(file => window.__diffpane.stats().openedPath === file, file);
}

try {
  await mkdir(path.join(root, 'media'));
  await writeFile(path.join(root, 'main.js'), 'export const ready = true;\n');
  await copyFile('assets/diffpane.png', path.join(root, imagePath));
  await writeFile(path.join(root, 'media/large.svg'), svg(1600));
  await writeFile(path.join(root, 'media/broken.png'), 'not a real image');
  await writeFile(path.join(root, 'media/broken.mp4'), 'not a real video');
  execFileSync('git', ['init', '-q', root]);
  application = await electron.launch({
    executablePath,
    args: ['.', path.join(root, 'main.js'), `--user-data-dir=${profile}`],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  });
  application.process().stderr.on('data', chunk => {
    processOutput += chunk;
  });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.__diffpane?.stats().activeEditors === 1);

  // Produce a real, decodable video using Chromium's bundled VP8 encoder.
  const videoBytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d');
    const stream = canvas.captureStream(15);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const result = new Promise(resolve => {
      recorder.onstop = async () =>
        resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())));
    });
    let frame = 0;
    const draw = () => {
      context.fillStyle = '#182835';
      context.fillRect(0, 0, 640, 360);
      context.fillStyle = '#80cbc4';
      context.fillRect(50 + frame++ * 5, 100, 160, 160);
      context.fillStyle = 'white';
      context.font = '32px sans-serif';
      context.fillText('Video preview', 230, 70);
    };
    draw();
    recorder.start();
    const timer = setInterval(draw, 60);
    await new Promise(resolve => setTimeout(resolve, 1500));
    clearInterval(timer);
    recorder.stop();
    const bytes = await result;
    stream.getTracks().forEach(track => track.stop());
    return bytes;
  });
  await writeFile(path.join(root, 'media/clip # 雪.webm'), Buffer.from(videoBytes));
  await page.evaluate(() => window.diffpane.refresh());

  await pick(imagePath);
  await page.waitForFunction(() => document.querySelector('.media-content')?.naturalWidth > 0);
  assert.equal(
    await page.locator('.monaco-editor').count(),
    1,
    'only the shared language-widget root remains',
  );
  assert.equal(await page.evaluate(() => window.__diffpane.stats().models), 0);
  const dimensions = await page.locator('.file-card').innerText();
  assert.match(dimensions, /\d+ × \d+/);
  await page.getByRole('button', { name: 'View image at actual size' }).click();
  assert.equal(await page.locator('.media-actual-size').count(), 1);
  await page.getByRole('button', { name: 'Fit image to view' }).click();
  assert.equal(await page.locator('.media-actual-size').count(), 0);

  await pick('media/large.svg');
  await page.waitForFunction(() => document.querySelector('.media-content')?.naturalWidth === 1600);
  const imageBounds = await page.locator('.media-content').boundingBox();
  const hostBounds = await page.locator('.editor-host').boundingBox();
  assert.ok(imageBounds.width <= hostBounds.width && imageBounds.height <= hostBounds.height);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/media-image.png' });
  await writeFile(path.join(root, 'media/large.svg'), svg(1200));
  await page.waitForFunction(() => document.querySelector('.media-content')?.naturalWidth === 1200);

  await pick('media/clip # 雪.webm');
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video?.videoWidth === 640 && video.readyState >= 1;
  });
  const video = page.locator('video');
  assert.equal(await video.evaluate(element => element.controls), true);
  const bounds = await video.boundingBox();
  await video.click({ position: { x: 30, y: bounds.height - 48 } });
  await page.waitForFunction(() => {
    const element = document.querySelector('video');
    return !element.paused && element.currentTime > 0.1;
  });
  await video.evaluate(element => element.pause());
  await video.evaluate(
    element =>
      new Promise(resolve => {
        element.addEventListener('seeked', resolve, { once: true });
        element.currentTime = 0.8;
      }),
  );
  assert.ok(await video.evaluate(element => Math.abs(element.currentTime - 0.8) < 0.1));
  await page.screenshot({ path: 'test-results/media-video.png' });
  await video.evaluate(element => {
    window.previousVideo = element;
  });
  await pick('main.js');
  await page.waitForFunction(() => window.__diffpane.stats().activeEditors === 1);
  assert.equal(
    await page.evaluate(
      () => window.previousVideo.paused && !window.previousVideo.hasAttribute('src'),
    ),
    true,
  );
  assert.equal(await page.evaluate(() => window.__diffpane.stats().models), 1);

  for (const file of ['media/broken.png', 'media/broken.mp4']) {
    await pick(file);
    await page.waitForFunction(() =>
      /could not|cannot be displayed/.test(document.querySelector('.file-card').textContent),
    );
  }
  await pick(imagePath);
  await page.waitForFunction(() => document.querySelector('.media-content')?.naturalWidth > 0);
  await rm(path.join(root, imagePath));
  await page.waitForFunction(() => !document.querySelector('.media-content'));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        imageDimensions: dimensions,
        videoBytes: videoBytes.length,
        playback: true,
        seeking: true,
        liveImageUpdate: true,
        rendererErrors: errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  console.error(processOutput);
  if (page && !page.isClosed()) {
    console.error(await page.locator('body').innerText());
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/media-failure.png' });
  }
  throw error;
} finally {
  await application?.close();
  await rm(root, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
