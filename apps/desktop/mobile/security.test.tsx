import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { MobileApp } from './app'
import { MobileController } from './controller'
import { setWebLocale } from './localization'

class Wire {
  static latest: Wire
  readyState = 1
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = 3
  })
  constructor() {
    Wire.latest = this
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function setup() {
  setWebLocale('zh')
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal('WebSocket', Wire)

  const api = {
    socketUrl: vi.fn().mockResolvedValue('wss://fixture.invalid/api/plugins/neo-mobile-web/security/ws'),
    request: vi.fn(async (path: string) =>
      path.includes('/security/sessions')
        ? { sessions: [{ session_key: 'fixture-stored', title: '夹具任务' }] }
        : { sessions: [], total: 0 }
    )
  }

  const rpc = {
    connect: vi.fn(),
    close: vi.fn(),
    onAny: () => () => {},
    onState: () => () => {},
    onRequest: () => () => {},
    request: vi.fn().mockResolvedValue({ sessions: [] })
  }

  const controller = new MobileController(api as never, rpc as never)
  render(<MobileApp controller={controller} />)

  return { api, rpc, controller }
}

const snapshot = {
  type: 'snapshot',
  generation: 'fixture-generation',
  backend: 'Fixture Host / Desktop / 17:12.5',
  profile: 'default',
  session_key: 'fixture-stored',
  runtime_id: 'fixture-runtime',
  requests: [{ id: 'fixture-request', method: 'sudo', params: { session_id: 'fixture-runtime', command: 'sudo -v' } }]
}

async function openSecurity() {
  const state = setup()
  await waitFor(() => expect(state.controller.getSnapshot().connection).toBe('ready'))
  fireEvent.click(screen.getByRole('button', { name: '安全请求' }))
  fireEvent.click(await screen.findByRole('button', { name: /夹具任务/ }))
  await waitFor(() => expect(Wire.latest.onopen).toBeTruthy())
  const wire = Wire.latest
  act(() => wire.onopen?.())
  act(() => wire.onmessage?.({ data: JSON.stringify(snapshot) }))
  const input = screen.getByLabelText('sudo 密码') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'fixture-password-value' } })

  return { ...state, wire, input }
}

it('does not open a late ticket response after the security connection has timed out', async () => {
  const { api, controller } = setup()
  await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
  let resolve!: (url: string) => void
  api.socketUrl.mockReturnValueOnce(
    new Promise<string>(done => {
      resolve = done
    })
  )
  fireEvent.click(screen.getByRole('button', { name: '安全请求' }))
  const task = await screen.findByRole('button', { name: /夹具任务/ })
  const previousWire = Wire.latest
  vi.useFakeTimers()

  try {
    fireEvent.click(task)
    act(() => vi.advanceTimersByTime(15_001))
    await act(async () => resolve('wss://fixture.invalid/api/plugins/neo-mobile-web/security/ws'))
    expect(Wire.latest).toBe(previousWire)
  } finally {
    controller.dispose()
    vi.useRealTimers()
  }
})

it.each(['once', 'deny'])('sends only the explicit %s approval to the selected backend', async choice => {
  const { wire, controller } = await openSecurity()
  act(() =>
    wire.onmessage?.({
      data: JSON.stringify({
        ...snapshot,
        requests: [
          {
            id: 'fixture-approval',
            method: 'approval',
            params: { session_id: 'fixture-runtime', command: 'fixture-command', choices: ['once', 'deny'] }
          }
        ]
      })
    })
  )
  fireEvent.click(screen.getByRole('button', { name: choice === 'once' ? '仅允许这一次' : '拒绝' }))
  expect(JSON.parse(wire.send.mock.calls[1][0])).toEqual({
    generation: snapshot.generation,
    id: 'fixture-approval',
    result: { choice }
  })
  controller.dispose()
})

it('cancels authentication without sending the typed password', async () => {
  const { wire, input, controller } = await openSecurity()
  fireEvent.click(screen.getByRole('button', { name: '取消认证' }))
  expect(input.value).toBe('')
  expect(JSON.parse(wire.send.mock.calls[1][0]).result).toEqual({ value: '' })
  controller.dispose()
})

it('clears a half-open security connection instead of leaving a stale password card', async () => {
  const { wire, input, controller } = await openSecurity()
  vi.useFakeTimers()

  try {
    act(() => wire.onmessage?.({ data: JSON.stringify(snapshot) }))
    act(() => vi.advanceTimersByTime(15_001))
    expect(screen.queryByLabelText('sudo 密码')).toBeNull()
    expect(input.value).toBe('')
    expect(wire.send.mock.calls).toHaveLength(1)
  } finally {
    controller.dispose()
    vi.useRealTimers()
  }
})

it('withdraws a changed request instead of carrying password input into another command', async () => {
  const { wire, input, controller } = await openSecurity()
  act(() =>
    wire.onmessage?.({
      data: JSON.stringify({
        ...snapshot,
        requests: [
          { ...snapshot.requests[0], params: { ...snapshot.requests[0].params, command: 'sudo fixture-other' } }
        ]
      })
    })
  )
  expect(screen.queryByLabelText('sudo 密码')).toBeNull()
  expect(input.value).toBe('')
  expect(wire.send.mock.calls).toHaveLength(1)
  controller.dispose()
})

it.each(['close', 'pagehide', 'offline', 'cancel', 'epoch', 'disconnect', 'reselect'])(
  'clears unsubmitted input on %s without sending any response or reconnecting',
  async cause => {
    const { wire, input, controller } = await openSecurity()
    act(() => {
      if (cause === 'close') {
        fireEvent.click(screen.getByRole('button', { name: '关闭安全请求' }))
      }

      if (cause === 'reselect') {
        fireEvent.click(screen.getByRole('button', { name: '重新选择任务' }))
      }

      if (['pagehide', 'offline'].includes(cause)) {
        window.dispatchEvent(new Event(cause))
      }

      if (cause === 'cancel') {
        wire.onmessage?.({ data: JSON.stringify({ ...snapshot, requests: [] }) })
      }

      if (cause === 'epoch') {
        wire.onmessage?.({ data: JSON.stringify({ ...snapshot, generation: 'fixture-replacement' }) })
      }

      if (cause === 'disconnect') {
        wire.onclose?.()
      }
    })
    expect(screen.queryByLabelText('sudo 密码')).toBeNull()
    expect(input.value).toBe('')
    expect(wire.send.mock.calls).toHaveLength(1)
    expect(Wire.latest).toBe(wire)
    controller.dispose()
  }
)

it('offers phone security without resuming a task and sends masked input only to its native channel once', async () => {
  const { rpc, controller } = setup()
  await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
  fireEvent.click(screen.getByRole('button', { name: '安全请求' }))
  fireEvent.click(await screen.findByRole('button', { name: /夹具任务/ }))
  await waitFor(() => expect(Wire.latest).toBeTruthy())
  const wire = Wire.latest
  act(() => wire.onopen?.())
  expect(JSON.parse(wire.send.mock.calls[0][0])).toEqual({ session_key: 'fixture-stored' })
  act(() => wire.onmessage?.({ data: JSON.stringify(snapshot) }))
  expect(screen.getByText('sudo -v')).toBeTruthy()
  const input = screen.getByLabelText('sudo 密码') as HTMLInputElement
  expect(input.type).toBe('password')
  fireEvent.change(input, { target: { value: 'fixture-password-value' } })
  const submit = screen.getByRole('button', { name: '提交 sudo 密码' })
  fireEvent.click(submit)
  fireEvent.click(submit)
  expect(input.value).toBe('')
  expect(wire.send.mock.calls).toHaveLength(2)
  expect(JSON.parse(wire.send.mock.calls[1][0])).toEqual({
    generation: 'fixture-generation',
    id: 'fixture-request',
    result: { value: 'fixture-password-value' }
  })
  expect(JSON.stringify(localStorage)).not.toContain('fixture-password-value')
  expect(window.document.body.textContent).not.toContain('fixture-password-value')
  expect(
    rpc.request.mock.calls.some(([method]) =>
      ['session.resume', 'session.activate', 'prompt.submit', 'request.answer'].includes(method)
    )
  ).toBe(false)
  act(() => wire.onmessage?.({ data: JSON.stringify({ type: 'answer', id: 'fixture-request', status: 'ok' }) }))
  expect(await screen.findByText('原后端已接收；命令结果请查看任务。')).toBeTruthy()
  controller.dispose()
})
