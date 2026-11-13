import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

interface KeyProvider {
  wrap(key: string): Promise<Buffer>
  unwrap(blob: Buffer): Promise<string>
}

export interface StateRecords {
  get(collection: string, scope: string, id: string): unknown
  list(collection: string, scope: string): unknown[]
  put(collection: string, scope: string, id: string, value: unknown): void
  delete(collection: string, scope: string, id: string): boolean
}

const MAX_RECORD = 10 * 1024 * 1024
const KEY_CHECK = Buffer.from('DiffPane local state key check v1')
const NONCE_LENGTH = 12
const TAG_LENGTH = 16
const HEADER_LENGTH = 1 + NONCE_LENGTH + TAG_LENGTH
const SQLITE_BUSY = 5

function hasCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

function fileIdentity(filename: string, ignoreEmpty = false) {
  try {
    const file = lstatSync(filename, { bigint: true })
    if (!file.isFile()) throw new Error('A DiffPane storage path does not point to a regular file.')
    if (ignoreEmpty && file.size === 0n) return undefined
    return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}`
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw error
  }
}

function removeIfPresent(filename: string) {
  try {
    unlinkSync(filename)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
}

async function retryBusy<T>(run: () => T): Promise<T> {
  const deadline = performance.now() + 2_000
  for (;;) {
    try {
      return run()
    } catch (error) {
      if (
        !(error instanceof Error && 'errcode' in error && typeof error.errcode === 'number') ||
        (error.errcode & 255) !== SQLITE_BUSY
      )
        throw error
      if (performance.now() >= deadline)
        throw new Error('Local storage is busy in another DiffPane process. Try again.', { cause: error })
      // oxlint-disable-next-line eslint/no-await-in-loop -- Retry only after the preceding transaction releases its lock.
      await delay(20)
    }
  }
}

function transaction<T>(database: DatabaseSync, writable: boolean, run: () => T): T {
  database.exec(writable ? 'BEGIN IMMEDIATE' : 'BEGIN')
  try {
    const result = run()
    if (result instanceof Promise) {
      void result.catch(() => {})
      throw new Error('A local storage transaction must complete synchronously.')
    }
    database.exec('COMMIT')
    return result
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK')
    throw error
  }
}

class RecordCodec {
  private readonly encryptionKey: Buffer
  private readonly indexKey: Buffer

  constructor(key: Buffer) {
    this.encryptionKey = Buffer.from(hkdfSync('sha256', key, '', 'DiffPane state encryption v1', 32))
    this.indexKey = Buffer.from(hkdfSync('sha256', key, '', 'DiffPane state index v1', 32))
  }

  index(parts: string[]) {
    return createHmac('sha256', this.indexKey).update(JSON.stringify(parts)).digest()
  }

  seal(plain: Buffer, aad: Buffer, compress = true) {
    if (plain.length > MAX_RECORD) throw new Error('This item is too large to store locally.')
    const compressed =
      compress && plain.length >= 256
        ? zstdCompressSync(plain, { params: { [constants.ZSTD_c_compressionLevel]: 5 } })
        : plain
    const useCompression = compressed.length < plain.length
    const format = Buffer.from([useCompression ? 2 : 1])
    const nonce = randomBytes(NONCE_LENGTH)
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce)
    cipher.setAAD(Buffer.concat([aad, format]))
    const data = cipher.update(useCompression ? compressed : plain)
    const final = cipher.final()
    return Buffer.concat([format, nonce, cipher.getAuthTag(), data, final])
  }

  unseal(payload: unknown, aad: Buffer) {
    try {
      if (
        !(payload instanceof Uint8Array) ||
        payload.length < HEADER_LENGTH ||
        payload.length > MAX_RECORD + HEADER_LENGTH
      )
        throw new Error()
      const format = payload.subarray(0, 1)
      if (format[0] !== 1 && format[0] !== 2) throw new Error()
      const nonce = payload.subarray(1, 1 + NONCE_LENGTH)
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, nonce, { authTagLength: TAG_LENGTH })
      decipher.setAAD(Buffer.concat([aad, format]))
      decipher.setAuthTag(payload.subarray(1 + NONCE_LENGTH, HEADER_LENGTH))
      const plain = Buffer.concat([decipher.update(payload.subarray(HEADER_LENGTH)), decipher.final()])
      return format[0] === 2 ? zstdDecompressSync(plain, { maxOutputLength: MAX_RECORD }) : plain
    } catch {
      throw new Error('DiffPane could not verify an encrypted local record.')
    }
  }
}

class SqliteRecords {
  readonly select
  readonly selectScope
  readonly upsert
  readonly remove
  readonly database: DatabaseSync
  readonly codec: RecordCodec

  constructor(database: DatabaseSync, codec: RecordCodec) {
    this.database = database
    this.codec = codec
    this.select = database.prepare('SELECT payload FROM records WHERE collection = ? AND scope = ? AND id = ?')
    this.selectScope = database.prepare('SELECT id, payload FROM records WHERE collection = ? AND scope = ?')
    this.upsert = database.prepare(`INSERT INTO records (collection, scope, id, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT (collection, scope, id) DO UPDATE SET payload = excluded.payload`)
    this.remove = database.prepare('DELETE FROM records WHERE collection = ? AND scope = ? AND id = ?')
  }

  private decode(collection: string, scope: Buffer, id: Uint8Array, payload: unknown): unknown {
    const aad = Buffer.concat([Buffer.from(collection), scope, id])
    try {
      return JSON.parse(this.codec.unseal(payload, aad).toString('utf8'))
    } catch {
      throw new Error('DiffPane could not verify an encrypted local record.')
    }
  }

  run<T>(writable: boolean, use: (records: StateRecords) => T) {
    let active = true
    const check = (write = false) => {
      if (!active || (write && !writable)) throw new Error('The local storage transaction is unavailable.')
    }
    const index = (collection: string, scope: string, id: string) =>
      [this.codec.index(['scope', collection, scope]), this.codec.index(['id', collection, scope, id])] as const
    const records: StateRecords = {
      get: (collection, scope, id) => {
        check()
        const [bucket, item] = index(collection, scope, id)
        const row = this.select.get(collection, bucket, item)
        return row ? this.decode(collection, bucket, item, row.payload) : undefined
      },
      list: (collection, scope) => {
        check()
        const bucket = this.codec.index(['scope', collection, scope])
        return Array.from(this.selectScope.iterate(collection, bucket), ({ id, payload }) => {
          if (!(id instanceof Uint8Array) || id.length !== 32) throw new Error('Invalid local record ID.')
          return this.decode(collection, bucket, id, payload)
        })
      },
      put: (collection, scope, id, value) => {
        check(true)
        const [bucket, item] = index(collection, scope, id)
        const aad = Buffer.concat([Buffer.from(collection), bucket, item])
        const encoded = JSON.stringify(value)
        if (encoded === undefined) throw new Error('This local record has no JSON representation.')
        const data = Buffer.from(encoded)
        this.upsert.run(collection, bucket, item, this.codec.seal(data, aad))
      },
      delete: (collection, scope, id) => {
        check(true)
        return this.remove.run(collection, ...index(collection, scope, id)).changes > 0
      },
    }
    try {
      return transaction(this.database, writable, () => use(records))
    } finally {
      active = false
    }
  }
}

export class LocalState {
  private readonly filename: string
  private readonly keys: KeyProvider
  private opening?: Promise<SqliteRecords>
  private records?: SqliteRecords
  private closed = false

  constructor(filename: string, keys: KeyProvider) {
    this.filename = filename
    this.keys = keys
  }

  async read<T>(use: (records: StateRecords) => T) {
    return this.run(false, use)
  }

  async write<T>(use: (records: StateRecords) => T) {
    return this.run(true, use)
  }

  private async run<T>(writable: boolean, use: (records: StateRecords) => T) {
    if (this.closed) throw new Error('Local storage is closed.')
    this.opening ??= this.open().catch((error: unknown) => {
      this.opening = undefined
      throw error
    })
    const records = await this.opening
    return retryBusy(() => {
      if (this.closed) throw new Error('Local storage is closed.')
      return records.run(writable, use)
    })
  }

  async migrate(
    name: string,
    filename: string,
    importLegacy: (records: StateRecords, filename: string) => void,
    { sqlite = false } = {},
  ) {
    const suffixes = sqlite ? ['-wal', '-journal'] : []
    const identity = (suffix: string) => fileIdentity(filename + suffix, suffix === '-wal')
    const imported = await this.write(records => {
      const previous = records.get('migrations', '', name)
      if (previous !== undefined) {
        if (
          !Array.isArray(previous) ||
          previous.length !== suffixes.length + 1 ||
          !previous.every((value: unknown): value is string => typeof value === 'string')
        )
          throw new Error('The saved local storage migration marker is invalid.')
        return previous
      }
      const source = identity('')
      if (!source) return undefined
      const files = [source, ...suffixes.map(suffix => identity(suffix) ?? '')]
      const uninitialized = sqlite && lstatSync(filename).size === 0 && files.slice(1).every(value => value === '')
      if (!uninitialized) importLegacy(records, filename)
      if (['', ...suffixes].some((suffix, index) => (identity(suffix) ?? '') !== files[index]))
        throw new Error(
          'The previous DiffPane storage changed during migration. Close older DiffPane windows and try again.',
        )
      records.put('migrations', '', name, files)
      return files
    })
    if (!imported) return
    // A committed marker makes cleanup retryable without reimporting deleted records.
    for (const [index, suffix] of ['', ...suffixes].entries()) {
      const existing = identity(suffix)
      if (existing && existing !== imported[index])
        throw new Error(
          'The previous DiffPane storage changed during migration. Close older DiffPane windows and review the previous data file.',
        )
    }
    removeIfPresent(filename)
    for (const suffix of suffixes) removeIfPresent(filename + suffix)
    if (sqlite) removeIfPresent(`${filename}-shm`)
  }

  private async open() {
    mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    if (!fileIdentity(this.filename)) {
      try {
        closeSync(openSync(this.filename, 'wx', 0o600))
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error
      }
    }
    const database = new DatabaseSync(this.filename)
    try {
      await retryBusy(() => {
        database.exec('PRAGMA auto_vacuum = INCREMENTAL')
        database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;')
        database.exec(
          'PRAGMA wal_autocheckpoint = 128; PRAGMA journal_size_limit = 1048576; PRAGMA secure_delete = ON;',
        )
        const version = database.prepare('PRAGMA user_version').get()?.user_version
        if (version === 0) {
          transaction(database, true, () =>
            database.exec(`
            CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value BLOB NOT NULL) STRICT, WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS records (
              collection TEXT NOT NULL, scope BLOB NOT NULL, id BLOB NOT NULL, payload BLOB NOT NULL,
              PRIMARY KEY (collection, scope, id)
            ) STRICT, WITHOUT ROWID;
            PRAGMA user_version = 1;
          `),
          )
        } else if (version !== 1) throw new Error('This local storage was created by a different DiffPane version.')
      })
      const codec = await this.unlock(database)
      if (this.closed) throw new Error('Local storage is closed.')
      return (this.records = new SqliteRecords(database, codec))
    } catch (error) {
      try {
        database.close()
      } catch {
        // Preserve the failure to open or unlock this database.
      }
      throw error
    }
  }

  private async unlock(database: DatabaseSync) {
    const get = database.prepare('SELECT value FROM metadata WHERE name = ?')
    let wrapped: unknown = get.get('wrapped-key')?.value
    if (wrapped === undefined) {
      const candidate = randomBytes(32)
      let envelope: Buffer
      let check: Buffer
      try {
        envelope = await this.keys.wrap(candidate.toString('base64'))
        check = new RecordCodec(candidate).seal(KEY_CHECK, KEY_CHECK, false)
      } finally {
        candidate.fill(0)
      }
      wrapped = await retryBusy(() =>
        transaction(database, true, () => {
          const existing = get.get('wrapped-key')?.value
          if (existing !== undefined) return existing
          if (get.get('key-check') || database.prepare('SELECT 1 FROM records LIMIT 1').get())
            throw new Error('The encryption key for existing DiffPane records is missing.')
          const insert = database.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)')
          insert.run('wrapped-key', envelope)
          insert.run('key-check', check)
          return envelope
        }),
      )
    }
    if (!(wrapped instanceof Uint8Array) || wrapped.length === 0 || wrapped.length > 8192)
      throw new Error('The wrapped DiffPane encryption key is invalid.')
    const key = Buffer.from(await this.keys.unwrap(Buffer.from(wrapped)), 'base64')
    try {
      if (key.length !== 32) throw new Error('The DiffPane encryption key is invalid.')
      const codec = new RecordCodec(key)
      if (!codec.unseal(get.get('key-check')?.value, KEY_CHECK).equals(KEY_CHECK))
        throw new Error('DiffPane could not verify its local encryption key.')
      return codec
    } finally {
      key.fill(0)
    }
  }

  close() {
    this.closed = true
    const database = this.records?.database
    if (!database) return
    this.records = undefined
    try {
      database.exec('PRAGMA incremental_vacuum(256)')
    } finally {
      database.close()
    }
  }
}
