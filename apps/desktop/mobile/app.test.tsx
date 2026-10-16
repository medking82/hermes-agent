import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { MobileApp } from './app'
import { MobileController } from './controller'
import { draftKey } from './input'
import { setWebLocale } from './localization'
import { SessionImage } from './session-image'
import { ToolActivity } from './tool-activity'
// JSDOM has no layout/ResizeObserver; real resize/scroll behavior is covered in Playwright.
beforeEach(() => {
  setWebLocale('zh')
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
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

it('offers a same-tab Dashboard exit from a conversation and a new chat without starting work', async () => {
  const { controller, rpc } = setup()
  await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
  await act(async () => {
    await controller.open('saved')
  })
  const editor = screen.getByRole('textbox', { name: '消息' })
  fireEvent.change(editor, { target: { value: '保留未发送草稿' } })
  const link = screen.getByRole('link', { name: '返回 Dashboard' })
  expect(link.getAttribute('href')).toBe('/sessions?profile=default')
  expect(link.getAttribute('target')).toBeNull()
  link.addEventListener('click', event => event.preventDefault())
  fireEvent.click(link)
  expect(localStorage.getItem(draftKey('default', 'saved'))).toBe('保留未发送草稿')
  fireEvent.click(screen.getByRole('button', { name: '新建对话' }))
  expect(screen.getByRole('link', { name: '返回 Dashboard' }).getAttribute('href')).toBe('/sessions?profile=default')
  expect(controller.getSnapshot().conversation).toBeNull()
  expect(
    rpc.request.mock.calls.filter(call => ['prompt.submit', 'session.create', 'session.interrupt'].includes(call[0]))
      .length
  ).toBe(0)
  controller.dispose()
})

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
      chatTextScale: 110
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
  expect(rpc.request.mock.calls.filter(call => call[0] === 'prompt.submit').length).toBe(0)
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
    expect(
      rpc.request.mock.calls.every(args => args[0] === 'session.resume' || args[0] === 'session.active_list')
    ).toBe(true)
  } finally {
    controller.dispose()
    visible.mockRestore()
    vi.useRealTimers()
  }
})

it('collapses consecutive routine tools into one Desktop-style activity run', async () => {
  const { controller, rpc } = setup()
  await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
  rpc.request.mockResolvedValueOnce({
    session_id: 'saved',
    stored_session_id: 'saved',
    info: {},
    messages: Array.from({ length: 5 }, (_, i) => ({
      _row_id: i + 1,
      role: 'tool',
      tool_name: 'skill_view',
      content: 'tool output'
    }))
  } as never)
  await act(async () => {
    await controller.open('saved')
  })
  expect(screen.getByRole('button', { name: /5 项工具调用/ }).getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryAllByText('tool output')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: /5 项工具调用/ }))
  expect(screen.getAllByText('skill_view')).toHaveLength(5)
  controller.dispose()
})

it('ends a stalled image load after the request deadline', async () => {
  vi.useFakeTimers()
  let signal: AbortSignal | undefined

  const api = {
    request: vi.fn((_path: string, init: RequestInit) => {
      signal = init.signal as AbortSignal

      return new Promise(() => {})
    })
  }

  try {
    render(
      <SessionImage
        api={api as never}
        path="/home/example/.hermes/images/stalled.png"
        profile="default"
        sessionId="saved"
      />
    )
    expect(screen.getByRole('status').textContent).toBe('正在载入图片…')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001)
    })
    expect(signal?.aborted).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('图片无法载入')
    expect(api.request).toHaveBeenCalledTimes(1)
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

it('renders no tool activity for an empty tool group', () => {
  const view = render(<ToolActivity messages={[]} />)
  expect(view.container.childElementCount).toBe(0)
})

it('cancels image request and deadline on unmount without retrying', async () => {
  vi.useFakeTimers()
  let signal: AbortSignal | undefined

  const api = {
    request: vi.fn((_path: string, init: RequestInit) => {
      signal = init.signal as AbortSignal

      return new Promise(() => {})
    })
  }

  try {
    const view = render(
      <SessionImage
        api={api as never}
        path="/home/example/.hermes/images/stalled.png"
        profile="default"
        sessionId="saved"
      />
    )

    expect(signal?.aborted).toBe(false)
    const timersBefore = vi.getTimerCount()
    view.unmount()
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBeLessThan(timersBefore)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001)
    })
    expect(screen.queryByRole('status')).toBeNull()
    expect(api.request).toHaveBeenCalledTimes(1)
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

it('loads persisted image references through the authenticated same-origin media route', async () => {
  const { controller, rpc, api } = setup()
  await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
  const path = '/home/example/.hermes/images/upload_fixture.png'

  const dataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7tQAAAAASUVORK5CYII='

  api.request.mockImplementation(async (url?: unknown) =>
    String(url).startsWith('/api/fs/read-data-url?') ? ({ dataUrl } as never) : { sessions: [], total: 0 }
  )
  rpc.request.mockResolvedValueOnce({
    session_id: 'saved',
    stored_session_id: 'saved',
    messages: [{ role: 'user', content: `@image:${path}\n[screenshot]\n图片说明` }],
    info: {}
  } as never)
  await act(async () => {
    await controller.open('saved')
  })
  const image = await screen.findByRole('img', { name: '会话图片' })
  expect(image.getAttribute('src')).toBe(dataUrl)
  expect(screen.getByText('图片说明')).toBeTruthy()
  expect(
    api.request.mock.calls.some(
      call => String(call[0]).includes('session_id=saved') && String(call[0]).includes(encodeURIComponent(path))
    )
  ).toBe(true)
  expect(screen.queryByText('[screenshot]')).toBeNull()
  controller.dispose()
})

it('marks sessions held by a live backend elsewhere without claiming a running turn', async () => {
  const { controller, api, rpc } = setup()
  api.request.mockImplementation(async path =>
    String(path).startsWith('/api/sessions?')
      ? {
          sessions: [
            { id: 'saved-a', title: '另一端打开的会话', last_active: 1, live_lease: true },
            { id: 'saved-b', title: '普通会话', last_active: 2, live_lease: false },
            { id: 'saved-c', title: '仅租约标记的会话', last_active: 3, live_lease: true }
          ],
          total: 3
        }
      : { sessions: [], total: 0 }
  )
  rpc.request.mockImplementation(async (method: string) =>
    method === 'session.active_list'
      ? { sessions: [{ id: 'live-a', session_key: 'saved-a', status: 'working' }] }
      : { session_id: 'x', stored_session_id: 'x', messages: [], info: {} }
  )
  await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
  await waitFor(() => expect(controller.getSnapshot().sessions.some(row => row.live_lease)).toBe(true))
  fireEvent.click(screen.getByRole('button', { name: '打开会话列表' }))
  // In-process status wins for the live row; the lease-only row gets the cross-process marker.
  expect(screen.getByRole('status', { name: '会话运行中' })).toBeTruthy()
  expect(screen.getByText('另一端打开的会话')).toBeTruthy()
  expect(screen.getByRole('status', { name: '后端已连接；运行状态未知' })).toBeTruthy()
  expect(screen.queryByRole('status', { name: '另一端活动中' })).toBeNull()
  expect(screen.getByText('仅租约标记的会话')).toBeTruthy()
  controller.dispose()
})

it.each(['starting', 'resuming'])('announces %s sessions as starting rather than working', async status => {
  const { controller, api, rpc } = setup()
  api.request.mockResolvedValue({ sessions: [{ id: 'saved-a', title: '启动中的会话' }], total: 1 })
  rpc.request.mockImplementation(async (method: string) =>
    method === 'session.active_list'
      ? { sessions: [{ id: 'live', session_key: 'saved-a', status }] }
      : { session_id: 'x', stored_session_id: 'x', messages: [], info: {} }
  )

  try {
    await waitFor(() => expect(controller.getSnapshot().sessions[0]?.live_status).toBe('starting'))
    fireEvent.click(screen.getByRole('button', { name: '打开会话列表' }))
    expect(screen.getByRole('status', { name: '正在启动' }).getAttribute('title')).toBe('正在启动')
    expect(screen.queryByRole('status', { name: '会话运行中' })).toBeNull()
  } finally {
    controller.dispose()
  }
})

it('combines visible search project status source and time controls and clears only filters', async () => {
  const { controller, api, rpc } = setup()
  const stamp = Date.now() / 1000

  const rows = [
    { id: 'target', title: '符合全部条件', cwd: '/repo', source: 'desktop', last_active: stamp },
    { id: 'lease', title: '仅租约不能算运行', cwd: '/repo', source: 'desktop', last_active: stamp, live_lease: true },
    { id: 'wrong-project', title: '其他项目', cwd: '/other', source: 'desktop', last_active: stamp }
  ]

  api.request.mockImplementation(async path =>
    String(path).includes('/search?')
      ? ({ results: rows.map(row => ({ ...row, session_id: row.id, snippet: 'needle' })) } as never)
      : { sessions: rows, total: rows.length }
  )
  rpc.request.mockImplementation(async (method: string) =>
    method === 'session.active_list'
      ? {
          sessions: rows
            .filter(row => row.id !== 'lease')
            .map(row => ({ id: row.id, session_key: row.id, status: 'working' }))
        }
      : { session_id: 'x', stored_session_id: 'x', messages: [], info: {} }
  )

  try {
    await waitFor(() => expect(controller.getSnapshot().sessions).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: '打开会话列表' }))
    fireEvent.change(screen.getByLabelText('按项目筛选'), { target: { value: '/repo' } })
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索会话' }), { target: { value: 'needle' } })
    await waitFor(() => expect(api.request.mock.calls.some(([path]) => String(path).includes('q=needle'))).toBe(true))
    expect(screen.getByLabelText('按项目筛选')).toBeTruthy()
    fireEvent.click(screen.getByText('更多筛选'))
    fireEvent.change(screen.getByLabelText('按状态筛选'), { target: { value: 'working' } })
    fireEvent.change(screen.getByLabelText('按来源筛选'), { target: { value: 'source:desktop' } })
    fireEvent.change(screen.getByLabelText('按时间筛选'), { target: { value: 'today' } })
    await waitFor(() => expect(screen.getByText('符合全部条件')).toBeTruthy())
    expect(screen.queryByText('仅租约不能算运行')).toBeNull()
    expect(screen.queryByText('其他项目')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    expect((screen.getByRole('searchbox', { name: '搜索会话' }) as HTMLInputElement).value).toBe('needle')
    expect(screen.getByText('其他项目')).toBeTruthy()
    expect(screen.getByText('仅租约不能算运行')).toBeTruthy()
  } finally {
    controller.dispose()
  }
})

it('keeps load-more reachable when live-only rows inflate the visible session count', async () => {
  const { controller, api, rpc } = setup()
  api.request.mockImplementation(async path => {
    const nextPage = String(path).includes('offset=1&')

    return {
      sessions: [{ id: nextPage ? 'saved-b' : 'saved-a', title: nextPage ? '更早保存的会话' : '已保存的会话' }],
      total: 2
    }
  })
  rpc.request.mockImplementation(async (method: string) =>
    method === 'session.active_list'
      ? { sessions: [{ id: 'runtime-only', session_key: 'live-only', status: 'working', title: '尚未保存的会话' }] }
      : { session_id: 'x', stored_session_id: 'x', messages: [], info: {} }
  )

  try {
    await waitFor(() => expect(controller.getSnapshot().sessions.map(row => row.id)).toEqual(['saved-a', 'live-only']))
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: '打开会话列表' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(251)
    })
    const more = screen.getByRole('button', { name: '加载更早的会话' })
    await act(async () => {
      fireEvent.click(more)
    })
    expect(screen.getByText('更早保存的会话')).toBeTruthy()
    expect(api.request.mock.calls.some(([path]) => String(path).includes('offset=1&'))).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(251)
    })
    expect(screen.queryByRole('button', { name: '加载更早的会话' })).toBeNull()
  } finally {
    controller.dispose()
    vi.useRealTimers()
  }
})

it('paints real runtime status dots on session rows instead of recent-activity marks', async () => {
  const { controller, api, rpc } = setup()
  api.request.mockImplementation(async path =>
    String(path).startsWith('/api/sessions?')
      ? {
          sessions: [
            { id: 'saved-a', title: '运行中的会话', last_active: 1 },
            { id: 'saved-b', title: '空闲会话', last_active: 2 }
          ],
          total: 2
        }
      : { sessions: [], total: 0 }
  )
  rpc.request.mockImplementation(async (method: string) =>
    method === 'session.active_list'
      ? {
          sessions: [
            { id: 'live-a', session_key: 'saved-a', status: 'working' },
            { id: 'live-b', session_key: 'saved-b', status: 'idle' },
            { id: 'live-w', session_key: 'saved-w', status: 'waiting', title: '等待中的会话', preview: 'p' }
          ]
        }
      : { session_id: 'x', stored_session_id: 'x', messages: [], info: {} }
  )
  await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
  await waitFor(() => expect(controller.getSnapshot().sessions.some(row => row.live_status === 'working')).toBe(true))
  fireEvent.click(screen.getByRole('button', { name: '打开会话列表' }))
  expect(screen.getByRole('status', { name: '会话运行中' })).toBeTruthy()
  expect(screen.getByRole('status', { name: '需要你输入' })).toBeTruthy()
  expect(screen.getByText('等待中的会话')).toBeTruthy()
  expect(screen.queryAllByRole('status', { name: '空闲' }).length).toBe(0)
  // The list's own mount debounce re-fetches saved rows; live statuses must survive that refresh.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 500))
  })
  expect(screen.getByRole('status', { name: '会话运行中' })).toBeTruthy()
  expect(screen.getByRole('status', { name: '需要你输入' })).toBeTruthy()
  controller.dispose()
})

it('projects the authoritative session todo state into a visible task panel', async () => {
  const { controller, rpc } = setup()
  await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
  rpc.request.mockResolvedValueOnce({
    session_id: 'saved',
    stored_session_id: 'saved',
    messages: [],
    info: {},
    todo_state: {
      revision: 4,
      todos: [
        { id: 'a', content: '已验证的工作', status: 'completed' },
        { id: 'b', content: '当前正在处理', status: 'in_progress' },
        { id: 'c', content: '接下来验收', status: 'pending', parent: 'b' }
      ]
    }
  } as never)
  await act(async () => {
    await controller.open('saved')
  })
  expect(screen.getByRole('button', { name: /任务 1\/3/ })).toBeTruthy()
  expect(screen.getByText('当前正在处理')).toBeTruthy()
  expect(screen.getByText('接下来验收')).toBeTruthy()
  controller.dispose()
})
