import { appError } from '../../../shared/recovery/app-errors.ts'

const API = 'https://api.anthropic.com/v1'
const MODEL = 'claude-haiku-5-5'
const API_VERSION = '2026-10-21'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

const API_ERRORS = new Map([
  [401, 'Claude rejected the API key. Check it in Creature settings.'],
  [402, 'Claude reported a billing issue. Check billing in the Claude Console.'],
  [403, 'This API key cannot access Claude Haiku. Check its workspace permissions.'],
  [404, 'Claude Haiku is unavailable for this API key.'],
  [413, 'This conversation is too large. Start a new chat and try again.'],
  [429, 'Claude reached a rate or spend limit. Check limits in the Claude Console.'],
  [504, 'Claude took too long to respond. Try again.'],
])

/** @typedef {{ type: 'text', text: string }} ClaudeTextBlock */
/** @typedef {{ type: 'tool_use', id: string, name: string, input: Record<string, unknown> }} ClaudeToolUse */
/** @typedef {{ type: 'tool_result', tool_use_id: string, content: string, is_error?: true }} ClaudeToolResult */
/** @typedef {{ role: 'user' | 'assistant', content: string | ReadonlyArray<Record<string, unknown>> }} ClaudeMessage */
/** @typedef {{ name: string, description: string, input_schema: Record<string, unknown> }} ClaudeTool */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {AbortSignal | undefined} signal @param {AbortSignal} timeout @param {string} fallback */
function requestFailure(signal, timeout, fallback) {
  if (signal?.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError')
    return appError('Claude took too long to respond. Try again.', { code: 'ETIMEDOUT' })
  if (signal?.aborted) return appError('Request canceled.', { code: 'ABORT_ERR' })
  if (timeout.aborted) return appError('Claude took too long to respond. Try again.', { code: 'ETIMEDOUT' })
  return new Error(fallback)
}

/**
 * @param {string} endpoint
 * @param {string} key
 * @param {Pick<RequestInit, 'method' | 'body'>} options
 * @param {AbortSignal | undefined} signal
 * @param {AbortSignal} timeout
 * @param {boolean} [streaming]
 */
async function request(endpoint, key, options, signal, timeout, streaming = false) {
  const headers = new Headers({
    authorization: `Bearer ${key}`,
    'anthropic-version': API_VERSION,
    accept: streaming ? 'text/event-stream' : 'application/json',
  })
  if (options.body) headers.set('content-type', 'application/json')

  let response
  try {
    response = await fetch(`${API}${endpoint}`, {
      ...options,
      headers,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch {
    throw requestFailure(signal, timeout, 'Could not connect to Claude. Check your connection.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    const message = API_ERRORS.get(response.status)
    if (message) {
      if (response.status === 504) throw appError(message, { code: 'ETIMEDOUT' })
      throw new Error(message)
    }
    if (response.status >= 500) throw new Error('Claude is temporarily unavailable. Try again.')
    if (response.status === 400 && options.method === 'GET') {
      throw new Error('Claude could not verify this key. Use a key scoped to one Claude workspace.')
    }
    throw new Error(`Claude rejected the request (HTTP ${response.status}).`)
  }
  return response
}

/**
 * @param {Response} response
 * @param {AbortSignal | undefined} signal
 * @param {AbortSignal} timeout
 * @returns {Promise<unknown>}
 */
async function responseJson(response, signal, timeout) {
  const reader = response.body?.getReader()
  if (!reader) throw invalidStream()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- The reader consumes response chunks in order.
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw invalidStream()
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } catch {
    throw requestFailure(signal, timeout, 'Claude returned an invalid response.')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** @param {string} key @param {AbortSignal} [signal] */
export async function verifyClaudeKey(key, signal) {
  const timeout = AbortSignal.timeout(15_000)
  const response = await request(`/models/${MODEL}`, key, { method: 'GET' }, signal, timeout)
  const result = await responseJson(response, signal, timeout)
  if (!isRecord(result) || result.type !== 'model' || typeof result.id !== 'string') {
    throw new Error('Claude returned an invalid response while verifying the key.')
  }
}

function invalidStream() {
  return new Error('Claude returned an incomplete or invalid response.')
}

/**
 * @param {Response} response
 * @param {AbortSignal} signal
 * @param {AbortSignal} timeout
 * @returns {AsyncGenerator<unknown, void, undefined>}
 */
async function* responseEvents(response, signal, timeout) {
  const reader = response.body?.getReader()
  if (!reader) throw invalidStream()
  const decoder = new TextDecoder()
  let buffer = ''
  let received = 0
  /** @type {string[]} */
  let data = []
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- The reader consumes response chunks in order.
      const { done, value } = await reader.read().catch(() => {
        throw requestFailure(signal, timeout, 'Claude’s response was interrupted. Try again.')
      })
      if (done) break
      received += value.byteLength
      if (received > MAX_RESPONSE_BYTES) throw invalidStream()
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, '')
        buffer = buffer.slice(newline + 1)
        if (!line && data.length) {
          /** @type {unknown} */
          let event
          try {
            event = JSON.parse(data.join('\n'))
          } catch {
            throw invalidStream()
          }
          data = []
          yield event
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /u, ''))
        }
        newline = buffer.indexOf('\n')
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** @param {unknown} value */
function readMessage(value) {
  if (!isRecord(value) || !Array.isArray(value.content) || typeof value.stop_reason !== 'string') throw invalidStream()
  /** @type {ClaudeTextBlock[]} */
  const text = []
  /** @type {ClaudeToolUse[]} */
  const calls = []
  /** @type {Record<string, unknown>[]} */
  const content = []
  /** @type {unknown[]} */
  const blocks = value.content
  for (const block of blocks) {
    if (!isRecord(block) || typeof block.type !== 'string') throw invalidStream()
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw invalidStream()
      text.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !isRecord(block.input))
        throw invalidStream()
      calls.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
    }
    content.push(block)
  }
  return { content, text, calls, stopReason: value.stop_reason }
}

/**
 * @param {Response} response
 * @param {(text: string) => void} onText
 * @param {AbortSignal} signal
 * @param {AbortSignal} timeout
 */
async function responseMessage(response, onText, signal, timeout) {
  /** @type {Record<string, unknown>[]} */
  const content = []
  /** @type {{index: number, input: string} | undefined} */
  let openBlock
  /** @type {string | undefined} */
  let stopReason
  /** @type {'awaiting-start' | 'content' | 'message-delta'} */
  let phase = 'awaiting-start'
  let hasText = false
  for await (const event of responseEvents(response, signal, timeout)) {
    if (!isRecord(event) || typeof event.type !== 'string') throw invalidStream()
    if (event.type === 'error') {
      const overload = isRecord(event.error) && event.error.type === 'overloaded_error'
      throw new Error(
        overload ? 'Claude is temporarily overloaded. Try again.' : 'Claude interrupted the response. Try again.',
      )
    }
    if (event.type === 'message_start') {
      if (phase !== 'awaiting-start') throw invalidStream()
      phase = 'content'
    } else if (event.type === 'content_block_start') {
      const { index, content_block: block } = event
      if (
        phase !== 'content' ||
        openBlock ||
        index !== content.length ||
        !isRecord(block) ||
        typeof block.type !== 'string'
      )
        throw invalidStream()
      content.push(block)
      openBlock = { index, input: '' }
      if (block.type === 'text') {
        if (typeof block.text !== 'string') throw invalidStream()
        if (hasText) onText('\n\n')
        hasText = true
        if (block.text) onText(block.text)
      }
    } else if (event.type === 'content_block_delta') {
      const { index, delta } = event
      if (!openBlock || index !== openBlock.index || !isRecord(delta)) throw invalidStream()
      const block = content[openBlock.index]
      if (!block) throw invalidStream()
      if (block.type === 'text' && delta.type === 'text_delta') {
        if (typeof block.text !== 'string' || typeof delta.text !== 'string') throw invalidStream()
        block.text += delta.text
        onText(delta.text)
      } else if (block.type === 'tool_use' && delta.type === 'input_json_delta') {
        if (typeof delta.partial_json !== 'string') throw invalidStream()
        openBlock.input += delta.partial_json
      }
    } else if (event.type === 'content_block_stop') {
      if (!openBlock || event.index !== openBlock.index) throw invalidStream()
      const { index, input } = openBlock
      const block = content[index]
      if (!block) throw invalidStream()
      if (block.type === 'tool_use' && input) {
        try {
          /** @type {unknown} */
          const parsed = JSON.parse(input)
          if (!isRecord(parsed)) throw invalidStream()
          block.input = parsed
        } catch {
          throw invalidStream()
        }
      }
      openBlock = undefined
    } else if (event.type === 'message_delta') {
      if (phase === 'awaiting-start' || openBlock || !isRecord(event.delta)) throw invalidStream()
      phase = 'message-delta'
      if (event.delta.stop_reason !== undefined && event.delta.stop_reason !== null) {
        if (typeof event.delta.stop_reason !== 'string') throw invalidStream()
        stopReason = event.delta.stop_reason
      }
    } else if (event.type === 'message_stop') {
      if (phase !== 'message-delta' || typeof stopReason !== 'string') throw invalidStream()
      return readMessage({ content, stop_reason: stopReason })
    }
  }
  throw invalidStream()
}

/**
 * @param {string} key
 * @param {{ system: string, messages: ClaudeMessage[], tools: ClaudeTool[] }} requestOptions
 * @param {AbortSignal} signal
 * @param {(text: string) => void} onText
 */
export async function requestClaude(key, { system, messages, tools }, signal, onText) {
  const timeout = AbortSignal.timeout(45_000)
  const response = await request(
    '/messages',
    key,
    {
      method: 'POST',
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        thinking: { type: 'disabled' },
        stream: true,
        system,
        messages,
        tools,
      }),
    },
    signal,
    timeout,
    true,
  )
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    return responseMessage(response, onText, signal, timeout)
  }
  return readMessage(await responseJson(response, signal, timeout))
}
