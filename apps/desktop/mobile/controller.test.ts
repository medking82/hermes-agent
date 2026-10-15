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
    expect(rpc.request.mock.calls.map(([method]) => method)).toEqual(['session.resume'])
    expect(rpc.request.mock.calls[0][1]).toMatchObject({ lazy: true, inline_images: false })
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
it('refuses an unsupported authority transport instead of relabelling the client', async () => {
  const { controller, rpc, emit } = setup()
  await controller.connect()
  emit({ type: 'gateway.ready', payload: { session_authority: true } })
  await controller.send('must not submit')
  expect(controller.getSnapshot().connection).toBe('failed')
  expect(rpc.request).not.toHaveBeenCalled()
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

  rpc.request.mockResolvedValueOnce({
    ...snapshot('saved'),
    messages: [{ role: 'user', content: 'old', _row_id: 1 }]
  } as never)
  rpc.request.mockImplementationOnce(() => pending)
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
    expect(rpc.request).toHaveBeenCalledTimes(2)
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
  rpc.request.mockResolvedValueOnce({
    ...snapshot('saved'),
    messages: [
      { _row_id: 1, role: 'user', content: 'PREFIX_A' },
      { _row_id: 999, role: 'assistant', content: 'PREFIX_B' },
      { _row_id: 2, role: 'assistant', content: 'SHARED_BOUNDARY' }
    ]
  } as never)
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
    expect(rpc.request).toHaveBeenCalledTimes(1)
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
      expect(rpc.request).toHaveBeenCalledTimes(overlap ? 1 : 2)
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
