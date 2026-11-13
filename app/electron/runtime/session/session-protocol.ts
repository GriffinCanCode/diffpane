export interface SessionVersions {
  revision?: number
  catalogRevision?: number
  reviewVersion?: number
  checkpointId?: number
}

export interface SessionLaunch {
  directory: string
  versions?: SessionVersions
}

export interface SessionRequest {
  id: number
  method: string
  args: readonly unknown[]
}

interface InvalidSessionRequest {
  id: number
  failure: Error
}

export function isSessionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSessionRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function isLanguageRequestId(value: unknown): value is string | number {
  return (typeof value === 'string' && value.length > 0 && value.length <= 128) || isSessionRevision(value)
}

export function parseSessionLaunch(input: unknown): SessionLaunch {
  if (!isSessionRecord(input) || typeof input.directory !== 'string' || !input.directory) {
    throw new Error('Invalid workspace worker configuration')
  }
  if (input.versions === undefined) return { directory: input.directory }
  if (!isSessionRecord(input.versions)) throw new Error('Invalid workspace worker versions')
  const versions: SessionVersions = {}
  for (const key of ['revision', 'catalogRevision', 'reviewVersion', 'checkpointId'] as const) {
    const value = input.versions[key]
    if (value === undefined) continue
    if (!isSessionRevision(value)) throw new Error(`Invalid workspace worker ${key}`)
    versions[key] = value
  }
  return { directory: input.directory, versions }
}

export function parseSessionRequest(input: unknown): SessionRequest | InvalidSessionRequest | null {
  if (!isSessionRecord(input) || !isSessionRevision(input.id)) return null
  if (typeof input.method !== 'string' || (input.args !== undefined && !Array.isArray(input.args))) {
    return { id: input.id, failure: new Error('Invalid workspace request') }
  }
  return { id: input.id, method: input.method, args: input.args ?? [] }
}

export function sessionString(value: unknown, name: string) {
  if (typeof value !== 'string') throw new Error(`Invalid ${name}`)
  return value
}

export function sessionBoolean(value: unknown, name: string) {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${name}`)
  return value
}

export function parseLanguageOpen(input: unknown) {
  if (!isSessionRecord(input)) throw new Error('Invalid language document')
  const { path, language, languageId, text, version = 1 } = input
  if (!isSessionRevision(version) || version < 1) throw new Error('Invalid language document version')
  return {
    path: sessionString(path, 'language document path'),
    language: sessionString(language, 'language'),
    languageId: languageId === undefined ? undefined : sessionString(languageId, 'language ID'),
    text: sessionString(text, 'language document text'),
    version,
  }
}

export function parseLanguageRequest(input: unknown) {
  if (!isSessionRecord(input)) throw new Error('Invalid language request')
  const { path, language, method, params = {}, text, version, requestId } = input
  if (
    !isSessionRecord(params) ||
    (version !== undefined && (!isSessionRevision(version) || version < 1)) ||
    (requestId !== undefined && !isLanguageRequestId(requestId))
  ) {
    throw new Error('Invalid language request')
  }
  return {
    path: sessionString(path, 'language document path'),
    language: sessionString(language, 'language'),
    method: sessionString(method, 'language method'),
    params,
    text: text === undefined ? undefined : sessionString(text, 'language document text'),
    version,
    requestId,
    signal: undefined,
  }
}
