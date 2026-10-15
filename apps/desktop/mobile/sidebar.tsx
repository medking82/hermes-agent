import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { tr, useWebLocale } from './localization'

const NAV_KEY = 'hermes-web:navigation:v1'
const DEFAULT_WIDTH = 292
interface NavigationPreferences {
  width: number
  collapsed: boolean
}

export function readNavigation(): NavigationPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(NAV_KEY) ?? 'null')

    return {
      width:
        typeof value?.width === 'number' && Number.isFinite(value.width)
          ? Math.max(240, Math.min(420, value.width))
          : DEFAULT_WIDTH,
      collapsed: value?.collapsed === true
    }
  } catch {
    return { width: DEFAULT_WIDTH, collapsed: false }
  }
}

function persist(change: Partial<NavigationPreferences>) {
  try {
    localStorage.setItem(NAV_KEY, JSON.stringify({ ...readNavigation(), ...change }))
  } catch {
    /* Local presentation still works if storage is unavailable. */
  }
}

export function useNavigationCollapsed() {
  const [collapsed, setCollapsed] = useState(() => readNavigation().collapsed)

  const change = (value: boolean) => {
    setCollapsed(value)
    persist({ collapsed: value })
  }

  return [collapsed, change] as const
}

function bounds() {
  return {
    min: 240,
    max: Math.max(
      240,
      Math.min(420, Math.floor(document.documentElement.clientWidth * 0.35), document.documentElement.clientWidth - 560)
    )
  }
}

function clamp(width: number) {
  const { min, max } = bounds()

  return Math.max(min, Math.min(max, Math.round(width)))
}

export function ResizableSidebar({ children, collapsed }: { children: ReactNode; collapsed: boolean }) {
  const locale = useWebLocale()
  const [width, setWidth] = useState(() => clamp(readNavigation().width))
  const current = useRef(width)
  const gesture = useRef<{ id: number; x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const update = useCallback((next: number, commit = false) => {
    current.current = clamp(next)
    setWidth(current.current)

    if (commit) {
      persist({ width: current.current })
    }
  }, [])

  useEffect(() => {
    const resize = () => {
      gesture.current = null
      setDragging(false)
      update(readNavigation().width)
    }

    window.addEventListener('resize', resize)

    return () => window.removeEventListener('resize', resize)
  }, [update])
  const { min, max } = bounds()

  return (
    <aside
      aria-label={tr('会话导航')}
      className="desktop-sidebar"
      hidden={collapsed}
      id="web-session-sidebar"
      style={{ flexBasis: width }}
    >
      {children}
      <div
        aria-controls="web-session-sidebar"
        aria-label={tr('调整侧栏宽度')}
        aria-orientation="vertical"
        aria-valuemax={max}
        aria-valuemin={min}
        aria-valuenow={width}
        aria-valuetext={`${width}px`}
        className="sidebar-resizer"
        data-dragging={dragging}
        onDoubleClick={() => update(DEFAULT_WIDTH, true)}
        onKeyDown={e => {
          const delta = locale === 'ar' ? -20 : 20

          const actions: Record<string, number> = {
            ArrowRight: current.current + delta,
            ArrowLeft: current.current - delta,
            Home: min,
            End: max,
            Enter: DEFAULT_WIDTH
          }

          if (Object.hasOwn(actions, e.key)) {
            e.preventDefault()
            update(actions[e.key], true)
          }
        }}
        onLostPointerCapture={e => {
          const start = gesture.current

          if (!start || start.id !== e.pointerId) {
            return
          }

          gesture.current = null
          setDragging(false)

          update(start.width)
        }}
        onPointerCancel={e => {
          const start = gesture.current

          if (!start || start.id !== e.pointerId) {
            return
          }

          gesture.current = null
          setDragging(false)

          update(start.width)
        }}
        onPointerDown={e => {
          if (!e.isPrimary || e.button !== 0 || gesture.current) {
            return
          }

          e.preventDefault()
          e.currentTarget.focus()
          e.currentTarget.setPointerCapture(e.pointerId)
          gesture.current = { id: e.pointerId, x: e.clientX, width: current.current }
          setDragging(true)
        }}
        onPointerMove={e => {
          const start = gesture.current

          if (start?.id === e.pointerId) {
            update(start.width + (e.clientX - start.x) * (locale === 'ar' ? -1 : 1))
          }
        }}
        onPointerUp={e => {
          if (gesture.current?.id === e.pointerId) {
            gesture.current = null
            setDragging(false)
            update(current.current, true)
          }
        }}
        role="separator"
        tabIndex={0}
        title={tr('拖动调整；方向键微调；双击或 Enter 恢复默认')}
      >
        <span />
      </div>
    </aside>
  )
}
