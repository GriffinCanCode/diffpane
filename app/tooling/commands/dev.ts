import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, createServer } from 'vite'

const electronDir = path.dirname(createRequire(import.meta.url).resolve('electron'))
const executablePath = path.join(electronDir, 'dist', readFileSync(path.join(electronDir, 'path.txt'), 'utf8'))

const root = fileURLToPath(new URL('../../../', import.meta.url))
// The vite alias resolves to the core bundled with Vite+.
const server = await createServer({
  configFile: path.join(root, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
const terminalAssets = await mkdtemp(path.join(tmpdir(), 'diffpane-terminal-'))
try {
  // The view with a shell bridge loads built assets from its dedicated local protocol.
  await build({
    configFile: false,
    root: path.join(root, 'app'),
    base: './',
    publicDir: false,
    build: {
      outDir: terminalAssets,
      emptyOutDir: false,
      rolldownOptions: { input: path.join(root, 'app/terminal.html') },
    },
  })
  await server.listen()
  server.printUrls()
  const localUrl = server.resolvedUrls?.local[0]
  if (!localUrl) throw new Error('Vite did not provide a local development URL.')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DIFFPANE_DEV_SERVER_URL: localUrl,
    DIFFPANE_DEV_TERMINAL_ASSETS: terminalAssets,
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executablePath, ['.', ...process.argv.slice(2)], {
    cwd: root,
    env,
    stdio: 'inherit',
  })
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
  const stop = () => child.kill('SIGTERM')
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    process.exitCode = await exited
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
} finally {
  await Promise.all([server.close(), rm(terminalAssets, { recursive: true, force: true })])
}
