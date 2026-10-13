import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-markdown-'));
const profile = await mkdtemp(path.join(os.tmpdir(), 'diffpane-markdown-profile-'));
let application;
let page;
const errors = [];
const fixture = `---
title: A quieter way to read
---

# A quieter way to read your work

A **beautiful reading view** for your project notes, with rich diagrams and the source always one click away.

[Jump to architecture](#architecture) · [Read the guide](docs/guide.md#details)

> [!TIP]
> Keep the whole story in one place. Diagrams update as you save.

## Architecture

\`\`\`mermaid
flowchart LR
  A[Your working tree] --> B{Diffpane}
  B --> C[Source & diff]
  B --> D[Rich Markdown]
  D --> E[Mermaid diagrams]
\`\`\`

## Code that speaks for itself

\`\`\`javascript
// Everything stays live.
export function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

| Feature | Status | Why it matters |
| :--- | :---: | ---: |
| Mermaid diagrams | Ready | See the big picture |
| Live previews | Ready | Stay in the flow |
| Source & compare | Ready | Every detail, on demand |

- [x] Read the whole document
- [ ] Review the next change

## The save lifecycle

\`\`\`mermaid
sequenceDiagram
  actor You
  participant Editor as Other editor
  participant FS as Filesystem
  participant Watch as Watcher
  participant Diff as Diffpane
  You->>Editor: Save the open file
  Editor->>FS: Write the buffer
  FS->>Watch: Native change event
  Watch->>Diff: Refresh current document
  Diff-->>You: Updated preview
\`\`\`

![Local artwork](art.png)

<details><summary>A little more detail</summary>

Inline \`code\`, **bold**, *italic*, ~~strikethrough~~, and keyboard shortcuts: <kbd>⌘</kbd> <kbd>P</kbd>.

</details>

## Broken diagram

\`\`\`mermaid
flowchart LR
  A[unclosed
\`\`\`

<script>window.markdownUnsafe = true</script>
<img src="x" onerror="window.markdownUnsafe = true">
<a href="javascript:window.markdownUnsafe=true">unsafe link</a>
<form><input autofocus></form>
`;

async function pick(file) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p');
  await page.locator('#file-search').fill(file);
  await page
    .locator('#file-list button[data-path]')
    .filter({ hasText: path.basename(file) })
    .first()
    .click();
  await page.waitForFunction(file => window.__diffpane.stats().openedPath === file, file);
}

try {
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'README.md'), fixture);
  await writeFile(
    path.join(root, 'docs/guide.md'),
    '# Guide\n\n## Details\n\nLinked documentation.\n',
  );
  await writeFile(path.join(root, 'main.js'), 'export const ready = true;\n');
  await copyFile('assets/diffpane.png', path.join(root, 'art.png'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-qm',
    'Fixture',
  ]);
  await writeFile(path.join(root, 'README.md'), fixture + '\nA live working copy.\n');
  application = await electron.launch({
    executablePath,
    args: ['.', path.join(root, 'README.md'), `--user-data-dir=${profile}`],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') console.error(message.text());
  });
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.md-diagram-canvas svg').length >= 2 ||
      document.querySelectorAll('.md-diagram-error').length === 3,
  );
  assert.equal(await page.locator('.md-diagram-canvas svg').count(), 2);
  await page.locator('.md-diagram-error').waitFor();
  assert.equal(
    await page.locator('.markdown-body h1').innerText(),
    'A quieter way to read your work#',
  );
  assert.equal(await page.locator('.md-callout[data-tone="tip"]').count(), 1);
  assert.equal(await page.locator('.md-table-scroll table tbody tr').count(), 3);
  assert.equal(await page.locator('.md-task input:disabled').count(), 2);
  assert.equal(await page.locator('.md-frontmatter').count(), 1);
  assert.equal(await page.locator('.markdown-body > hr').count(), 0);
  assert.equal(await page.evaluate(() => window.markdownUnsafe), undefined);
  assert.equal(
    await page
      .locator(
        '.markdown-body script, .markdown-body form, .markdown-body [onerror], .markdown-body [autofocus]',
      )
      .count(),
    0,
  );
  assert.equal(await page.locator('.markdown-body a[href^="javascript:"]').count(), 0);
  await page.locator('.markdown-body img[alt="Local artwork"]').scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () => document.querySelector('.markdown-body img[alt="Local artwork"]')?.naturalWidth > 0,
  );
  await page.waitForFunction(() => document.querySelector('.md-block code span'));
  assert.equal(await page.evaluate(() => window.__diffpane.stats().models), 0);
  const flow = page.locator('.md-diagram').first();
  const canvasBounds = await flow.locator('.md-diagram-canvas').boundingBox();
  const svgBounds = await flow.locator('svg[role="img"]').boundingBox();
  assert.ok(svgBounds.width <= canvasBounds.width);
  await flow.getByRole('button', { name: 'Copy code', exact: true }).click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /flowchart LR/);
  await flow.getByRole('button', { name: 'Source', exact: true }).click();
  assert.equal(await flow.locator('pre').isVisible(), true);
  await flow.getByRole('button', { name: 'Diagram', exact: true }).click();
  await flow.getByRole('button', { name: 'Expand diagram' }).click();
  await page.waitForFunction(() => document.querySelector('.md-expanded-image')?.naturalWidth > 0);
  const fitWidth = await page.locator('.md-expanded-image').evaluate(image => image.width);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  assert.ok((await page.locator('.md-expanded-image').evaluate(image => image.width)) > fitWidth);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.md-diagram-dialog').count(), 0);
  await page
    .getByRole('group', { name: 'Markdown view' })
    .getByRole('button', { name: 'Source', exact: true })
    .click();
  await page.waitForFunction(() => window.__diffpane.stats().models === 1);
  await page.getByRole('button', { name: 'Compare whole file', exact: true }).click();
  await page.waitForFunction(() => window.__diffpane.stats().models === 2);
  await page
    .getByRole('group', { name: 'Markdown view' })
    .getByRole('button', { name: 'Preview', exact: true })
    .click();
  await page.locator('.md-diagram-canvas svg').nth(1).waitFor();
  assert.equal(await page.evaluate(() => window.__diffpane.stats().models), 0);
  await page.getByRole('button', { name: 'Compare whole file', exact: true }).click();
  await page.waitForFunction(() => window.__diffpane.stats().models === 2);
  await page
    .getByRole('group', { name: 'Markdown view' })
    .getByRole('button', { name: 'Preview', exact: true })
    .click();
  await page.locator('.md-diagram-canvas svg').nth(1).waitFor();
  await page.getByRole('link', { name: 'Read the guide' }).click();
  await page.locator('.markdown-body h2#details').waitFor();
  assert.equal(await page.evaluate(() => window.__diffpane.stats().openedPath), 'docs/guide.md');
  await pick('README.md');
  await page.locator('.md-diagram-canvas svg').nth(1).waitFor();
  const savedScroll = await page.locator('.markdown-preview').evaluate(element => {
    element.scrollTop = element.querySelectorAll('.md-diagram')[1].offsetTop - 100;
    return element.scrollTop;
  });
  await writeFile(
    path.join(root, 'README.md'),
    fixture.replace('A quieter way to read your work', 'Markdown, beautifully rendered'),
  );
  await page.getByRole('heading', { name: 'Markdown, beautifully rendered' }).waitFor();
  await page.locator('.md-diagram-canvas svg').nth(1).waitFor();
  assert.ok(
    Math.abs(
      (await page.locator('.markdown-preview').evaluate(element => element.scrollTop)) -
        savedScroll,
    ) < 30,
  );
  await page.locator('.md-block').nth(1).scrollIntoViewIfNeeded();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/markdown-details.png' });
  await page.locator('.markdown-preview').evaluate(element => {
    element.scrollTop = 0;
  });
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/markdown.png' });
  await page.setViewportSize({ width: 760, height: 850 });
  const fits = await page
    .locator('.markdown-body')
    .evaluate(element => element.scrollWidth <= element.clientWidth);
  assert.ok(fits, 'Markdown must fit a narrow pane');
  await page.screenshot({ path: 'test-results/markdown-narrow.png' });
  await pick('main.js');
  await page.waitForFunction(() => window.__diffpane.stats().models === 1);
  assert.equal(
    await page.locator('.markdown-preview, .md-render-scratch, .md-diagram-dialog').count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Markdown: diagrams, code, copy, zoom, source, diff, local links/images, live saves, narrow layout, sanitization and cleanup passed.',
  );
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(
      await page.locator('.md-diagram-status').evaluateAll(nodes => nodes.map(node => node.title)),
    );
    console.error(await page.locator('body').innerText());
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/markdown-failure.png' });
  }
  throw error;
} finally {
  await application?.close();
  await rm(root, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
