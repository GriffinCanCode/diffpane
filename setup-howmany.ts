import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm, cp, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
export const howmanyPin = JSON.parse(
  await readFile(new URL('./howmany-tool.json', import.meta.url), 'utf8'),
);

export function verifyHowManySource(archive: Buffer) {
  if (createHash('sha256').update(archive).digest('hex') !== howmanyPin.sha256)
    throw new Error('HowMany source checksum mismatch');
}

/** Build once for the packaging host; recipients run the bundled binary without Rust or Homebrew. */
export async function setupHowMany() {
  if (process.platform !== 'darwin') throw new Error('Bundling HowMany currently targets macOS');
  const directory = path.join(root, 'resources/howmany');
  const binary = path.join(directory, 'howmany');
  const marker = path.join(directory, 'build.json');
  const identity = `${howmanyPin.revision}-${process.platform}-${process.arch}`;
  try {
    const built = JSON.parse(await readFile(marker, 'utf8'));
    const hash = createHash('sha256')
      .update(await readFile(binary))
      .digest('hex');
    if (built.identity === identity && built.sha256 === hash) {
      const { stdout } = await execute(binary, ['--version'], { timeout: 5000 });
      if (stdout.trim() === `howmany ${howmanyPin.version}`) return binary;
    }
  } catch {
    /* Prepare a missing, changed, or outdated bundle. */
  }
  // Rust is a source-build dependency only, like Node and npm. Never run editor setup:
  // HowMany belongs inside Diffpane and must not change VS Code/Neovim settings.
  try {
    await execute('cargo', ['--version'], { timeout: 10000 });
  } catch {
    throw new Error(
      'Building the app from source requires Rust 1.88+ (cargo). Install Rust, then rerun npm run install:app. Installed Diffpane apps include HowMany and do not require Rust.',
    );
  }
  console.log(`Building bundled HowMany ${howmanyPin.version} (${process.arch})`);
  const response = await fetch(howmanyPin.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`HowMany source download failed: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  verifyHowManySource(archive);
  const cache = path.join(root, 'target/howmany', `${process.platform}-${process.arch}`);
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(path.join(cache, 'source-'));
  try {
    const tarball = path.join(temporary, 'source.tar.gz');
    await writeFile(tarball, archive);
    await execute('/usr/bin/tar', ['-xzf', tarball, '-C', temporary]);
    const source = path.join(temporary, `howmany-${howmanyPin.revision}`);
    // Upstream's source archive excludes benches/ but still declares throughput.
    // Remove only that unused benchmark target so Cargo can build the CLI.
    const manifestPath = path.join(source, 'Cargo.toml');
    const manifest = await readFile(manifestPath, 'utf8');
    await writeFile(
      manifestPath,
      manifest.replace('\n[[bench]]\nname = "throughput"\nharness = false\n', '\n'),
    );
    await new Promise<void>((resolve, reject) => {
      const build = spawn(
        'cargo',
        [
          'build',
          '--locked',
          '--release',
          '--jobs',
          '2',
          '--manifest-path',
          path.join(source, 'Cargo.toml'),
          '--target-dir',
          path.join(cache, 'build'),
        ],
        {
          cwd: source,
          stdio: 'inherit',
          shell: false,
        },
      );
      build.on('error', reject);
      build.on('exit', code =>
        code === 0 ? resolve() : reject(new Error(`HowMany build failed (${code})`)),
      );
    });
    const compiled = path.join(cache, 'build/release/howmany');
    const { stdout } = await execute(compiled, ['--version'], { timeout: 5000 });
    if (stdout.trim() !== `howmany ${howmanyPin.version}`)
      throw new Error('Unexpected bundled HowMany version');
    await mkdir(directory, { recursive: true });
    await cp(compiled, binary);
    await chmod(binary, 0o755);
    await cp(path.join(source, 'LICENSE'), path.join(directory, 'LICENSE'));
    const sha256 = createHash('sha256')
      .update(await readFile(binary))
      .digest('hex');
    await writeFile(
      marker,
      `${JSON.stringify({ identity, sha256, version: howmanyPin.version }, null, 2)}\n`,
    );
    return binary;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(`HowMany ready: ${await setupHowMany()}`);
