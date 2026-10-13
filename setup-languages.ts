import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, symlink, unlink, access, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
const tools =
  process.env.DIFFPANE_LANGUAGE_DIR ??
  path.join(os.homedir(), 'Library/Application Support/Diffpane/languages');
const bin = path.join(tools, 'bin');
const pins = JSON.parse(
  await readFile(new URL('./language-tools.json', import.meta.url), 'utf8'),
) as {
  gopls: string;
  elixirLS: { version: string; url: string; sha256: string };
};
await mkdir(bin, { recursive: true });

async function link(source: string, name: string) {
  const target = path.join(bin, name);
  try {
    await unlink(target);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  await symlink(source, target);
}

const { stdout: analyzer } = await execute('rustup', ['which', 'rust-analyzer']);
await link(analyzer.trim(), 'rust-analyzer');
// Prefer an active toolchain; mise's installed inventory also works outside a configured project.
let go: string | undefined;
try {
  const { stdout } = await execute('mise', ['ls', '--installed', '--json', 'go']);
  const versions = JSON.parse(stdout) as { version: string; install_path: string }[];
  versions.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  if (versions[0]) go = path.join(versions[0].install_path, 'bin/go');
} catch {
  /* A normal PATH-installed Go toolchain works as well. */
}
if (!go) go = (await execute('which', ['go'])).stdout.trim();
await link(go, 'go');
console.log(`Installing gopls ${pins.gopls}`);
await execute(go, ['install', `golang.org/x/tools/gopls@${pins.gopls}`], {
  env: { ...process.env, GOBIN: bin, GOMAXPROCS: '2', GOFLAGS: '-p=2' },
  maxBuffer: 2 * 1024 * 1024,
});

await execute('elixir', ['--version'], {
  env: { ...process.env, ERL_FLAGS: '+S 2:2 +SDcpu 1 +SDio 1' },
});
const release = path.join(tools, 'elixir-ls');
const marker = path.join(release, '.diffpane-version');
let installed: string | undefined;
try {
  installed = await readFile(marker, 'utf8');
} catch {
  /* First installation. */
}
if (installed?.trim() !== pins.elixirLS.version) {
  console.log(`Installing ElixirLS ${pins.elixirLS.version}`);
  const response = await fetch(pins.elixirLS.url);
  if (!response.ok) throw new Error(`ElixirLS download failed: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== pins.elixirLS.sha256)
    throw new Error('ElixirLS checksum mismatch');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'diffpane-language-'));
  try {
    const file = path.join(temp, 'elixir-ls.zip');
    await writeFile(file, archive);
    await mkdir(release, { recursive: true });
    await execute('/usr/bin/unzip', ['-oq', file, '-d', release]);
    await access(path.join(release, 'language_server.sh'));
    await writeFile(marker, pins.elixirLS.version);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
console.log(`Language tools installed in ${tools}`);
