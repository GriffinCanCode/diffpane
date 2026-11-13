import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { appendFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DiagnosticEvent } from '../../../shared/diagnostics/diagnostics.ts'

interface RecordContext {
  windowId?: number
}

interface LogOptions {
  appVersion: string
  maxFileBytes?: number
}

const FLUSH_INTERVAL = 500
const MAX_PENDING = 512
const MAX_ARCHIVED_FILES = 8
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const LOG_NAME = /^diffpane-(\d+)-[a-f0-9-]+(?:\.(?:previous|fatal))?\.jsonl$/

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
  }
}

async function pruneLogs(directory: string): Promise<void> {
  const names = await readdir(directory)
  const archived = await Promise.all(
    names.flatMap(name => {
      const pid = Number(LOG_NAME.exec(name)?.[1])
      if (!Number.isSafeInteger(pid) || pid <= 0 || processExists(pid)) return []
      const filename = path.join(directory, name)
      return stat(filename).then(
        info => (info.isFile() ? [{ filename, time: info.mtimeMs }] : []),
        () => [],
      )
    }),
  )
  const cutoff = Date.now() - MAX_AGE_MS
  await Promise.all(
    archived
      .flat()
      .toSorted((left, right) => right.time - left.time)
      .filter((file, index) => file.time < cutoff || index >= MAX_ARCHIVED_FILES)
      .map(file => rm(file.filename, { force: true })),
  )
}

export function createDiagnosticLog(directory: string, { appVersion, maxFileBytes = 2 * 1024 * 1024 }: LogOptions) {
  const name = `diffpane-${process.pid}-${randomUUID()}`
  const filename = path.join(directory, `${name}.jsonl`)
  const previous = path.join(directory, `${name}.previous.jsonl`)
  const queue: { line: string; important: boolean }[] = []
  let pending: Promise<void> | undefined
  let timer: NodeJS.Timeout | undefined
  let bytes = 0
  let dropped = 0
  let ready = false
  let warned = false
  let closed = false

  function line(event: DiagnosticEvent, context?: RecordContext): string {
    return `${JSON.stringify({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      appVersion,
      ...event,
      ...context,
    })}\n`
  }

  function warn(): void {
    if (warned) return
    warned = true
    console.warn('Diffpane could not write its local diagnostic log.')
  }

  async function write(batch: string): Promise<void> {
    if (!ready) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      ready = true
      await pruneLogs(directory).catch(warn)
    }
    const size = Buffer.byteLength(batch)
    if (bytes > 0 && bytes + size > maxFileBytes) {
      await rm(previous, { force: true })
      await rename(filename, previous)
      bytes = 0
    }
    await appendFile(filename, batch, { mode: 0o600 })
    bytes += size
  }

  function schedule(): void {
    if (timer || pending || closed || !queue.length) return
    timer = setTimeout(() => {
      timer = undefined
      flush().catch(warn)
    }, FLUSH_INTERVAL)
    timer.unref()
  }

  function flush(): Promise<void> {
    if (pending) return pending
    if (!queue.length) return Promise.resolve()
    const batch = queue.splice(0).map(entry => entry.line)
    if (dropped) {
      batch.push(
        line({
          source: 'main',
          kind: 'metric',
          level: 'info',
          operation: 'diagnostic-events-dropped',
          value: dropped,
          unit: 'count',
        }),
      )
      dropped = 0
    }
    pending = write(batch.join(''))
      .catch(warn)
      .finally(() => {
        pending = undefined
        schedule()
      })
    return pending
  }

  return {
    flush,
    record(event: DiagnosticEvent, context?: RecordContext): void {
      if (closed) return
      const important = event.level !== 'info'
      if (queue.length >= MAX_PENDING) {
        dropped++
        const index = important ? queue.findIndex(entry => !entry.important) : -1
        if (index < 0) return
        queue.splice(index, 1)
      }
      queue.push({ line: line(event, context), important })
      schedule()
    },
    recordFatal(event: DiagnosticEvent): void {
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        appendFileSync(path.join(directory, `${name}.fatal.jsonl`), line(event), { mode: 0o600 })
      } catch {
        warn()
      }
    },
    async close(): Promise<void> {
      closed = true
      clearTimeout(timer)
      timer = undefined
      await pending
      await flush()
    },
  }
}
