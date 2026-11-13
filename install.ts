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
const [mode, ...extra] = process.argv.slice(2);
if ((mode !== undefined && mode !== '--box') || extra.length)
  throw new Error('Usage: node install.ts [--box]');
const box = mode === '--box';

if (process.platform !== 'darwin')
  throw new Error(
    'The terminal launcher installer currently targets macOS. Use npm start on other platforms.',
  );
const identity = process.env.DIFFPANE_SIGN_IDENTITY;
const {
  APPLE_API_KEY: appleApiKey,
  APPLE_API_KEY_ID: appleApiKeyId,
  APPLE_API_ISSUER: appleApiIssuer,
} = process.env;
const signing =
  identity && appleApiKey && appleApiKeyId && appleApiIssuer
    ? {
        osxSign: { identity, preAutoEntitlements: false, continueOnError: false },
        osxNotarize: { appleApiKey, appleApiKeyId, appleApiIssuer },
      }
    : undefined;
if (box) {
  if (process.arch !== 'arm64') throw new Error('The Box release targets Apple Silicon.');
  if (!signing)
    throw new Error(
      'Set DIFFPANE_SIGN_IDENTITY, APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER to package for Box.',
    );
  const manifest = await readFile(new URL('./Boxfile', import.meta.url), 'utf8');
  if (!manifest.split(/\r?\n/).includes(`version = "${version}"`))
    throw new Error('Boxfile version must match package.json.');
}
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
  ...(box ? signing : undefined),
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
const launcher = (await readFile(new URL('./scripts/diffpane.sh', import.meta.url), 'utf8'))
  .replace('@MODE@', box ? 'box' : 'source')
  .replace('@VERSION@', version);
if (box) {
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' });
  const staging = await mkdtemp('release/.box-');
  try {
    await mkdir(path.join(staging, 'bin'));
    await mkdir(path.join(staging, 'share/diffpane'), { recursive: true });
    await writeFile(path.join(staging, 'bin/diffpane'), launcher, { mode: 0o755 });
    execFileSync(
      'ditto',
      [
        '-c',
        '-k',
        '--sequesterRsrc',
        '--keepParent',
        app,
        path.join(staging, 'share/diffpane/Diffpane.app.zip'),
      ],
      { stdio: 'inherit' },
    );
    await rm('release/box', { recursive: true, force: true });
    await rename(staging, 'release/box');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  console.log('Staged release/box. Run box pack --dry-run before packing the release.');
} else {
  const home = os.homedir();
  const destination = path.join(home, 'Applications/Diffpane.app');
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
  await mkdir(path.join(home, '.local/bin'), { recursive: true });
  await writeFile(path.join(home, '.local/bin/diffpane'), launcher, { mode: 0o755 });
  console.log(`Installed ${destination}\nRun diffpane in a Git working directory.`);
}
