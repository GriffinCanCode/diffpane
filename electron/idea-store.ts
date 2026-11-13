import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import {
  MAX_IDEA_BODY_LENGTH,
  MAX_IDEA_EXCERPT_LENGTH,
  MAX_IDEA_LINKS,
  MAX_IDEA_TITLE_LENGTH,
  type Idea,
  type IdeaLink,
} from '../ideas.ts';

function ideaId(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value))
    throw new Error('The idea has an invalid ID.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
}

function readLink(value: unknown): IdeaLink {
  if (!isRecord(value)) throw new Error('The idea has an invalid file link.');
  const { path: filename, line, endLine, side, excerpt, truncated } = value;
  if (
    typeof filename !== 'string' ||
    !filename ||
    filename.length > 4096 ||
    filename.includes('\0') ||
    path.isAbsolute(filename) ||
    (path.sep === '\\' && /[\\:]/u.test(filename)) ||
    filename.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('Choose a file inside this repository to link to an idea.');
  }
  if (
    (line !== undefined && !isLine(line)) ||
    (endLine !== undefined && (!isLine(endLine) || !isLine(line) || endLine < line))
  )
    throw new Error('The idea has an invalid line range.');
  if (side !== undefined && side !== 'head' && side !== 'working')
    throw new Error('The idea has an invalid file side.');
  if (
    excerpt !== undefined &&
    (typeof excerpt !== 'string' || excerpt.length > MAX_IDEA_EXCERPT_LENGTH)
  )
    throw new Error('The idea has an invalid code excerpt.');
  if (truncated !== undefined && typeof truncated !== 'boolean')
    throw new Error('The idea has an invalid code excerpt.');
  return {
    path: filename,
    ...(line === undefined ? {} : { line }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(side === undefined ? {} : { side }),
    ...(excerpt === undefined ? {} : { excerpt }),
    ...(truncated === undefined ? {} : { truncated }),
  };
}

function readIdea(value: unknown): Idea {
  if (!isRecord(value)) throw new Error('The idea could not be saved.');
  const { id, title, body, links, createdAt, updatedAt } = value;
  if (typeof title !== 'string' || title.length > MAX_IDEA_TITLE_LENGTH)
    throw new Error(`Idea titles can be up to ${MAX_IDEA_TITLE_LENGTH} characters.`);
  if (typeof body !== 'string' || body.length > MAX_IDEA_BODY_LENGTH)
    throw new Error(`Idea notes can be up to ${MAX_IDEA_BODY_LENGTH} characters.`);
  if (!Array.isArray(links) || links.length > MAX_IDEA_LINKS)
    throw new Error(`An idea can have up to ${MAX_IDEA_LINKS} links.`);
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt) || updatedAt < createdAt)
    throw new Error('The idea has an invalid timestamp.');
  return { id: ideaId(id), title, body, links: Array.from(links, readLink), createdAt, updatedAt };
}

function ideaFromRow(row: Record<string, SQLOutputValue>): Idea {
  return {
    id: row.id as string,
    title: row.title as string,
    body: row.body as string,
    links: JSON.parse(row.links as string) as IdeaLink[],
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export class IdeaStore {
  #database;
  #list;
  #upsert;
  #delete;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    closeSync(openSync(filename, 'a', 0o600));
    const database = new DatabaseSync(filename);
    try {
      database.exec(`
        PRAGMA busy_timeout = 1000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS ideas (
          workspace TEXT NOT NULL,
          id TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          links TEXT NOT NULL CHECK (json_valid(links)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
          PRIMARY KEY (workspace, id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS ideas_workspace_updated ON ideas (workspace, updated_at DESC, id);
      `);
      this.#list = database.prepare(`
        SELECT id, title, body, links, created_at, updated_at
        FROM ideas WHERE workspace = ? ORDER BY updated_at DESC, id
      `);
      this.#upsert = database.prepare(`
        INSERT INTO ideas (workspace, id, title, body, links, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace, id) DO UPDATE SET
          title = excluded.title,
          body = excluded.body,
          links = excluded.links,
          updated_at = max(ideas.created_at, excluded.updated_at)
        RETURNING id, title, body, links, created_at, updated_at
      `);
      this.#delete = database.prepare('DELETE FROM ideas WHERE workspace = ? AND id = ?');
      this.#database = database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  list(workspace: string) {
    return this.#list.all(workspace).map(ideaFromRow);
  }

  upsert(workspace: string, value: unknown) {
    const { id, title, body, links, createdAt, updatedAt } = readIdea(value);
    const row = this.#upsert.get(
      workspace,
      id,
      title,
      body,
      JSON.stringify(links),
      createdAt,
      updatedAt,
    );
    if (!row) throw new Error('The idea could not be saved.');
    return ideaFromRow(row);
  }

  delete(workspace: string, id: unknown) {
    return this.#delete.run(workspace, ideaId(id)).changes > 0;
  }

  close() {
    this.#database.close();
  }
}
