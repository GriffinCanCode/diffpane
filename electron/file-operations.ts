import { lstat, realpath, rename } from 'node:fs/promises'
import path from 'node:path'

export interface Workspace {
  root: string
  scope: string
  gitDir: string
  commonDir: string
}

const RENAMES = new Map<string, Promise<void>>()

function within(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** Resolve an existing entry without following its final symlink or touching Git metadata. */
export async function operationPath(workspace: Workspace, filename: unknown) {
  if (
    typeof filename !== 'string' ||
    !filename ||
    filename.includes('\0') ||
    filename.includes('\\') ||
    path.isAbsolute(filename) ||
    filename.split('/').some(part => !part || ['.', '..', '.git'].includes(part))
  )
    throw new Error('Choose a file or folder inside this project.')
  const absolute = path.join(workspace.root, filename)
  const resolved = path.join(await realpath(path.dirname(absolute)), path.basename(absolute))
  if (
    absolute === workspace.scope ||
    !within(workspace.scope, absolute) ||
    !within(workspace.scope, resolved) ||
    [workspace.gitDir, workspace.commonDir].some(
      directory => within(directory, resolved) || within(resolved, directory),
    )
  )
    throw new Error('The project root and Git metadata cannot be changed.')
  const entry = await lstat(resolved)
  if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink())
    throw new Error('Unsupported filesystem entry.')
  return resolved
}

export async function renameEntry(workspace: Workspace, filename: unknown, name: unknown) {
  if (typeof name !== 'string' || !name.trim() || ['.', '..', '.git'].includes(name) || /[/\\\0]/u.test(name))
    throw new Error('Enter a name without slashes.')
  if (typeof filename !== 'string') throw new Error('Choose a file or folder inside this project.')
  const source = await operationPath(workspace, filename)
  if (name === path.basename(source)) return filename
  const destination = path.join(path.dirname(source), name)
  const previous = RENAMES.get(destination)
  const pending = (async () => {
    // A failed earlier rename does not block another attempt on this destination.
    await previous?.catch(() => {})
    try {
      await lstat(destination)
      throw new Error('A file or folder with that name already exists.')
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    await rename(source, destination)
  })()
  RENAMES.set(destination, pending)
  try {
    await pending
  } finally {
    if (RENAMES.get(destination) === pending) RENAMES.delete(destination)
  }
  return path.posix.join(path.posix.dirname(filename), name)
}
