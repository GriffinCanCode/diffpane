import { packager } from '@electron/packager';
import { cp, mkdir, mkdtemp, writeFile, rename, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { setupHowMany } from './setup-howmany.ts';

const metadata: unknown = JSON.parse(
  await readFile(new URL('./package.json', import.meta.url), 'utf8'),
);
if (
  !metadata ||
  typeof metadata !== 'object' ||
  !('version' in metadata) ||
  typeof metadata.version !== 'string' ||
  !/^\d+\.\d+\.\d+$/.test(metadata.version)
)
  throw new Error('Diffpane requires a numeric release version in package.json.');
const { version } = metadata;
if (process.argv.length > 2) throw new Error('Usage: node install.ts');

if (process.platform !== 'darwin')
  throw new Error(
    'The terminal launcher installer currently targets macOS. Use npm start on other platforms.',
  );
async function buildRenderer() {
  const [code, signal] = await once(spawn('npm', ['run', 'build'], { stdio: 'inherit' }), 'exit');
  if (code !== 0) throw new Error(`Renderer build failed (${signal ?? code})`);
}

for (const result of await Promise.allSettled([buildRenderer(), setupHowMany()])) {
  if (result.status === 'rejected') throw result.reason;
}

await mkdir('release', { recursive: true });
const scratch = await mkdtemp('release/.packager-');
const [bundle] = await packager({
  dir: '.',
  out: 'release',
  tmpdir: scratch,
  name: 'Diffpane',
  appBundleId: 'com.diffpane.app',
  icon: 'assets/diffpane.icns',
  appVersion: version,
  overwrite: true,
  asar: { unpack: '**/*.node' },
  beforeAsar: [
    async ({ buildPath }) => {
      // Child processes already use these physical paths. Move the staged
      // payloads directly so ASAR does not index and copy them a second time.
      const unpacked = `${buildPath}.asar.unpacked`;
      await Promise.all([
        mkdir(path.join(unpacked, 'node_modules'), { recursive: true }),
        mkdir(path.join(unpacked, 'resources'), { recursive: true }),
      ]);
      for (const directory of [
        'node_modules/basedpyright',
        'node_modules/typescript',
        'node_modules/typescript-language-server',
        'resources/howmany',
      ]) {
        await rename(path.join(buildPath, directory), path.join(unpacked, directory));
      }
    },
  ],
  ignore: [
    /^\/(?!(?:dist|electron|node_modules|resources)(?:\/|$)|(?:NOTICE|package\.json|ideas\.ts|media-types\.ts|review-notes\.ts|text-lines\.ts)$)/,
    /^\/resources\/(?!howmany(?:\/|$))/,
    /^\/resources\/howmany\/build\.json$/,
    /^\/node_modules\/\.vite[^/]*(?:\/|$)/,
    // Ship the language servers and their standard libraries without CLI-only
    // compiler entry points and source maps.
    /^\/node_modules\/basedpyright\/dist\/(?:pyright\.js|pyright(?:-langserver)?\.js\.map)$/,
    /^\/node_modules\/typescript\/(?:bin\/tsc|lib\/_?tsc\.js)$/,
    /^\/node_modules\/typescript-language-server\/lib\/cli\.mjs\.map$/,
    /README\.md$/,
    /\.test\.(mjs|ts)$/,
  ],
}).finally(() => rm(scratch, { recursive: true, force: true }));
if (!bundle) throw new Error('Electron Packager did not produce a macOS app.');
const app = path.join(bundle, 'Diffpane.app');
const launcher = (
  await readFile(new URL('./scripts/diffpane.sh', import.meta.url), 'utf8')
).replace('@VERSION@', version);
const userDirectory = os.homedir();
const destination = path.join(userDirectory, 'Applications/Diffpane.app');
try {
  await rename(destination, path.join(os.tmpdir(), `Diffpane-previous-${Date.now()}.app`));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
await mkdir(path.dirname(destination), { recursive: true });
await cp(app, destination, {
  recursive: true,
  verbatimSymlinks: true,
  mode: constants.COPYFILE_FICLONE,
});
execFileSync('codesign', ['--force', '--deep', '--sign', '-', destination], { stdio: 'inherit' });
await mkdir(path.join(userDirectory, '.local/bin'), { recursive: true });
await writeFile(path.join(userDirectory, '.local/bin/diffpane'), launcher, { mode: 0o755 });
console.log(`Installed ${destination}\nRun diffpane in a Git working directory.`);
