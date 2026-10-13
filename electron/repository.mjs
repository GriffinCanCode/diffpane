import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { encodeText, fileContent, MAX_FILE_BYTES, readLimit } from './file-content.ts';
import { mediaType } from '../media-types.ts';

const MAX_STATUS_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const empty = () => Buffer.alloc(0);
const unavailable = note => ({ before: '', after: '', note });

export class Repository {
  constructor(root, scope, gitDir, commonDir) {
    Object.assign(this, { root, scope, gitDir, commonDir });
    this.blobs = new Map();
    this.blobBytes = 0;
    this.inventoryMetadata = new Map();
  }

  static async open(directory) {
    let scope = await realpath(directory);
    if ((await lstat(scope)).isFile()) scope = path.dirname(scope);
    const root = await realpath(await gitPath(scope, ['rev-parse', '--show-toplevel']));
    const [gitDir, commonDir] = await Promise.all([
      gitPath(root, ['rev-parse', '--absolute-git-dir']),
      gitPath(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ]);
    if (!within(root, scope))
      throw new Error('The selected directory is outside the Git working tree.');
    return new Repository(root, scope, gitDir, commonDir);
  }

  async snapshot() {
    const bytes = await git(
      this.root,
      [
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
        '--renames',
      ],
      MAX_STATUS_BYTES,
    );
    const snapshot = parseStatus(bytes);
    const scope = path.relative(this.root, this.scope).split(path.sep).join('/');
    const scoped = name => !scope || name === scope || name.startsWith(`${scope}/`);
    snapshot.files = snapshot.files.filter(
      file => scoped(file.path) || (file.originalPath !== null && scoped(file.originalPath)),
    );
    return snapshot;
  }

  async files() {
    const bytes = await git(
      this.root,
      ['ls-files', '--stage', '--cached', '--others', '--exclude-standard', '-t', '-z'],
      MAX_STATUS_BYTES,
    );
    let source;
    try {
      source = decoder.decode(bytes);
    } catch {
      throw new Error('Git returned a filename that is not valid UTF-8.');
    }
    const scope = path.relative(this.root, this.scope).split(path.sep).join('/');
    const files = new Map();
    for (const record of source.split('\0')) {
      if (!record) continue;
      // Tags distinguish untracked names from the fixed index metadata, even when a name resembles that metadata.
      const untracked = record.startsWith('? ');
      const separator = untracked ? 1 : record.indexOf('\t');
      if (record[1] !== ' ' || separator < 0) throw new Error('Invalid Git file inventory record.');
      const filename = record.slice(separator + 1);
      const prior = this.inventoryMetadata.get(filename);
      // A retained path was validated when it first entered this repository's inventory.
      if (!prior) validatePath(filename);
      if (scope && filename !== scope && !filename.startsWith(`${scope}/`)) continue;
      const submodule = !untracked && record.slice(2, 8) === '160000';
      const existing = files.get(filename);
      if (existing) {
        if (submodule && !existing.submodule) files.set(filename, { ...existing, submodule: true });
      } else
        files.set(
          filename,
          prior?.submodule === submodule
            ? prior
            : {
                path: filename,
                originalPath: null,
                index: ' ',
                worktree: ' ',
                conflicted: false,
                submodule,
              },
        );
    }
    // Replace the previous map; deleted paths do not accumulate across reorganizations.
    this.inventoryMetadata = files;
    return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async hasRelevantPaths(paths) {
    paths = [...new Set(paths)];
    if (!paths.length || paths.some(name => name === this.root || !within(this.root, name))) {
      return true;
    }
    const input = Buffer.from(`${paths.join('\0')}\0`);
    const output = await command(
      this.root,
      ['check-ignore', '-z', '--stdin'],
      MAX_STATUS_BYTES,
      input,
    );
    if (output.code === 1) return true;
    const ignored = successful(output);
    let count = 0;
    for (const byte of ignored) if (byte === 0) count += 1;
    if (count < paths.length) return true;
    // Directory notifications can contain tracked descendants of an ignored directory.
    return (await git(this.root, ['ls-files', '-z', '--', ...paths], MAX_STATUS_BYTES)).length > 0;
  }

  async contents(file, comparison = 'head') {
    validatePath(file.path);
    if (file.originalPath) validatePath(file.originalPath);
    if (!['head', 'unstaged', 'staged'].includes(comparison))
      throw new Error('Unknown comparison mode.');
    if (file.submodule) {
      return unavailable('Git submodule. Open the submodule directory to inspect its files.');
    }
    if (file.conflicted && comparison !== 'head') {
      return unavailable(
        'The index contains unresolved merge stages. Use All changes to inspect the working file and conflict markers.',
      );
    }
    const headPath = file.originalPath || file.path;
    const indexPath = ['R', 'C'].includes(file.index) ? file.path : headPath;
    const [beforeBytes, afterBytes] = await Promise.all([
      this.#blob(
        comparison === 'unstaged' ? ':' : 'HEAD:',
        comparison === 'unstaged' ? indexPath : headPath,
      ),
      comparison === 'staged' ? this.#blob(':', indexPath) : this.#workingFile(file.path),
    ]);
    const before = fileContent(beforeBytes, headPath);
    const after = fileContent(afterBytes, file.path);
    if (before.kind === 'unavailable' || after.kind === 'unavailable')
      return unavailable(before.note || after.note);
    if (before.kind !== 'text' || after.kind !== 'text' || before.limited || after.limited) {
      return {
        before: '',
        after: '',
        note: null,
        preview: {
          before:
            before.kind === 'text' && !before.hex
              ? fileContent(beforeBytes, headPath, true)
              : before,
          after:
            after.kind === 'text' && !after.hex ? fileContent(afterBytes, file.path, true) : after,
        },
      };
    }
    let note = after.note || before.note || null;
    if (file.conflicted)
      note = 'Unresolved merge conflict. The working file includes the current conflict markers.';
    else if (
      before.value !== after.value &&
      before.value.replaceAll('\r\n', '\n') === after.value.replaceAll('\r\n', '\n')
    ) {
      note = 'Only line endings changed (LF / CRLF).';
    }
    return { before: before.value, after: after.value, note };
  }

  async editable(filename) {
    try {
      await this.#editPath(filename);
      return true;
    } catch {
      return false;
    }
  }

  async #editPath(filename) {
    validatePath(filename);
    const absolute = path.join(this.root, filename);
    const parent = await realpath(path.dirname(absolute));
    const resolved = path.join(parent, path.basename(absolute));
    if (
      !within(this.scope, absolute) ||
      !within(this.scope, resolved) ||
      filename.split('/').includes('.git') ||
      [this.gitDir, this.commonDir].some(directory => within(directory, resolved)) ||
      !(await lstat(absolute)).isFile()
    )
      throw new Error('Only regular text files in this directory can be edited.');
    return absolute;
  }

  async save(filename, text, expected) {
    if (typeof text !== 'string' || typeof expected !== 'string' || text.length > MAX_FILE_BYTES)
      throw new Error('Invalid file save request.');
    const absolute = await this.#editPath(filename);
    const handle = await open(
      absolute,
      constants.O_RDWR | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES)
        throw new Error('This file cannot be edited as a complete text document.');
      const original = await handle.readFile();
      const current = fileContent(original, filename);
      if (current.kind !== 'text' || current.limited)
        throw new Error('This file cannot be edited as a complete text document.');
      if (current.value !== expected)
        throw new Error(
          'The file changed on disk. Your edits are still open and have not overwritten it.',
        );
      const bytes = encodeText(text, original);
      if (bytes.length > MAX_FILE_BYTES)
        throw new Error('The edited file exceeds the 2 MiB text limit.');
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (!bytesWritten) throw new Error('The file write did not complete.');
        offset += bytesWritten;
      }
      await handle.truncate(bytes.length);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #blob(prefix, filename) {
    const output = await command(
      this.root,
      ['rev-parse', '--verify', '--quiet', `${prefix}${filename}`],
      4096,
    );
    // Quiet verification exits 1 for missing paths and unborn HEAD.
    if (output.code === 1) return empty();
    const oid = successful(output).toString('ascii').trim();
    const key = `${oid}:${readLimit(filename)}`;
    let cached = this.blobs.get(key);
    if (cached) {
      this.blobs.delete(key);
      this.blobs.set(key, cached);
      return cached.value;
    }
    cached = { bytes: 0 };
    cached.value = (async () => {
      const size = Number(
        (await git(this.root, ['cat-file', '-s', oid], 4096)).toString('ascii').trim(),
      );
      const bytes = successful(
        await command(this.root, ['cat-file', 'blob', oid], readLimit(filename), undefined, true),
      );
      return { bytes, size };
    })();
    this.blobs.set(key, cached);
    try {
      const value = await cached.value;
      // Object IDs are immutable, so HEAD/index changes need no blob invalidation.
      if (this.blobs.get(key) === cached) {
        cached.bytes = value.bytes?.length ?? 0;
        this.blobBytes += cached.bytes;
        while (this.blobs.size > 32 || this.blobBytes > 8 * 1024 * 1024) {
          const oldest = this.blobs.keys().next().value;
          this.blobBytes -= this.blobs.get(oldest).bytes;
          this.blobs.delete(oldest);
        }
      }
      return value;
    } catch (error) {
      if (this.blobs.get(key) === cached) this.blobs.delete(key);
      throw error;
    }
  }

  async #workingFile(filename) {
    const absolute = path.join(this.root, filename);
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch (error) {
      if (missing(error)) return empty();
      throw error;
    }
    let parent;
    try {
      parent = await realpath(path.dirname(absolute));
    } catch (error) {
      if (missing(error)) return empty();
      throw error;
    }
    if (!within(this.root, parent)) {
      return { note: 'The parent directory resolves outside this repository; preview skipped.' };
    }
    // Git stores a symlink's target, never the contents reached through that link.
    if (metadata.isSymbolicLink()) return readlink(absolute, { encoding: 'buffer' });
    if (metadata.isDirectory()) return empty();
    if (!metadata.isFile()) return { note: 'This path is not a regular file.' };
    let handle;
    try {
      handle = await open(
        absolute,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
      );
      const current = await handle.stat();
      if (!current.isFile()) return { note: 'This path is not a regular file.' };
      const streamed = Boolean(mediaType(filename));
      const limit = streamed ? 64 * 1024 : readLimit(filename);
      const chunks = [];
      let length = 0;
      for await (const chunk of handle.createReadStream({
        autoClose: false,
        start: 0,
        end: limit - 1,
      })) {
        length += chunk.length;
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks, length), size: current.size, streamed };
    } catch (error) {
      if (missing(error)) return empty();
      throw error;
    } finally {
      await handle?.close();
    }
  }
}

function validatePath(filename) {
  const parts = typeof filename === 'string' ? filename.split('/') : [];
  if (
    !parts.length ||
    !filename ||
    filename.includes('\0') ||
    path.isAbsolute(filename) ||
    parts.some(part => part === '..' || part === '.') ||
    !within(path.resolve('.'), path.resolve('.', filename))
  ) {
    throw new Error('Git returned an invalid repository-relative path.');
  }
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';

function parseStatus(bytes) {
  let source;
  try {
    source = decoder.decode(bytes);
  } catch {
    throw new Error('Git returned a filename that is not valid UTF-8.');
  }
  const records = source.split('\0');
  const files = new Map();
  let branch = 'HEAD';
  let oid = '';
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith('# branch.head ')) {
      branch = record.slice(14);
      continue;
    }
    if (record.startsWith('# branch.oid ')) {
      oid = record.slice(13);
      continue;
    }
    if (record.startsWith('#')) continue;
    let file;
    if (record.startsWith('? ')) {
      file = {
        path: record.slice(2),
        originalPath: null,
        index: '?',
        worktree: '?',
        conflicted: false,
        submodule: false,
      };
    } else if (['1', '2', 'u'].includes(record[0])) {
      const count = record[0] === '1' ? 9 : record[0] === '2' ? 10 : 11;
      const fields = splitFields(record, count);
      if (fields[1].length !== 2) throw new Error('Invalid porcelain v2 Git status record.');
      const originalPath = record[0] === '2' ? records[++i] : null;
      if (record[0] === '2' && !originalPath) throw new Error('Git rename has no original path.');
      file = {
        path: fields[count - 1],
        originalPath,
        index: fields[1][0] === '.' ? ' ' : fields[1][0],
        worktree: fields[1][1] === '.' ? ' ' : fields[1][1],
        conflicted: record[0] === 'u',
        submodule: fields[2][0] === 'S',
      };
    } else throw new Error('Unknown porcelain v2 Git status record.');
    validatePath(file.path);
    const existing = files.get(file.path);
    // A staged deletion recreated in the worktree appears again as untracked.
    if (existing && file.index === '?') existing.worktree = '?';
    else {
      if (existing) file.worktree = '?';
      files.set(file.path, file);
    }
  }
  if (branch === '(detached)') branch = `detached ${oid.slice(0, 8)}`;
  else if (oid === '(initial)') branch += ' (unborn)';
  return {
    branch,
    files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

function splitFields(record, count) {
  const fields = [];
  let start = 0;
  while (fields.length < count - 1) {
    const end = record.indexOf(' ', start);
    if (end < 0) throw new Error('Invalid porcelain v2 Git status record.');
    fields.push(record.slice(start, end));
    start = end + 1;
  }
  fields.push(record.slice(start));
  return fields;
}

async function gitPath(directory, args) {
  const bytes = await git(directory, args, MAX_STATUS_BYTES);
  return decoder.decode(bytes.at(-1) === 10 ? bytes.subarray(0, -1) : bytes);
}

async function git(directory, args, limit) {
  return successful(await command(directory, args, limit));
}

function successful(output) {
  if (output.code === 0) return output.stdout;
  throw new Error(
    output.stderr.toString('utf8').trim() || `Git exited with ${output.code ?? output.signal}.`,
  );
}

function command(directory, args, limit, input, truncate = false) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };
  // Shells launched from Git hooks can redirect the repository, index and pathspec semantics.
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_LITERAL_PATHSPECS',
    'GIT_GLOB_PATHSPECS',
    'GIT_NOGLOB_PATHSPECS',
    'GIT_ICASE_PATHSPECS',
  ])
    delete env[key];
  const gitArgs = ['--no-optional-locks'];
  // check-ignore rejects pathspec magic; its absolute stdin paths are already literal.
  if (args[0] !== 'check-ignore') gitArgs.push('--literal-pathspecs');
  gitArgs.push('-C', directory, ...args);
  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const stdout = [];
    const stderr = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let settled = false;
    let limited = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* A process that already exited needs no termination. */
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error('Git did not finish within 10 seconds; try refreshing.')),
      GIT_TIMEOUT_MS,
    );
    timer.unref();
    child.on('error', error => fail(new Error(`Cannot run Git: ${error.message}`)));
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') fail(error);
    });
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.stdout.on('data', chunk => {
      if (limited) return;
      if (truncate && stdoutLength + chunk.length > limit) {
        stdout.push(chunk.subarray(0, limit - stdoutLength));
        stdoutLength = limit;
        limited = true;
        child.kill('SIGKILL');
        return;
      }
      stdoutLength += chunk.length;
      if (stdoutLength > limit)
        fail(
          Object.assign(new Error('Git output exceeds the preview limit.'), {
            code: 'OUTPUT_LIMIT',
          }),
        );
      else stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrLength += chunk.length;
      if (stderrLength > 64 * 1024) fail(new Error('Git error output exceeds the preview limit.'));
      else stderr.push(chunk);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: limited ? 0 : code,
        signal,
        stdout: Buffer.concat(stdout, stdoutLength),
        stderr: Buffer.concat(stderr, stderrLength),
      });
    });
    child.stdin.end(input);
  });
}
