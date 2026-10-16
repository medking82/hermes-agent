import type { MobileState, SessionRow } from './controller'
import { projectMatches } from './input'

export interface SessionFilters {
  project: string
  status: 'all' | 'working' | 'waiting' | 'starting' | 'idle' | 'unknown' | 'leased'
  source: string
  time: 'all' | 'today' | 'week' | 'month'
}

export function runtimeStatus(row: SessionRow, connection: MobileState['connection']) {
  return connection === 'ready' && row.live_status ? row.live_status : 'unknown'
}

export function matchesSession(
  row: SessionRow,
  filters: SessionFilters,
  connection: MobileState['connection'],
  now: number
) {
  const path = row.git_repo_root || row.cwd

  if (filters.project === '__none__' ? Boolean(path) : !projectMatches(filters.project, '', path)) {
    return false
  }

  const status = runtimeStatus(row, connection)

  if (
    filters.status === 'leased'
      ? !(status === 'unknown' && row.live_lease)
      : filters.status !== 'all' && status !== filters.status
  ) {
    return false
  }

  if (
    filters.source === 'unknown'
      ? Boolean(row.source)
      : filters.source !== 'all' && row.source !== filters.source.slice('source:'.length)
  ) {
    return false
  }

  if (filters.time === 'all') {
    return true
  }

  const valid = (value?: number) => typeof value === 'number' && Number.isFinite(value) && value > 0
  const time = valid(row.last_active) ? row.last_active! : valid(row.started_at) ? row.started_at! : undefined
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const since = filters.time === 'today' ? midnight.getTime() : now - (filters.time === 'week' ? 7 : 30) * 86400_000

  return time !== undefined && time * 1000 >= since && time * 1000 <= now
}
