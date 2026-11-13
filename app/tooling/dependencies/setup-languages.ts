import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, symlink, rename, access, writeFile, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const tools =
  process.env.DIFFPANE_LANGUAGE_DIR ?? path.join(os.homedir(), 'Library/Application Support/Diffpane/languages')
const bin = path.join(tools, 'bin')
const pinConfig: unknown = JSON.parse(await readFile(new URL('./language-tools.json', import.meta.url), 'utf8'))
if (
  typeof pinConfig !== 'object' ||
  pinConfig === null ||
  !('gopls' in pinConfig) ||
  typeof pinConfig.gopls !== 'string' ||
  !/^v\d+\.\d+\.\d+$/.test(pinConfig.gopls) ||
  !('elixirLS' in pinConfig) ||
  typeof pinConfig.elixirLS !== 'object' ||
  pinConfig.elixirLS === null ||
  !('version' in pinConfig.elixirLS) ||
  typeof pinConfig.elixirLS.version !== 'string' ||
  !('url' in pinConfig.elixirLS) ||
  typeof pinConfig.elixirLS.url !== 'string' ||
  new URL(pinConfig.elixirLS.url).protocol !== 'https:' ||
  !('sha256' in pinConfig.elixirLS) ||
  typeof pinConfig.elixirLS.sha256 !== 'string' ||
  !/^[0-9a-f]{64}$/.test(pinConfig.elixirLS.sha256)
)
  throw new Error('Invalid language tool pins.')
const { gopls } = pinConfig
const elixirLS = {
  version: pinConfig.elixirLS.version,
  url: pinConfig.elixirLS.url,
  sha256: pinConfig.elixirLS.sha256,
}
await mkdir(bin, { recursive: true })

async function link(source: string, name: string) {
  const temporary = await mkdtemp(path.join(bin, '.link-'))
  const staged = path.join(temporary, name)
  try {
    await symlink(source, staged)
    await rename(staged, path.join(bin, name))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

const { stdout: analyzer } = await execute('rustup', ['which', 'rust-analyzer'])
await link(analyzer.trim(), 'rust-analyzer')
// Prefer an active toolchain; mise's installed inventory also works outside a configured project.
let go: string | undefined
try {
  const { stdout } = await execute('mise', ['ls', '--installed', '--json', 'go'])
  const inventory: unknown = JSON.parse(stdout)
  if (Array.isArray(inventory)) {
    const entries: unknown[] = inventory
    const versions = entries.filter(
      (entry): entry is { version: string; install_path: string } =>
        typeof entry === 'object' &&
        entry !== null &&
        'version' in entry &&
        typeof entry.version === 'string' &&
        'install_path' in entry &&
        typeof entry.install_path === 'string' &&
        path.isAbsolute(entry.install_path),
    )
    const latest = versions.toSorted((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0]
    if (latest) go = path.join(latest.install_path, 'bin/go')
  }
} catch {
  /* A normal PATH-installed Go toolchain works as well. */
}
go ??= (await execute('which', ['go'])).stdout.trim()
await link(go, 'go')
console.info(`Installing gopls ${gopls}`)
await execute(go, ['install', `golang.org/x/tools/gopls@${gopls}`], {
  env: { ...process.env, GOBIN: bin, GOMAXPROCS: '2', GOFLAGS: '-p=2' },
  maxBuffer: 2 * 1024 * 1024,
})

await execute('elixir', ['--version'], {
  env: { ...process.env, ERL_FLAGS: '+S 2:2 +SDcpu 1 +SDio 1' },
})
const release = path.join(tools, 'elixir-ls')
const marker = path.join(release, '.diffpane-version')
let installed: string | undefined
try {
  installed = await readFile(marker, 'utf8')
  await access(path.join(release, 'language_server.sh'))
} catch {
  installed = undefined
}
if (installed?.trim() !== elixirLS.version) {
  console.info(`Installing ElixirLS ${elixirLS.version}`)
  const response = await fetch(elixirLS.url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`ElixirLS download failed: ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(archive).digest('hex') !== elixirLS.sha256)
    throw new Error('ElixirLS checksum mismatch')
  const temp = await mkdtemp(path.join(os.tmpdir(), 'diffpane-language-'))
  try {
    const file = path.join(temp, 'elixir-ls.zip')
    await writeFile(file, archive)
    await mkdir(release, { recursive: true })
    await execute('/usr/bin/unzip', ['-oq', file, '-d', release])
    await access(path.join(release, 'language_server.sh'))
    await writeFile(marker, elixirLS.version)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
console.info(`Language tools installed in ${tools}`)
