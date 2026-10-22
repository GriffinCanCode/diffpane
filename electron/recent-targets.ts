import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export type RecentTarget = {
  path: string;
  name: string;
  kind: 'folder' | 'file';
  openedAt: number;
};

const LIMIT = 8;
const LOCK_WAIT_MS = 600;
const STALE_LOCK_MS = 30_000;
type Mutation = { entry: RecentTarget } | { remove: string };

/** A small, optional history whose disk writes cannot corrupt the last saved list. */
export class RecentTargets {
  private filename: string;
  private entries: RecentTarget[] = [];
  private operations: Promise<void> = Promise.resolve();
  private pending: Mutation[] = [];
  readonly ready: Promise<void>;

  constructor(filename: string) {
    this.filename = filename;
    this.ready = this.refresh();
  }

  private async read(): Promise<RecentTarget[] | null> {
    try {
      const stored: unknown = JSON.parse(await readFile(this.filename, 'utf8'));
      if (!Array.isArray(stored)) return null;
      const seen = new Set<string>();
      return stored
        .filter(
          (entry): entry is RecentTarget =>
            entry !== null &&
            typeof entry === 'object' &&
            typeof entry.path === 'string' &&
            path.isAbsolute(entry.path) &&
            !entry.path.includes('\0') &&
            ['folder', 'file'].includes(entry.kind) &&
            typeof entry.openedAt === 'number' &&
            Number.isFinite(entry.openedAt) &&
            entry.openedAt > 0,
        )
        .sort((left, right) => right.openedAt - left.openedAt)
        .map(entry => {
          const filename = path.resolve(entry.path);
          return {
            path: filename,
            name: path.basename(filename) || filename,
            kind: entry.kind,
            openedAt: entry.openedAt,
          };
        })
        .filter(entry => {
          if (seen.has(entry.path)) return false;
          seen.add(entry.path);
          return true;
        })
        .slice(0, LIMIT);
    } catch {
      // Retain uncommitted in-memory changes if disk history is unavailable.
      return null;
    }
  }

  private apply(entries: RecentTarget[], mutations: Mutation[]) {
    for (const mutation of mutations) {
      if ('remove' in mutation) entries = entries.filter(entry => entry.path !== mutation.remove);
      else {
        const previous = entries.find(entry => entry.path === mutation.entry.path);
        if (!previous || previous.openedAt <= mutation.entry.openedAt)
          entries = [
            mutation.entry,
            ...entries.filter(entry => entry.path !== mutation.entry.path),
          ].sort((left, right) => right.openedAt - left.openedAt);
      }
      entries = entries.slice(0, LIMIT);
    }
    return entries;
  }

  private async refresh() {
    this.entries = this.apply((await this.read()) ?? this.entries, this.pending);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(async () => {
      await this.ready;
      return operation();
    });
    this.operations = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  list(): Promise<RecentTarget[]> {
    return this.serialize(async () => {
      // Other `open -n` app processes can have committed a newer recent list.
      await this.refresh();
      return this.entries.map(entry => ({ ...entry }));
    });
  }

  async record(target: string) {
    const filename = path.resolve(target);
    const openedAt = Date.now();
    const info = await stat(filename).catch(() => null);
    if (!info?.isFile() && !info?.isDirectory()) return;
    const entry: RecentTarget = {
      path: filename,
      name: path.basename(filename) || filename,
      kind: info.isFile() ? 'file' : 'folder',
      openedAt,
    };
    await this.update({ entry });
  }

  remove(target: string) {
    return this.update({ remove: target });
  }

  private update(mutation: Mutation) {
    return this.serialize(async () => {
      this.pending.push(mutation);
      const unlock = await this.lock();
      try {
        await this.refresh();
        if (!unlock) return;
        await this.persist();
        this.pending = [];
      } catch {
        // History is optional; keep unsaved changes for the next successful write.
      } finally {
        await unlock?.();
      }
    });
  }

  private async lock(): Promise<(() => Promise<void>) | null> {
    const filename = `${this.filename}.lock`;
    const token = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    try {
      await mkdir(path.dirname(this.filename), { recursive: true });
      for (;;) {
        try {
          await writeFile(filename, token, { flag: 'wx', mode: 0o600 });
          return async () => {
            if ((await readFile(filename, 'utf8').catch(() => null)) === token)
              await rm(filename, { force: true }).catch(() => {});
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
          const info = await stat(filename).catch(() => null);
          if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
            await rm(filename, { force: true }).catch(() => {});
            continue;
          }
          if (Date.now() >= deadline) return null;
          await delay(15);
        }
      }
    } catch {
      return null;
    }
  }

  private async persist() {
    const contents = `${JSON.stringify(this.entries, null, 2)}\n`;
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, this.filename);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
