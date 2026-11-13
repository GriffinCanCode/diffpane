import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const electronDir = path.dirname(createRequire(import.meta.url).resolve('electron'))
const executablePath = path.join(electronDir, 'dist', readFileSync(path.join(electronDir, 'path.txt'), 'utf8'))

const root = fileURLToPath(new URL('../', import.meta.url))
// The vite alias resolves to the core bundled with Vite+.
const server = await createServer({
  root,
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
try {
  await server.listen()
  server.printUrls()
  const localUrl = server.resolvedUrls?.local[0]
  if (!localUrl) throw new Error('Vite did not provide a local development URL.')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DIFFPANE_DEV_SERVER_URL: localUrl,
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
  await server.close()
}
