import { execFileSync, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, writeFile, rename, readFile, readlink, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { packager } from '@electron/packager'
import { appError } from '../../shared/recovery/app-errors.ts'
import { setupHowMany } from '../dependencies/setup-howmany.ts'

const metadata: unknown = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'))
if (
  !metadata ||
  typeof metadata !== 'object' ||
  !('version' in metadata) ||
  typeof metadata.version !== 'string' ||
  !/^\d+\.\d+\.\d+$/.test(metadata.version)
)
  throw new Error('Diffpane requires a numeric release version in package.json.')
const { version } = metadata
if (process.argv.length > 2) throw new Error('Usage: npm run install:app')

if (process.platform !== 'darwin')
  throw new Error('The terminal launcher installer currently targets macOS. Use npm start on other platforms.')

const userDirectory = os.homedir()
const applications = path.join(userDirectory, 'Applications')
const destination = path.join(applications, 'Diffpane.app')
const bin = path.join(userDirectory, '.local/bin')
const shortLauncher = path.join(bin, 'dp')
const longLauncher = path.join(bin, 'diffpane')
async function existingLauncher(filename: string) {
  try {
    return await lstat(filename)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}
const [existingShortLauncher, existingLongLauncher] = await Promise.all([
  existingLauncher(shortLauncher),
  existingLauncher(longLauncher),
])
if (
  existingShortLauncher &&
  (!existingShortLauncher.isSymbolicLink() || (await readlink(shortLauncher)) !== 'diffpane')
)
  throw new Error(`Cannot install the dp shortcut because ${shortLauncher} is already in use.`)
if (existingLongLauncher && !existingLongLauncher.isFile() && !existingLongLauncher.isSymbolicLink())
  throw new Error(`Cannot install the launcher because ${longLauncher} is already in use.`)

async function buildRenderer() {
  const child = spawn('npm', ['run', 'build'], { stdio: 'inherit' })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Renderer build failed (${signal ?? code})`))
    })
  })
}

for (const result of await Promise.allSettled([buildRenderer(), setupHowMany()])) {
  if (result.status === 'rejected') throw appError(result.reason, { operation: 'prepare-install' })
}

await mkdir('release', { recursive: true })
const scratch = await mkdtemp('release/.packager-')
const [bundle] = await (async () => {
  try {
    return await packager({
      dir: '.',
      out: 'release',
      tmpdir: scratch,
      name: 'Diffpane',
      appBundleId: 'com.diffpane.app',
      icon: 'branding/desktop/diffpane.icns',
      appVersion: version,
      overwrite: true,
      asar: { unpack: '**/*.node' },
      beforeAsar: [
        async ({ buildPath }) => {
          // Child processes already use these physical paths. Move the staged
          // payloads directly so ASAR does not index and copy them a second time.
          const unpacked = `${buildPath}.asar.unpacked`
          await Promise.all([
            mkdir(path.join(unpacked, 'node_modules'), { recursive: true }),
            mkdir(path.join(unpacked, 'resources'), { recursive: true }),
          ])
          for (const directory of [
            'node_modules/basedpyright',
            'node_modules/typescript',
            'node_modules/typescript-language-server',
            'resources/howmany',
          ]) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Finish each move before staging the next packaged payload.
            await rename(path.join(buildPath, directory), path.join(unpacked, directory))
          }
        },
      ],
      ignore: [
        /^\/(?!(?:app|dist|legal|node_modules|resources)(?:\/|$)|package\.json$)/,
        /^\/app\/(?!(?:electron|shared)(?:\/|$))/,
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
    })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})()
if (!bundle) throw new Error('Electron Packager did not produce a macOS app.')
const app = path.join(bundle, 'Diffpane.app')
const launcher = (await readFile(new URL('./diffpane.sh', import.meta.url), 'utf8')).replace('@VERSION@', version)
await mkdir(applications, { recursive: true })
await mkdir(bin, { recursive: true })
const staging = await mkdtemp(path.join(applications, '.diffpane-'))
const stagedApp = path.join(staging, 'Diffpane.app')
const previous = path.join(staging, 'Diffpane-previous.app')
let launcherStage: string | undefined
let shortcutCreated = false
let backup = false
let appInstalled = false
try {
  await cp(app, stagedApp, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  })
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', stagedApp], { stdio: 'inherit' })
  launcherStage = await mkdtemp(path.join(bin, '.diffpane-'))
  const stagedLauncher = path.join(launcherStage, 'diffpane')
  await writeFile(stagedLauncher, launcher, { mode: 0o755 })
  try {
    await symlink('diffpane', shortLauncher)
    shortcutCreated = true
  } catch (error) {
    if ((await readlink(shortLauncher).catch(() => null)) !== 'diffpane') throw error
  }
  try {
    await rename(destination, previous)
    backup = true
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  try {
    await rename(stagedApp, destination)
    appInstalled = true
    await rename(stagedLauncher, longLauncher)
  } catch (error) {
    try {
      if (appInstalled) await rename(destination, stagedApp)
      if (backup) {
        await rename(previous, destination)
        backup = false
      }
    } catch (rollback) {
      const message = backup
        ? `Previous app kept at ${previous}`
        : `Could not remove the partial install at ${destination}`
      throw new AggregateError([error, rollback], message, { cause: rollback })
    }
    throw error
  }
  if (backup) {
    try {
      await rename(previous, path.join(os.tmpdir(), `Diffpane-previous-${Date.now()}.app`))
      backup = false
    } catch {
      console.info(`Previous app kept at ${previous}`)
    }
  }
} catch (error) {
  if (shortcutCreated && (await readlink(shortLauncher).catch(() => null)) === 'diffpane') {
    try {
      await rm(shortLauncher, { force: true })
    } catch (rollback) {
      throw new AggregateError([error, rollback], `Could not remove the partial shortcut at ${shortLauncher}`, {
        cause: rollback,
      })
    }
  }
  throw error
} finally {
  // Preserve the old bundle if the rollback itself fails.
  await Promise.all([
    backup ? undefined : rm(staging, { recursive: true, force: true }),
    launcherStage ? rm(launcherStage, { recursive: true, force: true }) : undefined,
  ])
}
console.info(`Installed ${destination}\nRun dp or diffpane to open Diffpane.`)
