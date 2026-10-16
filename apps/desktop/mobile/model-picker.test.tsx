import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { MobileApp } from './app'
import { MobileController } from './controller'
import { setWebLocale } from './localization'

const catalog = {
  model: 'fixture-original',
  provider: 'fixture-provider',
  providers: [
    { slug: 'fixture-provider', name: 'Fixture Provider', models: ['fixture-original', 'fixture-alternative'] }
  ]
}

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
  vi.unstubAllGlobals()
})

function setup() {
  const snapshot = (id = 'created') => ({
    session_id: id,
    stored_session_id: id,
    messages: [],
    running: false,
    info: { model: 'fixture-original' }
  })

  const api = {
    socketUrl: vi.fn().mockResolvedValue('wss://example/api/ws'),
    request: vi.fn(async (url: string) =>
      url.startsWith('/api/chat/image-upload')
        ? {
            ok: true,
            path: '/home/fixture/.hermes/images/dashboard_photo.png',
            name: 'photo.png',
            bytes: 5,
            mime_type: 'image/png'
          }
        : { sessions: [], total: 0 }
    )
  }

  const rpc = {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    onAny: () => () => {},
    onState: () => () => {},
    onRequest: () => () => {},
    request: vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'model.options') {
        return catalog
      }

      if (method === 'config.set') {
        return { key: 'model', value: 'fixture-alternative', scope: 'session', confirm_required: false }
      }

      return snapshot(params.session_id as string | undefined)
    })
  }

  const controller = new MobileController(api as never, rpc as never)
  render(<MobileApp controller={controller} />)

  return { controller, rpc, api, snapshot }
}

it('switches only the selected saved session and keeps the old model on rejection', async () => {
  const { controller, rpc } = setup()

  try {
    await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
    await act(async () => {
      await controller.open('saved')
    })
    await chooseAlternative()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '选择模型' })).toBeNull())
    expect(rpc.request).toHaveBeenCalledWith('config.set', {
      session_id: 'saved',
      profile: 'default',
      key: 'model',
      value: 'fixture-alternative --provider fixture-provider --session'
    })
    expect(controller.getSnapshot().conversation?.model).toBe('fixture-alternative')
    expect(
      rpc.request.mock.calls.some(([method]) =>
        ['prompt.submit', 'session.create', 'session.interrupt'].includes(method)
      )
    ).toBe(false)
    rpc.request.mockImplementation(async (method: string) => {
      if (method === 'config.set') {
        throw new Error('Session owned by another process')
      }

      return catalog
    })
    await chooseAlternative()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Session owned by another process'))
    expect(controller.getSnapshot().conversation?.model).toBe('fixture-alternative')
    expect(rpc.request.mock.calls.filter(([method]) => method === 'config.set')).toHaveLength(2)
  } finally {
    controller.dispose()
  }
})

it('keeps backend confirmation as a refusal rather than silently forcing the switch', async () => {
  const { controller, rpc } = setup()

  try {
    await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
    await act(async () => {
      await controller.open('saved')
    })
    rpc.request.mockImplementation(async method =>
      method === 'config.set'
        ? { confirm_required: true, confirm_message: 'Additional confirmation required', value: 'fixture-alternative' }
        : catalog
    )
    await chooseAlternative()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Additional confirmation required'))
    expect(controller.getSnapshot().conversation?.model).toBe('fixture-original')
    expect(rpc.request.mock.calls.filter(([method]) => method === 'config.set')).toHaveLength(1)
    expect(rpc.request.mock.calls.every(([, params]) => !params?.confirm_expensive_model && !params?.force)).toBe(true)
  } finally {
    controller.dispose()
  }
})

it('does not send during a pending model switch or repaint another conversation from a late ACK', async () => {
  const { controller, rpc } = setup()

  try {
    await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
    await act(async () => {
      await controller.open('saved')
    })
    let resolve!: (result: unknown) => void
    rpc.request.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    let pending!: Promise<void>
    await act(async () => {
      pending = controller.selectModel({ model: 'fixture-alternative', provider: 'fixture-provider' })
      expect(await controller.send('must not send')).toBe(false)
      await controller.open('other')
      resolve({ value: 'fixture-alternative', scope: 'session', confirm_required: false })
      await pending
    })
    expect(controller.getSnapshot().conversation?.storedId).toBe('other')
    expect(controller.getSnapshot().conversation?.model).toBe('fixture-original')
    expect(controller.getSnapshot().modelChanging).toBe(false)
    expect(rpc.request.mock.calls.some(([method]) => method === 'prompt.submit')).toBe(false)
  } finally {
    controller.dispose()
  }
})

it('does not let model IDs inject persistence flags', async () => {
  const { controller, rpc } = setup()

  try {
    await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
    await act(async () => {
      await controller.open('saved')
    })
    await expect(controller.selectModel({ model: 'fixture --global', provider: 'fixture-provider' })).rejects.toThrow(
      'Desktop'
    )
    await expect(controller.selectModel({ model: 'fixture', provider: 'fixture-provider --global' })).rejects.toThrow(
      'Desktop'
    )
    expect(rpc.request.mock.calls.some(([method]) => method === 'config.set')).toBe(false)
  } finally {
    controller.dispose()
  }
})

it('disables model changes during a running turn without affecting the photo picker', async () => {
  const { controller, rpc, snapshot } = setup()

  try {
    await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
    rpc.request.mockResolvedValueOnce({ ...snapshot('saved'), running: true })
    await act(async () => {
      await controller.open('saved')
    })
    expect((screen.getByRole('button', { name: '选择模型' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '选择照片' }) as HTMLButtonElement).disabled).toBe(false)
    await expect(
      controller.selectModel({ model: 'fixture-alternative', provider: 'fixture-provider' })
    ).rejects.toThrow()
    expect(rpc.request.mock.calls.some(([method]) => method === 'config.set')).toBe(false)
  } finally {
    controller.dispose()
  }
})

it('allows catalog retry and cancel without sending or changing defaults', async () => {
  const { controller, rpc } = setup()

  try {
    await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
    rpc.request.mockRejectedValueOnce(new Error('Catalog unavailable'))
    fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Catalog unavailable'))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByRole('combobox', { name: '模型' })
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(controller.getSnapshot().draftModel).toBeUndefined()
    expect(
      rpc.request.mock.calls.filter(([method]) => ['config.set', 'prompt.submit', 'session.create'].includes(method))
    ).toHaveLength(0)
  } finally {
    controller.dispose()
  }
})

async function chooseAlternative() {
  fireEvent.click(screen.getByRole('button', { name: '选择模型' }))
  const select = await screen.findByRole('combobox', { name: '模型' })
  await waitFor(() => expect(screen.getByRole('option', { name: 'fixture-alternative' })).toBeTruthy())
  fireEvent.change(select, { target: { value: JSON.stringify(['fixture-provider', 'fixture-alternative']) } })
  fireEvent.click(screen.getByRole('button', { name: '应用模型' }))
}

it('selects a draft model through the composer without starting work or losing the uploaded photo', async () => {
  const { controller, rpc, api } = setup()

  try {
    await waitFor(() => expect(controller.getSnapshot().connection).toBe('ready'))
    fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '保留草稿' } })
    fireEvent.change(screen.getByLabelText('添加照片'), {
      target: { files: [new File(['photo'], 'photo.png', { type: 'image/png' })] }
    })
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(false)
    )
    await chooseAlternative()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '选择模型' })).toBeNull())
    expect(screen.getByRole('button', { name: '选择模型' }).textContent).toContain('fixture-alternative')
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('保留草稿')
    expect(screen.getByText('photo.png')).toBeTruthy()
    expect(rpc.request).toHaveBeenCalledWith('model.options', {
      profile: 'default',
      explicit_only: true,
      include_unconfigured: false
    })
    expect(
      rpc.request.mock.calls.filter(([method]) => ['session.create', 'config.set', 'prompt.submit'].includes(method))
    ).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() =>
      expect(rpc.request).toHaveBeenCalledWith(
        'session.create',
        expect.objectContaining({
          model: 'fixture-alternative',
          provider: 'fixture-provider',
          profile: 'default',
          source: 'web'
        })
      )
    )
    await waitFor(() =>
      expect(rpc.request).toHaveBeenCalledWith(
        'prompt.submit',
        expect.objectContaining({
          text: '保留草稿\n@image:/home/fixture/.hermes/images/dashboard_photo.png'
        }),
        1800000
      )
    )
    expect(api.request.mock.calls.filter(([url]) => url.startsWith('/api/chat/image-upload'))).toHaveLength(1)
  } finally {
    controller.dispose()
  }
})
