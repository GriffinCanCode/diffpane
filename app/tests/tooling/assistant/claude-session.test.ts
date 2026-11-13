import { expect, test, vi } from 'vite-plus/test'
import { ClaudeSession } from '../../../electron/tools/assistant/claude-session.mjs'
import type { ClaudeActivity, ClaudeWorkspace } from '../../../electron/tools/assistant/claude-session.mjs'
import { createDiagnostics } from '../../../shared/diagnostics/diagnostics.ts'
import type { DiagnosticEvent } from '../../../shared/diagnostics/diagnostics.ts'

const key = () => Promise.resolve('test-key')

function textBlock(index: number, ...parts: string[]) {
  return [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    ...parts.map(text => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })),
    { type: 'content_block_stop', index },
  ]
}

function toolBlock(index: number, id: string, name: string, ...parts: string[]) {
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
    ...parts.map(partial_json => ({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json },
    })),
    { type: 'content_block_stop', index },
  ]
}

function stream(stop_reason: 'tool_use' | 'end_turn', blocks: readonly { type: string }[]) {
  return eventStream([
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    ...blocks,
    { type: 'message_delta', delta: { stop_reason } },
    { type: 'message_stop' },
  ])
}

function eventStream(events: readonly ({ type: string } & Record<string, unknown>)[]) {
  const encoded = new TextEncoder().encode(
    events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''),
  )
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Split across event names, JSON, and UTF-8 bytes as a network stream can.
        for (let offset = 0; offset < encoded.length; offset += 13)
          controller.enqueue(encoded.subarray(offset, offset + 13))
        controller.close()
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

const emptyWorkspace = {
  list: async () => ({ paths: [], truncated: false }),
  read: async () => '',
  listIdeas: async () => [],
  readIdea: async () => undefined,
} satisfies ClaudeWorkspace

test('reset releases the active turn without letting the old completion unlock its replacement', async t => {
  const oldKey = Promise.withResolvers<string>()
  const newKey = Promise.withResolvers<string>()
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(stream('end_turn', textBlock(0, 'New reply')))
  t.onTestFinished(() => fetch.mockRestore())
  const session = new ClaudeSession()

  const first = session.send({ prompt: 'First' }, () => oldKey.promise, emptyWorkspace).catch((error: unknown) => error)
  session.reset()
  const second = session.send({ prompt: 'Second' }, () => newKey.promise, emptyWorkspace)
  oldKey.resolve('old-key')
  expect(await first).toMatchObject({ message: 'Request canceled.' })
  await expect(session.send({ prompt: 'Third' }, key, emptyWorkspace)).rejects.toThrow('The Creature is still working')
  newKey.resolve('new-key')

  expect(await second).toMatchObject({ text: 'New reply' })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]?.[1]?.body).not.toContain('First')
})

test('a stream cannot run tool calls from content arriving after the message delta', async t => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      eventStream([
        { type: 'message_start', message: { role: 'assistant', content: [] } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        ...toolBlock(0, 'file', 'read_file', '{"path":"file.txt"}'),
        { type: 'message_stop' },
      ]),
    )
  t.onTestFinished(() => fetch.mockRestore())
  const read = vi.fn<ClaudeWorkspace['read']>(emptyWorkspace.read)

  await expect(new ClaudeSession().send({ prompt: 'Read the file' }, key, { ...emptyWorkspace, read })).rejects.toThrow(
    'Claude returned an incomplete or invalid response',
  )
  expect(read).not.toHaveBeenCalled()
})

test('streams ordered activity and fetches attached workspace content only when the model asks for it', async t => {
  const source = ['Unselected line', 'Selected line α', 'Selected line β', 'Another unselected line'].join('\n')
  const idea = {
    id: 'next-step',
    title: 'Next step',
    body: 'Idea introduction\nOne Markdown task\nOther idea detail',
    links: [{ path: 'src/main.ts', line: 2, excerpt: 'Captured code' }],
    createdAt: 1,
    updatedAt: 2,
  }
  const read = vi.fn<ClaudeWorkspace['read']>(async () => source)
  const readIdea = vi.fn<ClaudeWorkspace['readIdea']>(async () => idea)
  const list = vi.fn<ClaudeWorkspace['list']>(async () => [])
  const workspace = { list, read, listIdeas: list, readIdea }
  const requests: string[] = []
  const inspectionsPerRequest: number[][] = []
  const responses = [
    stream('tool_use', [
      ...textBlock(0, 'I’ll check ', 'both references.'),
      ...toolBlock(1, 'file', 'read_file'),
      ...toolBlock(2, 'idea', 'read_idea', '{"start_line":', '2,"end_line":2}'),
    ]),
    stream('end_turn', textBlock(0, 'The two ', 'agree.')),
    stream('end_turn', textBlock(0, 'Yes.')),
  ]
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, request) => {
    const response = responses[requests.length]
    const body = request?.body
    if (typeof body !== 'string' || !response) throw new Error('Unexpected request')
    requests.push(body)
    inspectionsPerRequest.push([read.mock.calls.length, readIdea.mock.calls.length])
    return Promise.resolve(response)
  })
  t.onTestFinished(() => {
    fetch.mockRestore()
  })

  const diagnostics: DiagnosticEvent[] = []
  const session = new ClaudeSession(createDiagnostics('main', event => diagnostics.push(event)))
  const activity: ClaudeActivity[] = []
  const result = await session.send(
    {
      requestId: 'first',
      prompt: 'Does this selection agree with my idea?',
      fileContext: { path: 'src/main.ts', side: 'head', startLine: 2, endLine: 3 },
      ideaId: idea.id,
    },
    key,
    workspace,
    event => activity.push(event),
  )

  expect(result).toMatchObject({ step: 1, text: 'The two agree.' })
  expect(read).toHaveBeenCalledExactlyOnceWith('src/main.ts', 'head')
  expect(readIdea).toHaveBeenCalledExactlyOnceWith(idea.id)
  expect(list).not.toHaveBeenCalled()
  expect(
    activity.map(event => (event.type === 'text' ? [event.step, event.text] : [event.step, event.id, event.status])),
  ).toEqual([
    [0, 'I’ll check '],
    [0, 'both references.'],
    [0, 'file', 'running'],
    [0, 'file', 'done'],
    [0, 'idea', 'running'],
    [0, 'idea', 'done'],
    [1, 'The two '],
    [1, 'agree.'],
  ])
  expect(activity[3]).toMatchObject({ requestId: 'first', path: 'src/main.ts', side: 'head', startLine: 2, endLine: 3 })
  expect(diagnostics.map(event => event.operation)).toEqual([
    'assistant.first-response',
    'assistant.model.request',
    'assistant.tool.read-file',
    'assistant.tool.read-idea',
    'assistant.model.request',
  ])
  expect(JSON.stringify(diagnostics)).not.toMatch(/src\/main\.ts|Selected line|Does this selection|test-key/u)

  const [initial = '', continuation = ''] = requests
  expect(initial).toContain("You are The Creature. You live in the user's code and help them figure things out.")
  expect(initial).toContain('Speak like a friendly caveman')
  expect(initial).toContain('I am the creature.')
  expect(initial).toContain('src/main.ts')
  expect(initial).toContain(idea.id)
  expect(initial).not.toContain('Selected line α')
  expect(initial).not.toContain('One Markdown task')
  expect(continuation).toContain('Selected line α')
  expect(continuation).toContain('Selected line β')
  expect(continuation).toContain('One Markdown task')
  expect(continuation).not.toContain('Unselected line')
  expect(continuation).not.toContain('Other idea detail')
  expect(continuation).not.toContain('Captured code')

  await session.send({ prompt: 'Can we continue?' }, key, workspace)
  const next = requests[2] ?? ''
  expect(inspectionsPerRequest).toEqual([
    [0, 0],
    [1, 1],
    [1, 1],
  ])
  expect(next).toContain('The two agree.')
  expect(next).toContain('Can we continue?')
  expect(next).not.toContain('Selected line α')
  expect(next).not.toContain('One Markdown task')
  expect(next).not.toContain('tool_result')
})
