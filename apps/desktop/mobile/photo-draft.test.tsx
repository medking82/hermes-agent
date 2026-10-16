import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { draftKey } from './input'
import { isPhotoPath, usePhotoDraft } from './photo-draft'

const path = '/home/fixture/.hermes/images/dashboard_fixture.png'
const photo = (name = 'photo.png') => new File(['synthetic-photo'], name, { type: 'image/png' })

function setup() {
  const api = { request: vi.fn().mockResolvedValue({ ok: true, path }) }

  const hook = renderHook(
    ({ scope, epoch, sending }) => usePhotoDraft(api as never, 'default', scope, epoch, sending),
    {
      initialProps: { scope: draftKey('default', 'a'), epoch: 0, sending: false }
    }
  )

  return { api, ...hook }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.useRealTimers()
})

it('rejects control characters in returned or restored photo paths', () => {
  expect(isPhotoPath(path)).toBe(true)
  expect(isPhotoPath('/home/fixture/\u0000/.hermes/images/dashboard_fixture.png')).toBe(false)
})

it('bounds the total bytes restored from the local photo draft', () => {
  const key = draftKey('default', 'a')
  localStorage.setItem(
    `${key}:photos`,
    JSON.stringify(
      Array.from({ length: 4 }, (_, i) => ({
        id: String(i),
        name: 'photo.png',
        path,
        bytes: 20 * 1024 * 1024,
        status: 'ready'
      }))
    )
  )
  const { result } = setup()
  expect(result.current.photos).toHaveLength(2)
})

it('rejects unsupported HEIC and oversized photos without issuing an upload', () => {
  const { result, api } = setup()
  act(() => result.current.add([new File(['heic'], 'photo.heic', { type: 'image/heic' })]))
  expect(result.current.error).toContain('HEIC')
  const big = photo()
  Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 })
  act(() => result.current.add([big]))
  expect(result.current.error).toContain('20 MB')
  expect(api.request).not.toHaveBeenCalled()
})

it('keeps uploads within the existing bounded image-reader budget', () => {
  const { result, api } = setup()
  const big = photo()
  Object.defineProperty(big, 'size', { value: 24 * 1024 * 1024 })
  act(() => result.current.add([big]))
  expect(result.current.error).toContain('20 MB')
  expect(result.current.photos).toHaveLength(0)
  expect(api.request).not.toHaveBeenCalled()
})

it('does not publish an old upload into a newly selected conversation', async () => {
  const { result, api, rerender } = setup()
  let resolve!: (value: unknown) => void
  api.request.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  act(() => result.current.add([photo()]))
  await waitFor(() => expect(api.request).toHaveBeenCalledTimes(1))
  const signal = api.request.mock.calls[0][1].signal as AbortSignal
  rerender({ scope: draftKey('default', 'b'), epoch: 1, sending: false })
  expect(signal.aborted).toBe(true)
  await act(async () => resolve({ ok: true, path }))
  expect(result.current.photos).toHaveLength(0)
  expect(localStorage.getItem(`${draftKey('default', 'b')}:photos`)).toBeNull()
})

it('preserves uploaded metadata without bytes and adopts only the same new-chat send', async () => {
  const { result, rerender } = setup()
  rerender({ scope: draftKey('default', null), epoch: 1, sending: false })
  act(() => result.current.add([photo()]))
  await waitFor(() => expect(result.current.photos[0]?.status).toBe('ready'))
  const saved = localStorage.getItem(`${draftKey('default', null)}:photos`)!
  expect(saved).not.toContain('base64')
  expect(saved).not.toContain('blob:')
  rerender({ scope: draftKey('default', 'created'), epoch: 1, sending: true })
  expect(result.current.photos[0].path).toBe(path)
  expect(localStorage.getItem(`${draftKey('default', null)}:photos`)).toBeNull()
  rerender({ scope: draftKey('default', 'b'), epoch: 2, sending: true })
  expect(result.current.photos).toHaveLength(0)
})

it('clears only the acknowledged photo draft even after navigation away during send', async () => {
  const { result, rerender } = setup()
  act(() => result.current.add([photo()]))
  await waitFor(() => expect(result.current.photos[0]?.status).toBe('ready'))
  const id = result.current.photos[0].id
  rerender({ scope: draftKey('default', 'b'), epoch: 1, sending: false })
  act(() => result.current.complete([id]))
  expect(localStorage.getItem(`${draftKey('default', 'a')}:photos`)).toBeNull()
  expect(result.current.photos).toHaveLength(0)
})

it('retains a failed upload as a blocking visible item until explicitly removed', async () => {
  const { result, api } = setup()
  api.request.mockRejectedValue(new Error('upload rejected (403)'))
  act(() => result.current.add([photo()]))
  await waitFor(() => expect(result.current.photos[0]?.status).toBe('failed'))
  expect(result.current.blocked).toBe(true)
  expect(result.current.photos[0].error).toContain('403')
  act(() => result.current.remove([result.current.photos[0].id]))
  expect(result.current.photos).toHaveLength(0)
  expect(result.current.blocked).toBe(false)
  expect(api.request).toHaveBeenCalledTimes(1)
})
