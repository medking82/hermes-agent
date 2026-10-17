import { afterEach, expect, it, vi } from 'vitest'

import { BrowserApi, SignInRequired } from './browser-api'
afterEach(() => vi.unstubAllGlobals())
it('uses same-origin cookie auth and obtains a fresh ticket for each socket', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ticket: 'first' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ticket: 'second' })))

  vi.stubGlobal('fetch', fetcher)
  const api = new BrowserApi('https://hermes.example')
  expect(await api.socketUrl()).toBe('wss://hermes.example/api/ws?ticket=first')
  expect(await api.socketUrl()).toBe('wss://hermes.example/api/ws?ticket=second')
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' })
})
it('mints a fresh same-origin ticket for the fixed security endpoint only', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ticket: 'fixture-security-ticket' })))
  vi.stubGlobal('fetch', fetcher)
  const api = new BrowserApi('https://hermes.example')
  expect(await api.socketUrl('/api/plugins/neo-mobile-web/security/ws')).toBe(
    'wss://hermes.example/api/plugins/neo-mobile-web/security/ws?ticket=fixture-security-ticket'
  )
  await expect(api.socketUrl('https://foreign.invalid/api/ws' as never)).rejects.toThrow()
})
it('fails closed on expired auth, without redirecting to an external login', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ login_url: 'https://attacker.invalid/' }), { status: 401 }))
  )
  await expect(new BrowserApi('https://hermes.example').request('/api/sessions')).rejects.toBeInstanceOf(SignInRequired)
})
it('refuses non-API or foreign-origin requests before fetch', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  const api = new BrowserApi('https://hermes.example')

  for (const path of [
    'https://bad.invalid/api/x',
    '//bad.invalid/api/x',
    '/api/../auth/logout',
    '/auth/logout',
    '/api/%2e%2e/auth/logout'
  ]) {
    await expect(api.request(path)).rejects.toThrow()
  }

  expect(fetcher).not.toHaveBeenCalled()
})
