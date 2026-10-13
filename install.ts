import { packager } from '@electron/packager';
import { cp, mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { setupHowMany } from './setup-howmany.ts';

const { version } = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

if (process.platform !== 'darwin') throw new Error('The terminal launcher installer currently targets macOS. Use npm start on other platforms.');
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
await setupHowMany();
const [bundle] = await packager({
  dir: '.', out: 'release', name: 'Diffpane', appBundleId: 'com.diffpane.app',
  appVersion: version, overwrite: true, asar: { unpack: '**/*.node', unpackDir: '{node_modules/{basedpyright,typescript,typescript-language-server},resources/howmany}' },
  ignore: [/^\/(release|target|tests|renderer)(\/|$)/, /^\/\./, /README\.md$/, /\.test\.mjs$/],
});
const home = os.homedir();
const destination = path.join(home, 'Applications/Diffpane.app');
try { await rename(destination, path.join(os.tmpdir(), `Diffpane-previous-${Date.now()}.app`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(path.dirname(destination), { recursive: true });
await cp(path.join(bundle, 'Diffpane.app'), destination, { recursive: true, verbatimSymlinks: true });
execFileSync('codesign', ['--force', '--deep', '--sign', '-', destination], { stdio: 'inherit' });
await mkdir(path.join(home, '.local/bin'), { recursive: true });
const launcher = `#!/bin/sh
set -eu
app="$HOME/Applications/Diffpane.app"
case "\${1:-}" in
  --help|-h) printf '%s\\n' 'diffpane [DIRECTORY|FILE]' 'View full files and live Git changes. Defaults to the current directory.'; exit 0 ;;
  --version) printf '%s\\n' 'diffpane ${version}'; exit 0 ;;
  -*) printf '%s\\n' 'usage: diffpane [DIRECTORY|FILE]' >&2; exit 1 ;;
esac
if [ "$#" -gt 1 ]; then printf '%s\\n' 'usage: diffpane [DIRECTORY|FILE]' >&2; exit 1; fi
folder="\${1:-$PWD}"
case "$folder" in /*) ;; *) folder="$PWD/$folder" ;; esac
target="$folder"
if [ -f "$folder" ]; then folder="$(dirname "$folder")"; fi
git -C "$folder" rev-parse --show-toplevel >/dev/null
exec /usr/bin/open -n "$app" --args "$target"
`;
await writeFile(path.join(home, '.local/bin/diffpane'), launcher, { mode: 0o755 });
console.log(`Installed ${destination}\nRun diffpane in a Git working directory.`);
