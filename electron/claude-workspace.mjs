import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileContent } from './file-content.ts';
import { operationPath } from './file-operations.ts';
import { mediaType } from '../media-types.ts';

const MAX_CLAUDE_FILE_BYTES = 512 * 1024;
const privateName =
  /^(?:\.env(?:\.|$)|\.git$|\.git-credentials$|\.netrc$|\.npmrc$|\.pypirc$|\.ssh$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|(?:credentials|secrets)\.json$)|\.(?:pem|key|p12|pfx|keystore)$/iu;
const unavailable = () => new Error('Claude can access only regular project text files in scope.');

export function claudeVisiblePath(filename) {
  return (
    typeof filename === 'string' &&
    filename.length <= 4096 &&
    !mediaType(filename) &&
    !filename.split('/').some(part => privateName.test(part))
  );
}

export async function claudeFilePath(workspace, filename) {
  if (!claudeVisiblePath(filename)) throw unavailable();
  const absolute = await operationPath(workspace, filename);
  if (absolute !== path.join(workspace.root, filename)) throw unavailable();
  return absolute;
}

export async function checkClaudeFile(handle, absolute) {
  const [metadata, current, parent] = await Promise.all([
    handle.stat(),
    lstat(absolute),
    realpath(path.dirname(absolute)),
  ]);
  if (
    !metadata.isFile() ||
    !current.isFile() ||
    metadata.nlink !== 1 ||
    metadata.dev !== current.dev ||
    metadata.ino !== current.ino ||
    parent !== path.dirname(absolute) ||
    metadata.size > MAX_CLAUDE_FILE_BYTES
  )
    throw unavailable();
  return metadata;
}

export async function readClaudeBytes(handle, size) {
  const buffer = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset !== size) throw new Error('The file changed while Claude was reading it.');
  return buffer.subarray(0, offset);
}

export async function readClaudeFile(workspace, filename) {
  const absolute = await claudeFilePath(workspace, filename);
  const handle = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
  );
  try {
    const { size } = await checkClaudeFile(handle, absolute);
    const contents = fileContent(await readClaudeBytes(handle, size), filename);
    if (contents.kind !== 'text' || contents.limited) throw unavailable();
    return contents.value;
  } finally {
    await handle.close();
  }
}
