import { expect, it } from 'vitest'

import { matchesSession, runtimeStatus, type SessionFilters } from './session-filters'

const defaults: SessionFilters = { project: '', status: 'all', source: 'all', time: 'all' }
const now = new Date(2026, 9, 16, 12, 0, 0).getTime()

it('intersects project source time and runtime state without treating leases or recency as running', () => {
  const filters: SessionFilters = { project: '/repo', source: 'source:desktop', time: 'today', status: 'working' }

  const row = {
    id: 'a',
    git_repo_root: '/repo',
    source: 'desktop',
    last_active: now / 1000,
    live_status: 'working' as const
  }

  expect(matchesSession(row, filters, 'ready', now)).toBe(true)
  expect(matchesSession({ ...row, git_repo_root: '/other' }, filters, 'ready', now)).toBe(false)
  expect(matchesSession({ ...row, source: 'cli' }, filters, 'ready', now)).toBe(false)
  expect(matchesSession({ ...row, last_active: now / 1000 - 86400 }, filters, 'ready', now)).toBe(false)
  expect(
    matchesSession(
      { id: 'leased', live_lease: true, is_active: true },
      { ...defaults, status: 'working' },
      'ready',
      now
    )
  ).toBe(false)
  expect(matchesSession(row, filters, 'offline', now)).toBe(false)
})

it('distinguishes confirmed idle waiting starting and unknown including disconnected snapshots', () => {
  for (const status of ['idle', 'waiting', 'starting', 'working'] as const) {
    expect(runtimeStatus({ id: 'a', live_status: status, live_lease: true }, 'ready')).toBe(status)
    expect(runtimeStatus({ id: 'a', live_status: status }, 'offline')).toBe('unknown')
  }

  expect(runtimeStatus({ id: 'a', live_lease: true, is_active: true }, 'ready')).toBe('unknown')
  expect(matchesSession({ id: 'a', live_lease: true }, { ...defaults, status: 'leased' }, 'ready', now)).toBe(true)
  expect(
    matchesSession(
      { id: 'a', live_lease: true, live_status: 'working' },
      { ...defaults, status: 'leased' },
      'ready',
      now
    )
  ).toBe(false)
  expect(matchesSession({ id: 'a' }, { ...defaults, status: 'unknown' }, 'ready', now)).toBe(true)
})

it('uses browser-local midnight and bounded rolling ranges with a valid start-time fallback', () => {
  const midnight = new Date(2026, 9, 16, 0, 0, 0).getTime() / 1000
  expect(matchesSession({ id: 'a', last_active: midnight }, { ...defaults, time: 'today' }, 'ready', now)).toBe(true)
  expect(matchesSession({ id: 'a', last_active: midnight - 1 }, { ...defaults, time: 'today' }, 'ready', now)).toBe(
    false
  )
  expect(
    matchesSession({ id: 'a', started_at: now / 1000 - 6 * 86400 }, { ...defaults, time: 'week' }, 'ready', now)
  ).toBe(true)
  expect(
    matchesSession({ id: 'a', last_active: now / 1000 - 8 * 86400 }, { ...defaults, time: 'week' }, 'ready', now)
  ).toBe(false)
  expect(
    matchesSession({ id: 'a', last_active: NaN, started_at: now / 1000 }, { ...defaults, time: 'today' }, 'ready', now)
  ).toBe(true)
  expect(matchesSession({ id: 'a', last_active: now / 1000 + 10 }, { ...defaults, time: 'month' }, 'ready', now)).toBe(
    false
  )
  expect(matchesSession({ id: 'a' }, { ...defaults, time: 'month' }, 'ready', now)).toBe(false)
})

it('never invents a source and exposes missing metadata as explicit unknown selections', () => {
  expect(matchesSession({ id: 'a' }, { ...defaults, source: 'unknown' }, 'ready', now)).toBe(true)
  expect(matchesSession({ id: 'a' }, { ...defaults, source: 'source:desktop' }, 'ready', now)).toBe(false)
  expect(matchesSession({ id: 'a', source: 'unknown' }, { ...defaults, source: 'source:unknown' }, 'ready', now)).toBe(
    true
  )
  expect(matchesSession({ id: 'a' }, { ...defaults, project: '__none__' }, 'ready', now)).toBe(true)
  expect(matchesSession({ id: 'a', cwd: '/repo' }, { ...defaults, project: '/repo' }, 'ready', now)).toBe(true)
})
