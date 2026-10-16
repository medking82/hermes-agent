import { cleanup, render, screen } from '@testing-library/react'
import * as React from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { registerMobileNavigation } from './public/dashboard-link.js'

afterEach(() => {
  cleanup()
  history.replaceState(null, '', '/')
})

it('registers a same-tab mobile-chat exit through the existing Dashboard slot', () => {
  globalThis.document.documentElement.lang = 'zh'
  history.replaceState(null, '', '/sessions?profile=default')
  const registerSlot = vi.fn()
  const register = vi.fn()
  expect(registerMobileNavigation({ React }, { registerSlot, register })).toBe(true)
  expect(register).toHaveBeenCalledWith('neo-mobile-web', expect.any(Function))
  expect(registerSlot).toHaveBeenCalledWith('neo-mobile-web', 'header-banner', expect.any(Function))
  const Component = registerSlot.mock.calls[0][2]
  render(React.createElement(Component))
  const link = screen.getByRole('link', { name: '返回手机聊天' })
  expect(link.getAttribute('href')).toBe('/mobile/')
  expect(link.getAttribute('target')).toBeNull()
})

it('does not silently switch a non-default management profile to default chat', () => {
  history.replaceState(null, '', '/sessions?profile=reviewer')
  const registerSlot = vi.fn()
  registerMobileNavigation({ React }, { registerSlot })
  const Component = registerSlot.mock.calls[0][2]
  render(React.createElement(Component))
  expect(screen.queryByRole('link')).toBeNull()
})

it('fails closed without a compatible Dashboard slot host', () => {
  expect(registerMobileNavigation({}, {})).toBe(false)
})
