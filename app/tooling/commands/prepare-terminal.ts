import { chmodSync, lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url)
  const packageRoot = path.dirname(require.resolve('node-pty/package.json'))
  const helper = path.join(packageRoot, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper')
  const info = lstatSync(helper, { throwIfNoEntry: false })
  // node-pty 1.1.0 publishes the macOS spawn helper without execute permissions.
  if (info?.isFile() && (info.mode & 0o111) !== 0o111) chmodSync(helper, (info.mode & 0o777) | 0o111)
}
