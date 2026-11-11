import { packager } from '@electron/packager';
import { cp, mkdir, mkdtemp, writeFile, rename, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
await setupHowMany();
const [bundle] = await packager({
  dir: '.',
  out: 'release',
  name: 'Diffpane',
  appBundleId: 'com.diffpane.app',
  icon: 'assets/diffpane.icns',
  appVersion: version,
  overwrite: true,
  ...(box ? signing : undefined),
  asar: {
    unpack: '**/*.node',
    unpackDir:
      '{node_modules/{basedpyright,typescript,typescript-language-server},resources/howmany}',
  },
  ignore: [
    /^\/(?!(?:dist|electron|node_modules|resources)(?:\/|$)|(?:NOTICE|package\.json|media-types\.ts|text-lines\.ts)$)/,
    /^\/resources\/(?!howmany(?:\/|$))/,
    /^\/node_modules\/\.vite[^/]*(?:\/|$)/,
    /README\.md$/,
    /\.test\.(mjs|ts)$/,
  ],
});
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
  await cp(app, destination, { recursive: true, verbatimSymlinks: true });
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', destination], { stdio: 'inherit' });
  await mkdir(path.join(home, '.local/bin'), { recursive: true });
  await writeFile(path.join(home, '.local/bin/diffpane'), launcher, { mode: 0o755 });
  console.log(`Installed ${destination}\nRun diffpane in a Git working directory.`);
}
