import path from 'node:path';
import { lstat, realpath, rename } from 'node:fs/promises';

type Workspace = { root: string; scope: string; gitDir: string; commonDir: string };
const within = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};

/** Resolve an existing entry without following its final symlink or touching Git metadata. */
export async function operationPath(workspace: Workspace, filename: string) {
  if (
    typeof filename !== 'string' ||
    !filename ||
    filename.includes('\0') ||
    filename.includes('\\') ||
    path.isAbsolute(filename) ||
    filename.split('/').some(part => !part || ['.', '..', '.git'].includes(part))
  )
    throw new Error('Choose a file or folder inside this project.');
  const absolute = path.join(workspace.root, filename);
  const resolved = path.join(await realpath(path.dirname(absolute)), path.basename(absolute));
  if (
    absolute === workspace.scope ||
    !within(workspace.scope, absolute) ||
    !within(workspace.scope, resolved) ||
    [workspace.gitDir, workspace.commonDir].some(
      directory => within(directory, resolved) || within(resolved, directory),
    )
  )
    throw new Error('The project root and Git metadata cannot be changed.');
  const entry = await lstat(resolved);
  if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink())
    throw new Error('Unsupported filesystem entry.');
  return resolved;
}

export async function renameEntry(workspace: Workspace, filename: string, name: string) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    ['.', '..', '.git'].includes(name) ||
    /[/\\\0]/u.test(name)
  )
    throw new Error('Enter a name without slashes.');
  const source = await operationPath(workspace, filename);
  if (name === path.basename(source)) return filename;
  const destination = path.join(path.dirname(source), name);
  try {
    await lstat(destination);
    throw new Error('A file or folder with that name already exists.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await rename(source, destination);
  return path.posix.join(path.posix.dirname(filename), name);
}
