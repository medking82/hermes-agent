import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { MobileApp } from './app'
import { MobileController } from './controller'
import { setWebLocale } from './localization'
beforeEach(() => setWebLocale('zh'))
afterEach(() => {
  cleanup()
  localStorage.clear()
})

function setup() {
  const api = {
    socketUrl: vi.fn().mockResolvedValue('wss://example/api/ws'),
    request: vi.fn().mockResolvedValue({ sessions: [], total: 0 })
  }

  const rpc = {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    onAny: () => () => {},
    onState: () => () => {},
    onRequest: () => () => {},
    request: vi.fn(async (_method: string, params: Record<string, unknown>) => ({
      session_id: String(params.session_id ?? 'created'),
      stored_session_id: String(params.session_id ?? 'created'),
      messages: [],
      info: {}
    }))
  }

  const controller = new MobileController(api as never, rpc as never)
  render(<MobileApp controller={controller} />)

  return { controller, rpc, api }
}

it('labels saved-history updates honestly instead of promising a desktop token mirror', async () => {
  const { controller } = setup()
  await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
  await act(async () => {
    await controller.open('saved')
  })
  expect(screen.getByText('跨端同步已保存消息；不镜像逐字输出。')).toBeTruthy()
  controller.dispose()
})

it('retains the draft while changing the UI language and direction', async () => {
  const { controller } = setup()
  fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '保留中文草稿' } })
  fireEvent.click(screen.getByRole('button', { name: '外观设置' }))
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } })
  expect(window.document.documentElement.lang).toBe('en')
  expect(screen.getByRole('dialog', { name: 'Appearance' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ar' } })
  expect(window.document.documentElement.dir).toBe('rtl')
  fireEvent.change(screen.getByLabelText(/اللغة/u), { target: { value: 'en' } })
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('保留中文草稿')
  controller.dispose()
})
it('offers local Desktop appearance settings and restores the saved choice', async () => {
  const { controller } = setup()
  fireEvent.click(screen.getByRole('button', { name: '外观设置' }))
  const dialog = screen.getByRole('dialog', { name: '外观' })
  expect(dialog.textContent).toContain('不会修改 Windows Desktop 设置')
  fireEvent.click(screen.getByRole('radio', { name: 'Nous' }))
  fireEvent.mouseDown(screen.getByRole('tab', { name: '玻璃与底纹' }), { button: 0 })
  fireEvent.click(screen.getByLabelText('透明面板与背景层次'))
  fireEvent.change(screen.getByLabelText('面板不透明度'), { target: { value: '95' } })
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem('hermes-web:visual:v2')!)).toEqual({
      skin: 'nous',
      glass: true,
      opacity: 95,
      backdrop: true,
      backdropStrength: 2.5,
      blur: 12,
      font: '',
      uiTextScale: 100,
      chatTextScale: 100
    })
  )
  controller.dispose()
})
it('does not send on soft-keyboard Enter or composition confirmation', async () => {
  const { controller, rpc } = setup()
  await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
  const input = screen.getByRole('textbox', { name: '消息' })
  fireEvent.change(input, { target: { value: '中文输入' } })
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
  fireEvent.compositionStart(input)
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, metaKey: true })
  fireEvent.compositionEnd(input)
  expect(rpc.request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await waitFor(() =>
    expect(rpc.request).toHaveBeenCalledWith('prompt.submit', expect.objectContaining({ text: '中文输入' }), 1800000)
  )
  controller.dispose()
})
it('preserves unsent draft across remounts', async () => {
  const { controller } = setup()
  const input = screen.getByRole('textbox', { name: '消息' })
  fireEvent.change(input, { target: { value: '还没发送的草稿' } })
  cleanup()
  controller.dispose()
  const second = setup()
  expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('还没发送的草稿')
  second.controller.dispose()
})
it('does not turn assistant Markdown images into automatic external requests', async () => {
  const { controller, rpc } = setup()
  await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
  rpc.request.mockResolvedValueOnce({
    session_id: 'saved',
    stored_session_id: 'saved',
    messages: [{ role: 'assistant', content: '![external](https://example.invalid/test.png)' }],
    info: {}
  } as never)
  await act(async () => {
    await controller.open('saved')
  })
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByText('外部图片未自动载入')).toBeTruthy()
  controller.dispose()
})
it('preserves the first prompt in the composer if submit fails after session creation', async () => {
  const { controller, rpc } = setup()
  await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
  rpc.request
    .mockResolvedValueOnce({ session_id: 'created', stored_session_id: 'created', messages: [], info: {} })
    .mockRejectedValueOnce(new Error('lost ACK'))
  const input = screen.getByRole('textbox', { name: '消息' })
  fireEvent.change(input, { target: { value: 'first unsent prompt' } })
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await waitFor(() => expect(controller.getSnapshot().uncertain).toBeTruthy())
  expect((input as HTMLTextAreaElement).value).toBe('first unsent prompt')
  controller.dispose()
})
it('keeps a newer draft persisted when the previous send ACK arrives', async () => {
  const { controller, rpc } = setup()
  await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
  await act(async () => {
    await controller.open('saved')
  })
  let resolve!: (v: never) => void
  rpc.request.mockImplementationOnce(
    () =>
      new Promise(r => {
        resolve = r
      })
  )
  const input = screen.getByRole('textbox', { name: '消息' })
  fireEvent.change(input, { target: { value: 'old' } })
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  fireEvent.change(input, { target: { value: 'new unsent' } })
  await act(async () => {
    resolve({} as never)
  })
  expect(localStorage.getItem('hermes-web:draft:["default","saved"]')).toBe('new unsent')
  controller.dispose()
})
it('does not clear a different conversation draft when an old send is acknowledged', async () => {
  const { controller, rpc } = setup()
  await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
  await act(async () => {
    await controller.open('first')
  })
  let resolve!: (value: never) => void
  rpc.request.mockImplementationOnce(
    () =>
      new Promise(r => {
        resolve = r
      })
  )
  const input = screen.getByRole('textbox', { name: '消息' })
  fireEvent.change(input, { target: { value: 'send first' } })
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await act(async () => {
    await controller.open('second')
  })
  fireEvent.change(input, { target: { value: 'second unsent draft' } })
  await act(async () => {
    resolve({} as never)
  })
  expect((input as HTMLTextAreaElement).value).toBe('second unsent draft')
  controller.dispose()
})

it('existing visibility lifecycle resumes saved polling when the browser returns', async () => {
  let hidden = false
  const visible = vi.spyOn(window.document, 'hidden', 'get').mockImplementation(() => hidden)
  const { controller, rpc, api } = setup()

  try {
    await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
    api.request.mockImplementation(async (path: string) =>
      path.includes('/messages?')
        ? { session_id: 'saved', messages: [{ id: 1, role: 'assistant', content: 'VISIBLE_SAVED_REPLY' }] }
        : path.includes('/saved?')
          ? { message_count: 1 }
          : { sessions: [], total: 0 }
    )
    vi.useFakeTimers()
    await act(async () => {
      await controller.open('saved')
    })
    hidden = true
    await act(async () => {
      window.document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(3100)
    })
    expect(api.request.mock.calls.filter(args => String(args[0]).includes('/saved?'))).toHaveLength(0)
    hidden = false
    await act(async () => {
      window.document.dispatchEvent(new Event('visibilitychange'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100)
    })
    expect(screen.getByText('VISIBLE_SAVED_REPLY')).toBeTruthy()
    expect(rpc.request.mock.calls.every(args => args[0] === 'session.resume')).toBe(true)
  } finally {
    controller.dispose()
    visible.mockRestore()
    vi.useRealTimers()
  }
})
