import { _electron as electron } from 'playwright';
import executablePath from 'electron';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { installObserver, armObserver, type Expectation } from './observer.ts';
import { sampleMemory } from './process-memory.ts';

const profileName = process.env.DIFFPANE_K6_PROFILE || 'scale';
const profiles = {
  smoke: { files: 2000, duration: '10s', lines: 4000 },
  scale: { files: 50000, duration: '60s', lines: 30000 },
  soak: { files: 50000, duration: '10m', lines: 30000 },
  languages: { files: 50000, duration: '60s', lines: 4000 },
};
if (!(profileName in profiles)) throw new Error('Choose smoke, scale, soak, or languages.');
const profile = profiles[profileName as keyof typeof profiles];
const fileCount = Number(process.env.DIFFPANE_K6_FILES || profile.files);
const duration = process.env.DIFFPANE_K6_DURATION || profile.duration;
assert.ok(Number.isInteger(fileCount) && fileCount >= 400 && fileCount <= 100000);
const k6 = process.env.K6_BIN || 'k6';
const k6Version = execFileSync(k6, ['version'], { encoding: 'utf8' }).trim();
const output = path.resolve('test-results', `k6-${profileName}`);
await mkdir(output, { recursive: true });
const rendererHTML = await readFile('dist/index.html', 'utf8');
const rendererAsset = /src="\.\/([^"\s]+\.js)"/.exec(rendererHTML)?.[1];
assert.ok(rendererAsset, 'Build the production renderer before running k6.');
const rendererSha256 = createHash('sha256')
  .update(await readFile(path.join('dist', rendererAsset)))
  .digest('hex');
const startedAt = new Date().toISOString();
const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-k6-'));
const userData = await mkdtemp(path.join(os.tmpdir(), 'diffpane-k6-profile-'));
const git = (...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
const language = profileName === 'languages';
const filename = (index: number) =>
  `src/package${Math.floor(index / 500)
    .toString()
    .padStart(
      3,
      '0',
    )}/file${index.toString().padStart(5, '0')}.${language && index === 0 ? 'ts' : 'txt'}`;
const tail = Array.from({ length: profile.lines - 1 }, (_, index) =>
  language
    ? `export const value${index} = ${index};`
    : `line ${index}: unchanged code stays visible`,
).join('\n');
const documentText = (marker: string) => `${language ? '// ' : ''}${marker}\n${tail}\n`;
async function batch(count: number, action: (index: number) => Promise<unknown>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: 24 }, async () => {
      while (next < count) await action(next++);
    }),
  );
}
const token = randomBytes(24).toString('hex');
const errors: string[] = [];
const operations = { edit: 0, create: 0, rename: 0, delete: 0 };
const latest = new Map<string, string>();
let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
let load: ChildProcess | undefined;
let sampler: ReturnType<typeof setInterval> | undefined;
let sampleInFlight: Promise<void> | undefined;
let peak: Awaited<ReturnType<typeof sampleMemory>> | undefined;
let initialRssBytes = 0;
let memorySamples = 0;
let sequence = 0;
let inFlight = 0;
let maxInFlight = 0;
let loadExit: number | null = null;
let failure: string | undefined;
const memorySeries: { at: number; rssBytes: number }[] = [];
const waiters = new Map<
  number,
  {
    resolve: (time: number) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const busyAgents = new Set<number>();
const server = createServer();

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    agent: number;
    iteration: number;
    kind: keyof typeof operations;
  };
}

try {
  console.log(
    `Preparing ${fileCount.toLocaleString()} files; ${profile.lines.toLocaleString()} lines; 10 agents; ${duration}.`,
  );
  git('init', '-q');
  for (let index = 0; index < Math.ceil(fileCount / 500); index++)
    await mkdir(path.join(root, path.dirname(filename(index * 500))), { recursive: true });
  await batch(fileCount, index =>
    writeFile(
      path.join(root, filename(index)),
      index ? `baseline ${index}\n` : documentText('INITIAL'),
    ),
  );
  git('add', '.');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'baseline',
  );
  await writeFile(path.join(root, filename(0)), documentText('OPENED'));
  application = await electron.launch({
    executablePath: executablePath as unknown as string,
    args: ['.', root, `--user-data-dir=${userData}`],
  });
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  const pid = application.process().pid!;
  const sample = () => {
    if (sampleInFlight) return sampleInFlight;
    sampleInFlight = sampleMemory(pid)
      .then(value => {
        memorySamples++;
        if (!initialRssBytes) initialRssBytes = value.rssBytes;
        if (!peak || value.rssBytes > peak.rssBytes) peak = value;
        // A bounded rolling series; keep the peak independently during long soaks.
        if (memorySeries.length >= 36000) memorySeries.shift();
        memorySeries.push({ at: value.at, rssBytes: value.rssBytes });
      })
      .catch(error => {
        errors.push(`memory sampler: ${error.message}`);
      })
      .finally(() => {
        sampleInFlight = undefined;
      });
    return sampleInFlight;
  };
  await sample();
  sampler = setInterval(() => {
    void sample();
  }, 100);
  await page.waitForFunction(
    count => {
      const app = (
        window as unknown as {
          __diffpane?: {
            stats: () => {
              models: number;
              documentLoading: boolean;
              navigator: { inventoryFiles: number };
            };
          };
        }
      ).__diffpane;
      return (
        app?.stats().navigator.inventoryFiles === count &&
        app.stats().models === 1 &&
        !app.stats().documentLoading
      );
    },
    fileCount,
    { timeout: 60000 },
  );
  await page.waitForFunction(() =>
    document.querySelector('.view-lines')?.textContent?.includes('OPENED'),
  );
  if (language)
    await page.waitForFunction(
      () => document.querySelector('.language-state')?.getAttribute('data-status') === 'ready',
      undefined,
      { timeout: 30000 },
    );
  await page.locator('.navigator-search input').fill('live-agents/');
  await installObserver(page, id => {
    const waiter = waiters.get(id);
    if (!waiter) return;
    waiters.delete(id);
    clearTimeout(waiter.timer);
    waiter.resolve(performance.now());
  });
  await page.screenshot({ path: path.join(output, 'before.png') });

  server.on('request', (request, response) => {
    void (async () => {
      response.setHeader('Content-Type', 'application/json');
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(403).end('{}');
        return;
      }
      if (request.method === 'GET' && request.url === '/metrics') {
        await sample();
        response.end(JSON.stringify({ peakRssBytes: peak?.rssBytes, memorySamples }));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/step') {
        response.writeHead(404).end('{}');
        return;
      }
      const { agent, iteration, kind } = await readBody(request);
      if (
        !Number.isInteger(agent) ||
        agent < 1 ||
        agent > 10 ||
        !Number.isInteger(iteration) ||
        iteration < 0 ||
        iteration > 1000000 ||
        !Object.hasOwn(operations, kind) ||
        busyAgents.has(agent)
      ) {
        response.writeHead(400).end('{}');
        return;
      }
      busyAgents.add(agent);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const id = ++sequence;
      try {
        const original = `live-agents/agent${agent}-round${iteration}`;
        const moved = `live-agents/moved-agent${agent}-round${iteration}`;
        const marker = `LIVE_AGENT_${agent}_ROUND_${iteration}`;
        let expectation: Expectation | undefined;
        if (kind === 'edit' && agent === 1) expectation = { path: filename(0), marker };
        if (kind === 'create') expectation = { path: `${original}/created.txt` };
        if (kind === 'rename')
          expectation = { path: `${moved}/created.txt`, absent: `${original}/created.txt` };
        if (kind === 'delete') expectation = { path: `${moved}/created.txt`, deleted: true };
        let observation: Promise<number> | undefined;
        if (expectation) {
          observation = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              waiters.delete(id);
              reject(new Error(`Visible ${kind} timed out: agent ${agent}, round ${iteration}`));
            }, 10000);
            waiters.set(id, { resolve, reject, timer });
          });
          // Attach rejection immediately, including if an OS write subsequently fails.
          void observation.catch(() => {});
          await armObserver(page, id, expectation);
        }
        const started = performance.now();
        if (kind === 'edit') {
          await Promise.all(
            Array.from({ length: 32 }, async (_, offset) => {
              const name = filename(1 + (agent - 1) * 32 + offset);
              const text = `${marker}, writer ${offset}\n`;
              await writeFile(path.join(root, name), text);
              latest.set(name, text);
            }),
          );
          if (agent === 1) {
            const text = documentText(marker);
            // Atomic replacement, as used by editors and coding agents.
            await writeFile(path.join(root, `${filename(0)}.tmp`), text);
            await rename(path.join(root, `${filename(0)}.tmp`), path.join(root, filename(0)));
            latest.set(filename(0), text);
          }
        } else if (kind === 'create') {
          await mkdir(path.join(root, original), { recursive: true });
          await writeFile(path.join(root, original, 'created.txt'), `${marker}\n`);
        } else if (kind === 'rename')
          await rename(path.join(root, original), path.join(root, moved));
        else await rm(path.join(root, moved), { recursive: true });
        const written = performance.now();
        const observed = observation ? await observation : undefined;
        operations[kind]++;
        response.end(
          JSON.stringify({
            visibleMs: observed === undefined ? null : Math.max(0, observed - written),
            writeMs: written - started,
            peakRssBytes: peak?.rssBytes,
          }),
        );
      } catch (error) {
        const message = (error as Error).message;
        errors.push(message);
        response.writeHead(500).end(JSON.stringify({ error: message }));
      } finally {
        const waiter = waiters.get(id);
        if (waiter) {
          clearTimeout(waiter.timer);
          waiters.delete(id);
        }
        if (waiter)
          await page
            .evaluate(id => {
              (
                window as unknown as { __k6Expectations: Map<number, Expectation> }
              ).__k6Expectations.delete(id);
            }, id)
            .catch(() => {});
        busyAgents.delete(agent);
        inFlight--;
      }
    })().catch(error => {
      errors.push((error as Error).message);
      if (!response.headersSent) response.writeHead(500).end('{}');
      else response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  console.log(
    `Running ${k6Version}. Memory budget is 100,000,000 bytes across the complete app process tree.`,
  );
  loadExit = await new Promise<number>((resolve, reject) => {
    load = spawn(
      k6,
      ['run', '--no-usage-report', '--summary-mode=full', path.resolve('tests/k6/workload.ts')],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          DIFFPANE_K6_URL: `http://127.0.0.1:${port}`,
          DIFFPANE_K6_TOKEN: token,
          DIFFPANE_K6_DURATION: duration,
          DIFFPANE_K6_SUMMARY: path.join(output, 'summary.json'),
        },
      },
    );
    load.once('error', reject);
    load.once('exit', code => resolve(code ?? 1));
  });
  // Check convergence through the real backend, including files that weren't open.
  for (const [name, text] of latest) {
    assert.equal(await readFile(path.join(root, name), 'utf8'), text);
    const actual = await page.evaluate(async name => {
      const api = (
        window as unknown as {
          diffpane: { document: (path: string, comparison: string) => Promise<{ after: string }> };
        }
      ).diffpane;
      return (await api.document(name, 'head')).after;
    }, name);
    assert.equal(actual, text, `Stale document: ${name}`);
  }
  const stats = await page.evaluate(() =>
    (
      window as unknown as {
        __diffpane: {
          stats: () => {
            models: number;
            activeEditors: number;
            navigator: { inventoryFiles: number; mountedRows: number; loading: boolean };
          };
        };
      }
    ).__diffpane.stats(),
  );
  assert.equal(stats.models, 1);
  assert.equal(stats.activeEditors, 1);
  assert.ok(stats.navigator.mountedRows < 60);
  await page.waitForFunction(
    count => {
      const stats = (
        window as unknown as {
          __diffpane: { stats: () => { navigator: { inventoryFiles: number; loading: boolean } } };
        }
      ).__diffpane.stats();
      return !stats.navigator.loading && stats.navigator.inventoryFiles === count;
    },
    fileCount,
    { timeout: 10000 },
  );
  await sample();
  assert.ok(memorySamples > 10, 'Not enough whole-process memory samples');
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'ui.json'),
    JSON.stringify(
      {
        stats,
        frames: await page.evaluate(
          () => (window as unknown as { __k6Frames: unknown }).__k6Frames,
        ),
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: path.join(output, 'after.png') });
} catch (error) {
  failure = (error as Error).stack || String(error);
  console.error(failure);
  const page = application?.windows()[0];
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  load?.kill();
  if (sampler) clearInterval(sampler);
  await sampleInFlight;
  for (const waiter of waiters.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error('Load test closed'));
  }
  waiters.clear();
  server.closeAllConnections();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  await writeFile(
    path.join(output, 'process-memory.json'),
    JSON.stringify(
      {
        profile: profileName,
        startedAt,
        rendererSha256,
        k6Version,
        fileCount,
        documentLines: profile.lines,
        duration,
        agents: 10,
        operations,
        maxInFlight,
        loadExit,
        failure,
        errors,
        measurement:
          'Sum of resident set sizes of the app PID and all descendants, sampled every 100 ms. Shared pages may be counted more than once; short-lived subprocess peaks between samples can be missed. Test harness and k6 are excluded.',
        budgetBytes: 100000000,
        initialRssBytes,
        peakRssBytes: peak?.rssBytes,
        memoryBudgetPassed: Boolean(peak && peak.rssBytes < 100000000),
        memorySamples,
        peakProcesses: peak?.processes,
        samples: memorySeries,
      },
      null,
      2,
    ),
  );
  await application?.close();
  await rm(root, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
}
console.log(`Reports: ${output}`);
if (failure || errors.length || !peak || peak.rssBytes >= 100000000 || loadExit !== 0)
  process.exitCode = 1;
