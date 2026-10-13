import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-filetypes-'));
const profile = await mkdtemp(path.join(os.tmpdir(), 'diffpane-filetypes-profile-'));
const git = (...args) => execFileSync('git', ['-C', root, ...args]);
const errors = [];
let processOutput = '';
let application;
let page;

function pdf() {
  const stream = 'BT /F1 24 Tf 50 150 Td (Readable PDF preview) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return source;
}

function wav() {
  const samples = 8000;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(samples, 24);
  buffer.writeUInt32LE(samples * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

async function pick(file) {
  await page.bringToFront();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p');
  await page.locator('#file-search').fill(file);
  await page.locator(`#file-list button[data-path="${file}"]`).click();
  await page.waitForFunction(
    file =>
      window.__diffpane.stats().openedPath === file &&
      !window.__diffpane.stats().documentLoading &&
      Boolean(
        document
          .querySelector('.file-card .editor-host')
          ?.querySelector('.monaco-editor, .document-preview, .markdown-preview'),
      ),
    file,
  );
}

try {
  await writeFile(path.join(root, 'main.unknown'), 'arbitrary text is readable\n');
  await writeFile(
    path.join(root, 'utf16.txt'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Encoded text 雪\n', 'utf16le')]),
  );
  await writeFile(path.join(root, 'legacy.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  await writeFile(path.join(root, 'data.bin'), Buffer.from([0, 1, 65, 66, 255]));
  await writeFile(path.join(root, 'document.pdf'), pdf());
  await writeFile(path.join(root, 'sound.wav'), wav());
  await writeFile(path.join(root, 'mutable.custom'), 'original text\n');
  git('init', '-q');
  git('add', '.');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'baseline',
  );
  await writeFile(path.join(root, 'data.bin'), Buffer.from([0, 2, 67, 68, 254]));
  application = await electron.launch({
    executablePath,
    args: ['.', path.join(root, 'main.unknown'), `--user-data-dir=${profile}`],
  });
  application.process().stderr.on('data', chunk => {
    processOutput += chunk;
  });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.__diffpane?.stats().activeEditors === 1);
  assert.match(await page.locator('.view-lines').innerText(), /arbitrary\s+text/);

  await pick('utf16.txt');
  assert.match(await page.locator('.view-lines').innerText(), /Encoded\s+text\s+雪/);
  await pick('legacy.txt');
  assert.match(await page.locator('.view-lines').innerText(), /café/);
  await pick('data.bin');
  assert.match(await page.locator('.preview-text').innerText(), /00 02 43 44 fe/);
  assert.equal(await page.evaluate(() => window.__diffpane.stats().models), 0);
  await page.getByRole('button', { name: 'Compare whole file' }).click();
  assert.match(
    await page.locator('[data-side="before"] .preview-text').innerText(),
    /00 01 41 42 ff/,
  );
  assert.match(
    await page.locator('[data-side="after"] .preview-text').innerText(),
    /00 02 43 44 fe/,
  );
  await page.getByRole('button', { name: 'Show current file' }).click();

  await pick('sound.wav');
  await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
  assert.ok(await page.locator('audio').evaluate(audio => audio.duration > 0));
  await page.getByRole('button', { name: 'Inspect raw bytes' }).click();
  assert.match(await page.locator('.preview-text').innerText(), /52 49 46 46/);
  await page.getByRole('button', { name: 'Inspect raw bytes' }).click();
  await page.locator('audio').evaluate(audio => {
    window.oldAudio = audio;
  });

  await pick('document.pdf');
  await page.locator('iframe.preview-pdf').waitFor();
  assert.equal(
    await page.evaluate(() => window.oldAudio.paused && !window.oldAudio.hasAttribute('src')),
    true,
  );
  assert.ok(
    await page.locator('iframe.preview-pdf').evaluate(frame => frame.src.startsWith('blob:')),
  );
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/filetypes-pdf.png' });
  await page.getByRole('button', { name: 'Inspect raw bytes' }).click();
  assert.match(await page.locator('.preview-text').innerText(), /25 50 44 46/);

  await pick('mutable.custom');
  await writeFile(path.join(root, 'mutable.custom'), Buffer.from([0, 5, 6, 7]));
  await page.waitForFunction(() =>
    document.querySelector('.preview-text')?.textContent.includes('00 05 06 07'),
  );
  await writeFile(path.join(root, 'mutable.custom'), 'text again\n');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-side="after"] .preview-text')
        ?.textContent.replaceAll('\u00a0', ' ')
        .includes('text again') ||
      document
        .querySelector('.view-lines')
        ?.textContent.replaceAll('\u00a0', ' ')
        .includes('text again'),
  );
  await pick('main.unknown');
  assert.equal(await page.evaluate(() => window.__diffpane.stats().models), 1);
  assert.equal(await page.locator('.document-preview').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'File types passed: arbitrary text, UTF-16, Windows-1252, binary comparison, audio decoding, PDF viewer, live type changes and disposal.',
  );
} catch (error) {
  console.error(processOutput);
  if (page && !page.isClosed()) {
    console.error(await page.locator('body').innerText());
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/filetypes-failure.png' });
  }
  throw error;
} finally {
  await application?.close();
  await rm(root, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
