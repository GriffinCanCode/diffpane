import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MAX_REVIEW_EXCERPT_LENGTH,
  MAX_REVIEW_EXCERPT_LINES,
  MAX_REVIEW_NOTE_LENGTH,
  type ReviewAnchor,
  type ReviewNote,
  type ReviewNoteChange,
} from '../review-notes.ts';

const MAX_NOTES = 250;
const BUSY_WAIT_MS = 2000;
const SQLITE_BUSY = 5;
const NOTE_ID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u;
const VISIBLE_NOTE = `worktree = ?1 AND (
  CASE WHEN anchor_path IS NULL THEN project_scope = ?2
    ELSE ?2 = '' OR substr(anchor_path, 1, length(?2) + 1) = ?2 || '/' END
)`;

type StoredNote = { id: string; anchor: string | null; text: string; resolved: 0 | 1 };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function repositoryPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 16_384 &&
    !value.includes('\0') &&
    !path.isAbsolute(value) &&
    !(path.sep === '\\' && /[\\:]/u.test(value)) &&
    value.split('/').every(part => part && !['.', '..', '.git'].includes(part.toLowerCase()))
  );
}

function relativeScope(root: string, scope: string) {
  const relative = path.relative(root, scope).split(path.sep).join('/');
  if (!path.isAbsolute(root) || !path.isAbsolute(scope) || (relative && !repositoryPath(relative)))
    throw new Error('The open folder is outside the Git working tree.');
  return relative;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseAnchor(value: unknown): ReviewAnchor | null {
  if (value === null) return null;
  if (!record(value)) throw new Error('Invalid review note location.');
  const { path: filename, originalPath, side, line, endLine, excerpt, truncated } = value;
  if (
    !repositoryPath(filename) ||
    (side !== 'working' && side !== 'head') ||
    (originalPath !== undefined && (side !== 'head' || !repositoryPath(originalPath))) ||
    typeof excerpt !== 'string' ||
    excerpt.length > MAX_REVIEW_EXCERPT_LENGTH ||
    typeof truncated !== 'boolean'
  )
    throw new Error('Invalid review note location.');
  const source: Omit<ReviewAnchor, 'line' | 'endLine'> = {
    path: filename,
    ...(originalPath === undefined ? {} : { originalPath }),
    side,
    excerpt,
    truncated,
  };
  if (line === null && endLine === null && excerpt === '' && !truncated)
    return { ...source, line, endLine };
  if (positiveInteger(line) && positiveInteger(endLine) && endLine >= line) {
    const excerptLines = excerpt.split('\n').length;
    const selectedLines = endLine - line + 1;
    if (
      excerptLines <= Math.min(selectedLines, MAX_REVIEW_EXCERPT_LINES) &&
      (truncated || excerptLines === selectedLines)
    )
      return { ...source, line, endLine };
  }
  throw new Error('Invalid review note location.');
}

function noteText(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    value.length > MAX_REVIEW_NOTE_LENGTH
  )
    throw new Error(`Enter a note up to ${MAX_REVIEW_NOTE_LENGTH.toLocaleString()} characters.`);
  return value.trim();
}

function parseChange(input: unknown): ReviewNoteChange {
  if (record(input)) {
    if (input.type === 'add')
      return { type: 'add', anchor: parseAnchor(input.anchor), text: noteText(input.text) };
    const { id } = input;
    if (typeof id === 'string' && NOTE_ID.test(id)) {
      if (input.type === 'edit') {
        const expectedText = noteText(input.expectedText);
        if (expectedText === input.expectedText)
          return { type: 'edit', id, text: noteText(input.text), expectedText };
      }
      if (input.type === 'resolve' && typeof input.resolved === 'boolean')
        return { type: 'resolve', id, resolved: input.resolved };
      if (input.type === 'delete') return { type: 'delete', id };
    }
  }
  throw new Error('Invalid review note change.');
}

function readNotes(database: DatabaseSync, root: string, scope: string): ReviewNote[] {
  const rows = database
    .prepare(`SELECT id, anchor, text, resolved FROM review_notes WHERE ${VISIBLE_NOTE}
      ORDER BY sequence DESC`)
    .all(root, scope) as StoredNote[];
  return rows.map(({ id, anchor, text, resolved }) => ({
    id,
    anchor: anchor === null ? null : (JSON.parse(anchor) as ReviewAnchor),
    text,
    resolved: resolved === 1,
  }));
}

export class ReviewNotesStore {
  private readonly filename: string;
  private initialized: Promise<void> | undefined;

  constructor(directory: string) {
    this.filename = path.join(directory, 'notes.sqlite');
  }

  async list(root: string, scope: string): Promise<ReviewNote[]> {
    const relative = relativeScope(root, scope);
    await this.initialize();
    return this.withDatabase(database => readNotes(database, root, relative));
  }

  async change(root: string, scope: string, input: unknown): Promise<ReviewNote[]> {
    const relative = relativeScope(root, scope);
    const change = parseChange(input);
    if (
      change.type === 'add' &&
      change.anchor &&
      relative &&
      !change.anchor.path.startsWith(`${relative}/`)
    )
      throw new Error('The review note location is outside the open folder.');
    await this.initialize();
    return this.withDatabase(database => {
      database.exec('PRAGMA secure_delete = ON');
      database.exec('BEGIN IMMEDIATE');
      if (change.type === 'add') {
        const count = database
          .prepare('SELECT count(*) AS total FROM review_notes WHERE worktree = ?')
          .get(root)?.total as number;
        if (count >= MAX_NOTES)
          throw new Error(
            `This worktree has ${MAX_NOTES} review notes. Delete one to add another.`,
          );
        database
          .prepare(`INSERT INTO review_notes (id, worktree, project_scope, anchor_path, anchor, text)
            VALUES (?, ?, ?, ?, ?, ?)`)
          .run(
            randomUUID(),
            root,
            change.anchor ? null : relative,
            change.anchor?.path ?? null,
            change.anchor ? JSON.stringify(change.anchor) : null,
            change.text,
          );
      } else {
        // The same visibility rule applies to changes, even when a renderer already knows an ID.
        const result =
          change.type === 'edit'
            ? database
                .prepare(`UPDATE review_notes SET text = ?4
                  WHERE ${VISIBLE_NOTE} AND id = ?3 AND text = ?5`)
                .run(root, relative, change.id, change.text, change.expectedText)
            : change.type === 'resolve'
              ? database
                  .prepare(
                    `UPDATE review_notes SET resolved = ?4 WHERE ${VISIBLE_NOTE} AND id = ?3`,
                  )
                  .run(root, relative, change.id, Number(change.resolved))
              : database
                  .prepare(`DELETE FROM review_notes WHERE ${VISIBLE_NOTE} AND id = ?3`)
                  .run(root, relative, change.id);
        if (result.changes === 0) {
          const changed =
            change.type === 'edit' &&
            database
              .prepare(`SELECT 1 FROM review_notes WHERE ${VISIBLE_NOTE} AND id = ?3`)
              .get(root, relative, change.id);
          if (changed) throw new Error('This review note changed in another window.');
          throw new Error('This review note is no longer available here.');
        }
      }
      const notes = readNotes(database, root, relative);
      database.exec('COMMIT');
      return notes;
    });
  }

  private initialize() {
    this.initialized ??= this.createDatabase().catch(error => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  private async createDatabase() {
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    try {
      const file = await open(this.filename, 'wx', 0o600);
      await file.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await this.withDatabase(database => {
      database.exec('PRAGMA journal_mode = WAL');
      database.exec(`CREATE TABLE IF NOT EXISTS review_notes (
        sequence INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        worktree TEXT NOT NULL,
        project_scope TEXT,
        anchor_path TEXT,
        anchor TEXT,
        text TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS review_notes_worktree ON review_notes(worktree, sequence);`);
    });
  }

  private async withDatabase<T>(run: (database: DatabaseSync) => T): Promise<T> {
    const deadline = performance.now() + BUSY_WAIT_MS;
    for (;;) {
      try {
        const database = new DatabaseSync(this.filename);
        try {
          return run(database);
        } finally {
          // SQLite rolls back an unfinished transaction when the connection closes.
          database.close();
        }
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if (code === undefined || (code & 255) !== SQLITE_BUSY) throw error;
        if (performance.now() >= deadline)
          throw new Error('Review notes are busy in another Diffpane window. Try again.');
        await delay(20);
      }
    }
  }
}
