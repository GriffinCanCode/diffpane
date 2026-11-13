import { expect, test } from 'vite-plus/test'
import { AppError, appError, attempt, attemptAsync, serializeAppError } from '../../../shared/recovery/app-errors.ts'

test('synchronous and asynchronous boundaries return explicit outcomes', async () => {
  expect(attempt(() => false)).toEqual({ ok: true, value: false })
  await expect(attemptAsync(async () => undefined)).resolves.toEqual({ ok: true, value: undefined })
  const cause = new Error('Disk unavailable')
  for (const result of [
    attempt(
      () => {
        throw cause
      },
      { operation: 'Read file' },
    ),
    await attemptAsync(() => Promise.reject(cause), { operation: 'Read file' }),
    await attemptAsync(
      () => {
        throw cause
      },
      { operation: 'Read file' },
    ),
  ]) {
    expect(result).toMatchObject({
      ok: false,
      error: { operation: 'Read file', message: 'Disk unavailable', cause },
    })
  }
})

test('IPC failures retain their meaning without serializing local diagnostic data', () => {
  const source = Object.assign(new Error('The file changed on disk.'), {
    code: 'SAVE_CONFLICT',
    recoverable: false,
  })
  const normalized = appError(source, { operation: 'Save file' })
  expect(normalized).toBeInstanceOf(AppError)
  expect(appError(normalized)).toBe(normalized)
  const wire = structuredClone(serializeAppError(normalized))
  expect(wire).toEqual({
    message: 'The file changed on disk.',
    code: 'SAVE_CONFLICT',
    operation: 'Save file',
    recoverable: false,
  })
  expect(appError(wire)).toMatchObject(wire)
  expect(appError(new Error("Error invoking remote method 'save': Error: Write failed")).message).toBe('Write failed')
})

test('unreadable thrown values still return a failure', () => {
  const { proxy, revoke } = Proxy.revocable(new Error('Hidden message'), {})
  revoke()
  const result = attempt(
    () => {
      throw proxy
    },
    { message: 'Couldn’t read the file.' },
  )
  expect(result).toMatchObject({ ok: false, error: { message: 'Couldn’t read the file.', code: 'UNEXPECTED' } })
})
