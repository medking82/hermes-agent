import type { ServerRequest } from '@hermes/shared'
import { expect, it, vi } from 'vitest'

import { MobileController } from './controller'

const snapshot = (id: string) => ({
  session_id: id,
  stored_session_id: id,
  messages: [],
  info: { title: id },
  running: false
})

function setup() {
  let emit: (e: unknown) => void = () => {}

  let close: (s: string) => void = () => {}

  let onRequest: (r: ServerRequest) => boolean | void = () => false

  const rpc = {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    onAny: (fn: typeof emit) => {
      emit = fn

      return () => {}
    },
    onState: (fn: typeof close) => {
      close = fn

      return () => {}
    },
    onRequest: (handler: typeof onRequest) => {
      onRequest = handler

      return () => {}
    },
    request: vi.fn(async (_m: string, p: Record<string, unknown>) => snapshot(String(p.session_id ?? 'new')))
  }

  const api = {
    socketUrl: vi.fn().mockResolvedValue('wss://example/api/ws?ticket=x'),
    request: vi.fn<(path: string) => Promise<unknown>>().mockResolvedValue({ sessions: [], total: 0 })
  }

  const controller = new MobileController(api as never, rpc as never)

  return {
    controller,
    rpc,
    api,
    emit: (e: unknown) => emit(e),
    close: (s: string) => close(s),
    request: (r: ServerRequest) => onRequest(r)
  }
}

it('stops pagination when a stale total returns an empty saved page', async () => {
  const { controller, api, rpc } = setup()
  rpc.request.mockResolvedValue({ sessions: [] } as never)

  try {
    api.request.mockResolvedValue({ sessions: [{ id: 'saved' }], total: 3 })
    await controller.loadSessions()
    expect(controller.getSnapshot().hasMoreSessions).toBe(true)
    api.request.mockResolvedValue({ sessions: [], total: 3 })
    await controller.loadSessions('', true)
    expect(api.request.mock.calls.at(-1)?.[0]).toContain('offset=1&')
    expect(controller.getSnapshot().hasMoreSessions).toBe(false)
    expect(controller.getSnapshot().sessions.map(row => row.id)).toEqual(['saved'])
  } finally {
    controller.dispose()
  }
})

it('deduplicates unsaved live rows by stored session key', async () => {
  const { controller, api, rpc } = setup()
  api.request.mockResolvedValue({ sessions: [], total: 0 })
  rpc.request.mockResolvedValue({
    sessions: [
      { id: 'backend-a', session_key: 'same', status: 'working' },
      { id: 'backend-b', session_key: 'same', status: 'waiting' }
    ]
  } as never)

  try {
    await controller.loadSessions()
    await controller.loadLiveSessions()
    expect(controller.getSnapshot().sessions).toHaveLength(1)
    expect(controller.getSnapshot().sessions[0]).toMatchObject({ id: 'same', live_status: 'waiting' })
  } finally {
    controller.dispose()
  }
})

it('keeps search rows isolated while clearing the query is pending or fails', async () => {
  const { controller, api, rpc } = setup()
  rpc.request.mockResolvedValue({ sessions: [{ id: 'b', session_key: 'unrelated', status: 'working' }] } as never)

  try {
    api.request.mockResolvedValue({ results: [{ session_id: 'match', title: 'needle', snippet: '' }] })
    await controller.loadSessions('needle')
    let reject!: (reason: Error) => void
    api.request.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    const pending = controller.loadSessions('')
    await controller.loadLiveSessions()
    expect(controller.getSnapshot().sessions.map(row => row.id)).toEqual(['match'])
    reject(new Error('offline'))
    await pending
    await controller.loadLiveSessions()
    expect(controller.getSnapshot().sessions.map(row => row.id)).toEqual(['match'])
    expect(controller.getSnapshot().listError).toBe('offline')
    api.request.mockResolvedValue({ sessions: [{ id: 'saved' }], total: 1 })
    await controller.loadSessions('')
    await controller.loadLiveSessions()
    expect(controller.getSnapshot().sessions.map(row => row.id)).toEqual(['saved', 'unrelated'])
  } finally {
    controller.dispose()
  }
})

it('refreshes active status once per connect wake and change even if saved loading fails', async () => {
  vi.useFakeTimers()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const { controller, api, rpc, emit } = setup()
  rpc.request.mockResolvedValue({ sessions: [] } as never)
  const calls = () => rpc.request.mock.calls.filter(([method]) => method === 'session.active_list').length

  try {
    await controller.connect()
    expect(calls()).toBe(1)
    await controller.wake()
    expect(calls()).toBe(2)
    emit({ type: 'sessions.changed', payload: {} })
    await vi.advanceTimersByTimeAsync(301)
    expect(calls()).toBe(3)
    api.request.mockRejectedValue(new Error('offline'))
    await controller.wake()
    expect(calls()).toBe(4)
  } finally {
    controller.dispose()
    visible.mockRestore()
    vi.useRealTimers()
  }
})

it('clears removed live markers and removes unsaved live-only rows', async () => {
  const { controller, api, rpc } = setup()
  api.request.mockResolvedValue({ sessions: [{ id: 'saved', title: 'Saved' }], total: 1 })
  rpc.request.mockResolvedValue({
    sessions: [
      { id: 'a', session_key: 'saved', status: 'working' },
      { id: 'b', session_key: 'ephemeral', status: 'working' }
    ]
  } as never)

  try {
    await controller.loadSessions()
    await controller.loadLiveSessions()
    expect(controller.getSnapshot().sessions.map(row => row.id)).toContain('ephemeral')
    rpc.request.mockResolvedValue({ sessions: [] } as never)
    await controller.loadLiveSessions()
    expect(controller.getSnapshot().sessions).toEqual([{ id: 'saved', title: 'Saved' }])
  } finally {
    controller.dispose()
  }
})

it('uses saved pagination offsets despite live-only rows', async () => {
  const { controller, api, rpc } = setup()
  api.request.mockResolvedValue({ sessions: [{ id: 'saved' }], total: 2 })
  rpc.request.mockResolvedValue({ sessions: [{ id: 'b', session_key: 'ephemeral', status: 'working' }] } as never)

  try {
    await controller.loadSessions()
    await controller.loadLiveSessions()
    api.request.mockResolvedValue({ sessions: [{ id: 'next' }], total: 2 })
    await controller.loadSessions('', true)
    expect(api.request.mock.calls.at(-1)?.[0]).toContain('offset=1&')
    expect(controller.getSnapshot().sessions.map(row => row.id)).toContain('next')
  } finally {
    controller.dispose()
  }
})

it('preserves real live markers when a saved page is appended', async () => {
  const { controller, api, rpc } = setup()
  rpc.request.mockResolvedValue({ sessions: [{ id: 'live-b', session_key: 'next', status: 'working' }] } as never)

  try {
    api.request.mockResolvedValue({ sessions: [{ id: 'saved' }], total: 2 })
    await controller.loadSessions()
    api.request.mockResolvedValue({ sessions: [{ id: 'next' }], total: 2 })
    await controller.loadSessions('', true)
    await controller.loadLiveSessions()
    expect(controller.getSnapshot().sessions.map(row => row.id)).toEqual(['saved', 'next'])
    expect(controller.getSnapshot().sessions[1].live_status).toBe('working')
    expect(controller.getSnapshot().hasMoreSessions).toBe(false)
  } finally {
    controller.dispose()
  }
})

it('does not add unrelated live-only rows to search results', async () => {
  const { controller, api, rpc } = setup()
  api.request.mockResolvedValue({ results: [{ session_id: 'match', title: 'needle', snippet: '' }] })
  rpc.request.mockResolvedValue({ sessions: [{ id: 'b', session_key: 'unrelated', status: 'working' }] } as never)

  try {
    await controller.loadSessions('needle')
    await controller.loadLiveSessions()
    expect(controller.getSnapshot().sessions.map(row => row.id)).toEqual(['match'])
    await controller.loadSessions()
    expect(api.request.mock.calls.at(-1)?.[0]).toContain('q=needle')
  } finally {
    controller.dispose()
  }
})

it('refreshes tasks from a saved Todo result without another session resume', async () => {
  vi.useFakeTimers()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const { controller, api, rpc } = setup()
  rpc.request.mockResolvedValueOnce({
    ...snapshot('saved'),
    todo_state: { revision: 1, todos: [{ id: 'a', content: '处理中', status: 'in_progress' }] }
  } as never)
  api.request.mockImplementation(async path =>
    path.includes('/messages?')
      ? {
          session_id: 'saved',
          messages: [
            {
              id: 1,
              role: 'tool',
              tool_name: 'todo_list',
              content: JSON.stringify({
                revision: 2,
                todos: [{ id: 'a', content: '已完成的工作', status: 'completed' }]
              })
            }
          ]
        }
      : { id: 'saved', message_count: 1, sessions: [], total: 0 }
  )

  try {
    await controller.connect()
    await controller.open('saved')
    await vi.advanceTimersByTimeAsync(3100)
    expect(controller.getSnapshot().conversation?.todos).toEqual([
      { id: 'a', content: '已完成的工作', status: 'completed' }
    ])
    expect(rpc.request.mock.calls.filter(([method]) => method === 'session.resume')).toHaveLength(1)
  } finally {
    controller.dispose()
    vi.useRealTimers()
    visible.mockRestore()
  }
})

it('merges real runtime statuses into saved rows and refreshes on sessions.changed', async () => {
  vi.useFakeTimers()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const { controller, api, rpc, emit } = setup()
  api.request.mockImplementation(async (...args: unknown[]) =>
    String(args[0]).startsWith('/api/sessions?')
      ? {
          sessions: [
            { id: 'saved-a', title: '甲', preview: 'p', last_active: 1 },
            { id: 'saved-b', title: '乙', last_active: 2 }
          ],
          total: 2
        }
      : { sessions: [], total: 0 }
  )
  rpc.request.mockImplementation(async (method: string) =>
    method === 'session.active_list'
      ? {
          sessions: [
            { id: 'live-a', session_key: 'saved-a', status: 'working', title: '甲' },
            { id: 'live-c', session_key: 'saved-c', status: 'waiting', title: '丙', preview: '未入库的在跑会话' }
          ]
        }
      : { session_id: 'x', stored_session_id: 'x', messages: [], info: {} }
  )

  try {
    await controller.connect()
    // A later saved-list refresh (search debounce, mount effect, sessions.changed) must
    // re-apply live statuses instead of silently dropping them.
    await vi.advanceTimersByTimeAsync(400)
    await vi.runAllTicks()
    const rows = controller.getSnapshot().sessions
    expect(rows.find(row => row.id === 'saved-a')?.live_status).toBe('working')
    expect(rows.find(row => row.id === 'saved-b')?.live_status).toBeUndefined()
    const extra = rows.find(row => row.id === 'saved-c')
    expect(extra?.live_status).toBe('waiting')
    expect(extra?.preview).toBe('未入库的在跑会话')
    const before = rpc.request.mock.calls.filter(call => call[0] === 'session.active_list').length
    emit({ type: 'sessions.changed', session_id: undefined, payload: {} })
    await vi.advanceTimersByTimeAsync(400)
    await vi.runAllTicks()
    expect(rpc.request.mock.calls.filter(call => call[0] === 'session.active_list').length).toBeGreaterThan(before)
    expect(
      api.request.mock.calls.filter(call => String(call[0]).startsWith('/api/sessions?')).length
    ).toBeGreaterThanOrEqual(2)
  } finally {
    controller.dispose()
    vi.useRealTimers()
    visible.mockRestore()
  }
})

it('picks up another process saved reply while visible without repeating resume or starting work', async () => {
  vi.useFakeTimers()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const { controller, api, rpc } = setup()
  api.request.mockImplementation(async (...args: unknown[]) =>
    String(args[0]).includes('/messages?')
      ? ({ session_id: 'saved', messages: [{ id: 100, role: 'assistant', content: 'SAVED_REMOTE_UPDATE' }] } as never)
      : { sessions: [], total: 0 }
  )

  try {
    await controller.connect()
    await controller.open('saved')
    await vi.advanceTimersByTimeAsync(3100)
    expect(controller.getSnapshot().conversation?.messages.map(message => message.text)).toContain(
      'SAVED_REMOTE_UPDATE'
    )
    expect(rpc.request.mock.calls.filter(([method]) => method === 'session.resume')).toHaveLength(1)
    expect(rpc.request.mock.calls.find(([method]) => method === 'session.resume')![1]).toMatchObject({
      lazy: true,
      inline_images: false
    })
  } finally {
    controller.dispose()
    vi.useRealTimers()
    visible.mockRestore()
  }
})

it('polls small metadata between bounded saved-page reads', async () => {
  vi.useFakeTimers()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const { controller, api } = setup()
  api.request.mockImplementation(async (...args: unknown[]) => {
    const path = String(args[0])

    if (path.includes('/messages?')) {
      return { session_id: 'saved', messages: [{ id: 100, role: 'assistant', content: 'same' }] } as never
    }

    if (path.includes('/saved?')) {
      return { id: 'saved', message_count: 1 } as never
    }

    return { sessions: [], total: 0 }
  })

  try {
    await controller.connect()
    await controller.open('saved')
    await vi.advanceTimersByTimeAsync(9100)
    expect(api.request.mock.calls.filter(args => String(args[0]).includes('/messages?'))).toHaveLength(1)
    expect(api.request.mock.calls.filter(args => String(args[0]).includes('/saved?'))).toHaveLength(3)
  } finally {
    controller.dispose()
    visible.mockRestore()
    vi.useRealTimers()
  }
})

it('does not approve a request with no visible command', async () => {
  const { controller, request } = setup()
  await controller.connect()
  const control = { id: 'blank', method: 'approval', params: { session_id: 'saved' }, respond: vi.fn(), fail: vi.fn() }
  request(control)
  controller.respond(control, { choice: 'once' })
  expect(control.respond).not.toHaveBeenCalled()
  controller.dispose()
})
it('invalidates old approval cards after socket loss', async () => {
  const { controller, request, close } = setup()
  await controller.connect()
  await controller.open('saved')

  const control = {
    id: 'reused',
    method: 'approval',
    params: { session_id: 'saved', command: 'pwd' },
    respond: vi.fn(),
    fail: vi.fn()
  }

  request(control)
  const shown = controller.getSnapshot().controls[0]
  close('closed')
  await controller.connect()
  controller.respond(shown, { choice: 'once' })
  expect(control.respond).not.toHaveBeenCalled()
  expect(controller.getSnapshot().controls).toHaveLength(0)
  controller.dispose()
})
it('retains pending controls across navigation and accepts explicitly labelled background requests', async () => {
  const { controller, request } = setup()
  await controller.connect()
  await controller.open('first')

  const control = {
    id: 'question',
    method: 'approval',
    params: { session_id: 'first', command: 'pwd' },
    respond: vi.fn(),
    fail: vi.fn()
  }

  expect(request(control)).toBe(true)
  await controller.open('second')
  expect(controller.getSnapshot().controls).toHaveLength(1)
  controller.respond(controller.getSnapshot().controls[0], { choice: 'once' })
  controller.respond(control, { choice: 'once' })
  expect(control.respond).toHaveBeenCalledTimes(1)
  controller.dispose()
})
it('recovers automatic reconnect when a wake cancels the pending timer', async () => {
  vi.useFakeTimers()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const { controller, close, rpc } = setup()

  try {
    await controller.connect()
    close('closed')
    await controller.connect()
    close('closed')
    await vi.advanceTimersByTimeAsync(1100)
    expect(rpc.connect).toHaveBeenCalledTimes(3)
  } finally {
    controller.dispose()
    vi.useRealTimers()
    visible.mockRestore()
  }
})
it('treats queued ACK status as held input, not an ordinary delivered turn', async () => {
  const { controller, rpc } = setup()
  await controller.connect()
  await controller.open('saved')
  rpc.request.mockResolvedValueOnce({ status: 'queued' } as never)
  await controller.send('held')
  expect(controller.getSnapshot().queued).toBe(1)
  expect(controller.getSnapshot().conversation?.messages.some(m => m.text === 'held')).toBe(false)
  controller.dispose()
})
it('does not depend on secure-context randomUUID for local UI keys', async () => {
  const uuid = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('unavailable')
  })

  const { controller } = setup()
  await controller.connect()
  await controller.open('saved')

  try {
    await controller.send('safe failure')
    expect(controller.getSnapshot().sending).toBe(false)
  } finally {
    uuid.mockRestore()
    controller.dispose()
  }
})
it('keeps a healthy connection when a history refresh fails', async () => {
  const { controller, rpc } = setup()
  await controller.connect()
  await controller.open('saved')
  rpc.request.mockRejectedValueOnce(new Error('session not found'))
  await controller.connect()
  expect(controller.getSnapshot().connection).toBe('ready')
  controller.dispose()
})
it('accepts the post-Attention gateway.ready and keeps a working connection', async () => {
  const { controller, rpc, emit } = setup()
  await controller.connect()
  emit({ type: 'gateway.ready', payload: { change_events: true, heartbeat: true, replay_epoch: 7 } })
  const sent = await controller.send('allowed after ready')
  expect(controller.getSnapshot().connection).toBe('ready')
  expect(sent).toBe(true)
  expect(rpc.request.mock.calls.filter(([method]) => method === 'prompt.submit').length).toBeGreaterThan(0)
  controller.dispose()
})
it('uses the dashboard submit contract without canonical-only identity fields', async () => {
  const { controller, rpc } = setup()
  await controller.connect()
  await controller.open('saved')
  await controller.send('legacy dashboard message')
  const submit = rpc.request.mock.calls.find(([method]) => method === 'prompt.submit')!
  expect(Object.keys(submit[1]).sort()).toEqual(['profile', 'queued', 'session_id', 'text'])
  controller.dispose()
})
it('does not resend an ambiguous submission when reconnecting', async () => {
  const { controller, rpc } = setup()
  await controller.connect()
  await controller.open('saved')
  rpc.request.mockRejectedValueOnce(new Error('connection lost'))
  await controller.send('one message')
  expect(controller.getSnapshot().uncertain).toBeTruthy()
  expect(await controller.send('do not duplicate')).toBe(false)
  await controller.connect()
  expect(rpc.request.mock.calls.filter(([m]) => m === 'prompt.submit')).toHaveLength(1)
  expect(controller.getSnapshot().uncertain).toBeTruthy()
  controller.dispose()
})
it('ignores stale history when the user opens a second session', async () => {
  const { controller, rpc } = setup()
  await controller.connect()
  let resolve!: (s: ReturnType<typeof snapshot>) => void
  rpc.request.mockImplementationOnce(
    () =>
      new Promise(r => {
        resolve = r
      })
  )
  const first = controller.open('first')
  await controller.open('second')
  resolve(snapshot('first'))
  await first
  expect(controller.getSnapshot().conversation?.storedId).toBe('second')
  controller.dispose()
})
it('disconnect preserves running state and does not interrupt work', async () => {
  const { controller, rpc, emit, close } = setup()
  await controller.connect()
  await controller.open('saved')
  emit({ type: 'message.start', session_id: 'saved', payload: {} })
  close('closed')
  expect(controller.getSnapshot().conversation?.running).toBe(true)
  expect(rpc.request.mock.calls.some(([m]) => m === 'session.interrupt')).toBe(false)
  controller.dispose()
})
it('places the user message before replies even when a submit ACK arrives late', async () => {
  const { controller, rpc, emit } = setup()
  await controller.connect()
  await controller.open('saved')
  let resolve!: (s: ReturnType<typeof snapshot>) => void
  rpc.request.mockImplementationOnce(
    () =>
      new Promise(r => {
        resolve = r
      })
  )
  const sent = controller.send('first')
  expect(await controller.send('duplicate')).toBe(false)
  emit({ type: 'message.delta', session_id: 'saved', payload: { text: 'answer' } })
  resolve(snapshot('saved'))
  await sent
  expect(controller.getSnapshot().conversation?.messages.map(m => m.role)).toEqual(['user', 'assistant'])
  controller.dispose()
})
it('does not leave another session disabled after navigating during send', async () => {
  const { controller, rpc } = setup()
  await controller.connect()
  await controller.open('first')
  let resolve!: (s: ReturnType<typeof snapshot>) => void
  rpc.request.mockImplementationOnce(
    () =>
      new Promise(r => {
        resolve = r
      })
  )
  const sent = controller.send('first')
  await controller.open('second')
  resolve(snapshot('first'))
  await sent
  expect(controller.getSnapshot().sending).toBe(false)
  expect(controller.getSnapshot().conversation?.storedId).toBe('second')
  controller.dispose()
})

it('does not let a disjoint saved-history refresh replace a newer live reply', async () => {
  vi.useFakeTimers()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const { controller, api, rpc, emit } = setup()
  let finish!: (value: ReturnType<typeof snapshot>) => void

  const pending = new Promise<ReturnType<typeof snapshot>>(resolve => {
    finish = resolve
  })

  let resumes = 0
  rpc.request.mockImplementation(async (method: string) => {
    if (method === 'session.active_list') {
      return { sessions: [] }
    }

    resumes += 1

    return resumes === 1
      ? ({ ...snapshot('saved'), messages: [{ role: 'user', content: 'old', _row_id: 1 }] } as never)
      : await pending
  })
  api.request.mockImplementation(async path =>
    path.includes('/messages?')
      ? {
          session_id: 'saved',
          messages: Array.from({ length: 120 }, (_, i) => ({ id: i + 100, role: 'assistant', content: 'saved' }))
        }
      : { message_count: 121 }
  )

  try {
    await controller.connect()
    await controller.open('saved')
    await vi.advanceTimersByTimeAsync(3100)
    expect(rpc.request.mock.calls.filter(([method]) => method === 'session.resume')).toHaveLength(2)
    emit({ type: 'message.delta', session_id: 'saved', payload: { text: 'LIVE_WHILE_REFRESH_PENDING' } })
    finish(snapshot('saved'))
    await vi.advanceTimersByTimeAsync(1)
    expect(
      controller
        .getSnapshot()
        .conversation?.messages.some(row => row.text === 'LIVE_WHILE_REFRESH_PENDING' && row.streaming)
    ).toBe(true)
  } finally {
    controller.dispose()
    visible.mockRestore()
    vi.useRealTimers()
  }
})

it('preserves a display-order prefix when saved row ids are not monotonic', async () => {
  vi.useFakeTimers()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const { controller, api, rpc } = setup()
  rpc.request.mockImplementation(async (method: string) =>
    method === 'session.resume'
      ? ({
          ...snapshot('saved'),
          messages: [
            { _row_id: 1, role: 'user', content: 'PREFIX_A' },
            { _row_id: 999, role: 'assistant', content: 'PREFIX_B' },
            { _row_id: 2, role: 'assistant', content: 'SHARED_BOUNDARY' }
          ]
        } as never)
      : method === 'session.active_list'
        ? { sessions: [] }
        : snapshot('saved')
  )
  api.request.mockImplementation(async path =>
    path.includes('/messages?')
      ? {
          session_id: 'saved',
          messages: Array.from({ length: 120 }, (_, i) => ({ id: i + 2, role: 'assistant', content: 'tail' }))
        }
      : { message_count: 122 }
  )

  try {
    await controller.connect()
    await controller.open('saved')
    await vi.advanceTimersByTimeAsync(3100)
    const rows = controller.getSnapshot().conversation!.messages
    expect(rows.map(row => row.id)).toEqual(['1', '999', ...Array.from({ length: 120 }, (_, i) => String(i + 2))])
    expect(rpc.request.mock.calls.filter(([method]) => method === 'session.resume')).toHaveLength(1)
  } finally {
    controller.dispose()
    visible.mockRestore()
    vi.useRealTimers()
  }
})

it.each([true, false])(
  'does not repeat full resumes for a hidden raw page boundary (visible overlap: %s)',
  async overlap => {
    vi.useFakeTimers()
    const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const { controller, api, rpc } = setup()
    rpc.request.mockResolvedValue({
      ...snapshot('saved'),
      messages: [
        { _row_id: 1, role: 'user', content: 'prefix' },
        { _row_id: 2, role: 'assistant', content: 'known' }
      ]
    } as never)
    api.request.mockImplementation(async path =>
      path.includes('/messages?')
        ? {
            session_id: 'saved',
            messages: Array.from({ length: 120 }, (_, i) => ({
              id: i === 1 && overlap ? 2 : i + 100,
              role: 'assistant',
              content: i === 1 && overlap ? 'known' : ''
            }))
          }
        : { message_count: 122 }
    )

    try {
      await controller.connect()
      await controller.open('saved')
      await vi.advanceTimersByTimeAsync(9100)
      expect(rpc.request.mock.calls.filter(([method]) => method === 'session.resume')).toHaveLength(overlap ? 1 : 2)
      expect(controller.getSnapshot().conversation!.messages.map(row => row.id)).toEqual(['1', '2'])
    } finally {
      controller.dispose()
      visible.mockRestore()
      vi.useRealTimers()
    }
  }
)

it('treats a shorter complete saved page as authoritative instead of retaining removed prefix rows', async () => {
  vi.useFakeTimers()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const { controller, api, rpc } = setup()
  rpc.request.mockResolvedValueOnce({
    ...snapshot('saved'),
    messages: [
      { _row_id: 1, role: 'assistant', content: 'old generation' },
      { _row_id: 2, role: 'assistant', content: 'kept' }
    ]
  } as never)
  api.request.mockImplementation(async path =>
    path.includes('/messages?')
      ? {
          session_id: 'saved',
          messages: [
            { id: 2, role: 'assistant', content: 'kept' },
            { id: 3, role: 'assistant', content: 'new' }
          ]
        }
      : { message_count: 2 }
  )

  try {
    await controller.connect()
    await controller.open('saved')
    await vi.advanceTimersByTimeAsync(3100)
    expect(controller.getSnapshot().conversation!.messages.map(row => row.id)).toEqual(['2', '3'])
  } finally {
    controller.dispose()
    visible.mockRestore()
    vi.useRealTimers()
  }
})
