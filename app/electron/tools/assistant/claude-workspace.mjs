import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { mediaType } from '../../../shared/documents/media-types.ts'
import { fileContent } from '../../workspace/documents/file-content.ts'
import { operationPath } from '../../workspace/repository/file-operations.ts'

export const MAX_CLAUDE_FILE_BYTES = 512 * 1024
const PRIVATE_NAME =
  /^(?:\.env(?:\.|$)|\.git$|\.git-credentials$|\.netrc$|\.npmrc$|\.pypirc$|\.ssh$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|(?:credentials|secrets)\.json$)|\.(?:pem|key|p12|pfx|keystore)$/iu
function unavailable() {
  return new Error('The Creature can access only regular project text files in scope.')
}

/** @param {unknown} filename @returns {filename is string} */
export function claudeVisiblePath(filename) {
  return (
    typeof filename === 'string' &&
    Boolean(filename) &&
    filename.length <= 4096 &&
    !filename.includes('\\') &&
    !filename.includes('\0') &&
    !mediaType(filename) &&
    !filename.split('/').some(part => !part || part === '.' || part === '..' || PRIVATE_NAME.test(part))
  )
}

/** @param {import('../../workspace/repository/file-operations.ts').Workspace} workspace @param {string} filename */
export async function claudeFilePath(workspace, filename) {
  if (!claudeVisiblePath(filename)) throw unavailable()
  const absolute = await operationPath(workspace, filename)
  if (absolute !== path.join(workspace.root, filename)) throw unavailable()
  return absolute
}

/** @param {import('node:fs/promises').FileHandle} handle @param {string} absolute */
export async function checkClaudeFile(handle, absolute) {
  const [metadata, current, parent] = await Promise.all([
    handle.stat(),
    lstat(absolute),
    realpath(path.dirname(absolute)),
  ])
  if (
    !metadata.isFile() ||
    !current.isFile() ||
    metadata.nlink !== 1 ||
    metadata.dev !== current.dev ||
    metadata.ino !== current.ino ||
    parent !== path.dirname(absolute) ||
    metadata.size > MAX_CLAUDE_FILE_BYTES
  )
    throw unavailable()
  return metadata
}

/** @param {import('node:fs/promises').FileHandle} handle @param {number} size */
export async function readClaudeBytes(handle, size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CLAUDE_FILE_BYTES) throw unavailable()
  const buffer = Buffer.alloc(size + 1)
  let offset = 0
  while (offset < buffer.length) {
    // oxlint-disable-next-line no-await-in-loop -- Partial reads advance the offset for the next chunk.
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (!bytesRead) break
    offset += bytesRead
  }
  if (offset !== size) throw new Error('The file changed while the Creature was reading it.')
  return buffer.subarray(0, offset)
}

/** @param {import('../../workspace/repository/file-operations.ts').Workspace} workspace @param {unknown} filename */
export async function readClaudeFile(workspace, filename) {
  if (typeof filename !== 'string') throw unavailable()
  const absolute = await claudeFilePath(workspace, filename)
  await using handle = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
  )
  const { size } = await checkClaudeFile(handle, absolute)
  const contents = fileContent(await readClaudeBytes(handle, size), filename)
  if (contents.kind !== 'text' || contents.limited) throw unavailable()
  return contents.value
}
