import type { ServerRequest } from '@hermes/shared'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  Folder,
  MessageSquare,
  Moon,
  PanelLeft,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Sun,
  WifiOff,
  X
} from 'lucide-react'
import { motion, useDragControls, useReducedMotion } from 'motion/react'
import { Dialog } from 'radix-ui'
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Streamdown } from 'streamdown'

import { BackdropImage } from '../src/components/ui/backdrop-image'
import { Button } from '../src/components/ui/button'
import { useMediaQuery } from '../src/hooks/use-media-query'

import { AppearanceSettings } from './appearance-settings'
import type { MobileController } from './controller'
import { type SessionRow } from './controller'
import type { Message } from './conversation'
import { draftKey, projectMatches, shouldSubmitKey, viewportGeometry } from './input'
import { getWebLocale, syncDocumentLocale, tr, useWebLocale } from './localization'
import { ResizableSidebar, useNavigationCollapsed } from './sidebar'

function saved(key: string) {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function save(key: string, value: string) {
  try {
    if (value) {
      localStorage.setItem(key, value)
    } else {
      localStorage.removeItem(key)
    }
  } catch {
    /* Private browsing can refuse storage; editing still works. */
  }
}

function projectName(path?: string | null) {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) || tr('未归类')
}

function relativeTime(time?: number) {
  if (!time) {
    return ''
  }

  const days = Math.floor((Date.now() - time * 1000) / 86400000)

  return new Intl.RelativeTimeFormat(getWebLocale(), { numeric: 'auto' }).format(-Math.max(0, days), 'day')
}

function IconButton({
  label,
  children,
  onClick,
  disabled = false,
  expanded,
  controls
}: {
  label: string
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  expanded?: boolean
  controls?: string
}) {
  return (
    <Button
      aria-controls={controls}
      aria-expanded={expanded}
      aria-label={label}
      className="mobile-icon"
      disabled={disabled}
      onClick={onClick}
      size="icon"
      type="button"
      variant="ghost"
    >
      {children}
    </Button>
  )
}

function BrandLogo({ className }: { className: string }) {
  return <img alt="" aria-hidden="true" className={className} height="128" src="/mobile/hermes-icon.png" width="128" />
}

function Brand() {
  return (
    <span className="brand-lockup">
      <BrandLogo className="brand-symbol" />
      <span>
        Hermes<span className="web-label">WEB</span>
      </span>
    </span>
  )
}

function SessionList({
  controller,
  selected,
  onOpen,
  onNew
}: {
  controller: MobileController
  selected?: string
  onOpen: (row: SessionRow) => void
  onNew: () => void
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const timer = setTimeout(() => {
      void controller.loadSessions(query)
    }, 250)

    return () => clearTimeout(timer)
  }, [controller, query])
  const projects = [...new Set(state.sessions.map(row => row.git_repo_root || row.cwd).filter(Boolean))] as string[]
  const rows = state.sessions.filter(row => projectMatches(project, query, row.git_repo_root || row.cwd))

  return (
    <div className="session-list">
      <div className="sidebar-brand">
        <Brand />
        <span className="small-tag">{tr('个人空间')}</span>
      </div>
      <Button className="new-chat" onClick={onNew} variant="outline">
        <Plus />
        {tr('新对话')}
      </Button>
      <label className="search-box">
        <Search aria-hidden="true" size={17} />
        <input
          aria-label={tr('搜索会话')}
          data-mobile-search
          onChange={e => setQuery(e.target.value)}
          placeholder={tr('搜索对话与内容')}
          ref={input}
          type="search"
          value={query}
        />
        {query && (
          <IconButton label={tr('清除搜索')} onClick={() => setQuery('')}>
            <X />
          </IconButton>
        )}
      </label>
      <div className="list-heading">
        <span>{tr('对话')}</span>
        <IconButton
          disabled={state.listLoading}
          label={tr('刷新会话')}
          onClick={() => void controller.loadSessions(query)}
        >
          <RefreshCw className={state.listLoading ? 'spin' : ''} />
        </IconButton>
      </div>
      {projects.length > 0 && !query && (
        <label className="project-filter">
          <Folder aria-hidden="true" size={15} />
          <select aria-label={tr('按项目筛选')} onChange={e => setProject(e.target.value)} value={project}>
            <option value="">{tr('所有项目')}</option>
            {projects.map(path => (
              <option key={path} value={path}>
                {projectName(path)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div aria-busy={state.listLoading} className="session-scroll">
        {state.listError && (
          <div className="list-error" role="alert">
            {tr(state.listError)}
            <Button onClick={() => void controller.loadSessions(query)} variant="text">
              {tr('重试')}
            </Button>
          </div>
        )}
        {!state.listError && state.listLoading && !rows.length && (
          <div aria-label={tr('加载会话')} className="skeletons">
            {[0, 1, 2, 3].map(i => (
              <div key={i} />
            ))}
          </div>
        )}
        {!state.listError && !state.listLoading && !rows.length && (
          <div className="list-empty">
            <MessageSquare />
            {query ? tr('没有找到匹配的对话') : tr('这里是你的对话记录')}
            <span>{query ? tr('试试标题或对话中的关键词') : tr('开始一段对话，随时从这里接着聊。')}</span>
          </div>
        )}
        {rows.map(row => (
          <button
            aria-current={selected === row.id ? 'true' : undefined}
            className={`session-row ${selected === row.id ? 'selected' : ''}`}
            key={row.id}
            onClick={() => onOpen(row)}
          >
            <div className="session-row-top">
              <span>{row.title || row.preview || tr('未命名对话')}</span>
              <span>{relativeTime(row.last_active || row.started_at)}</span>
            </div>
            <div className="session-row-detail">
              <span>{row.preview || projectName(row.git_repo_root || row.cwd)}</span>
              {selected === row.id && <span aria-hidden="true" className="active-mark" />}
            </div>
          </button>
        ))}
        {!query && state.sessions.length < state.total && (
          <Button
            className="load-more"
            disabled={state.listLoading}
            onClick={() => void controller.loadSessions('', true)}
            variant="text"
          >
            {tr('加载更早的会话')}
          </Button>
        )}
      </div>
      <div className="sidebar-footer">
        <span className="account-avatar">M</span>
        <div>
          {tr('默认工作空间')}
          <span>GA401 · default</span>
        </div>
        <ShieldCheck aria-hidden="true" size={17} />
      </div>
    </div>
  )
}

function ToolMessage({ message }: { message: Message }) {
  return (
    <details className="tool-disclosure">
      <summary>
        <span className={message.streaming ? 'activity-dot pulsing' : 'tool-check'}>
          {!message.streaming && <Check size={13} />}
        </span>
        <span>{message.name || tr('工具调用')}</span>
        <span>{message.streaming ? tr('执行中') : tr('已完成')}</span>
        <ChevronDown size={14} />
      </summary>
      <pre>{message.text}</pre>
    </details>
  )
}

const mobileMarkdownComponents = { img: () => <span className="blocked-image">{tr('外部图片未自动载入')}</span> }

function MessageBody({ message }: { message: Message }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)

  if (message.role === 'tool') {
    return <ToolMessage message={message} />
  }

  return (
    <article
      aria-label={message.role === 'user' ? tr('你的消息') : tr('Hermes 回复')}
      className={`message ${message.role}`}
    >
      {message.role === 'assistant' && (
        <div className="assistant-name">
          <BrandLogo className="mini-brand" />
          Hermes
        </div>
      )}
      <div className="message-text" dir="auto">
        {message.role === 'user' ? (
          message.text
        ) : (
          <Streamdown
            animated={false}
            components={mobileMarkdownComponents}
            controls={false}
            isAnimating={Boolean(message.streaming)}
            skipHtml
          >
            {message.text}
          </Streamdown>
        )}
      </div>
      {message.delivery && (
        <small className="delivery-status" role="status">
          {message.delivery === 'pending' ? tr('提交中…') : tr('送达状态待确认')}
        </small>
      )}
      {message.role === 'assistant' && message.text && !message.streaming && (
        <div className="message-actions">
          <Button
            aria-label={copied ? tr('已复制') : tr('复制回复')}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(message.text)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              } catch {
                setCopyError(true)
              }
            }}
            variant="text"
          >
            {copied ? tr('已复制') : tr('复制')}
          </Button>
          {copyError && <span role="status">{tr('无法访问剪贴板，请长按文字复制')}</span>}
        </div>
      )}
    </article>
  )
}

function ControlCard({ request, controller }: { request: ServerRequest; controller: MobileController }) {
  const params = request.params as Record<string, unknown>

  if (request.method === 'approval') {
    return (
      <section aria-label={tr('操作确认')} className="control-card">
        <ShieldCheck size={20} />
        <h3>{tr('需要你的确认')}</h3>
        <p>
          {tr('所属会话：')}
          {String(params.session_id || tr('未知会话'))}
        </p>
        <p>{String(params.description || tr('确认后才会执行以下操作。'))}</p>
        <pre>{String(params.command || '')}</pre>
        <div>
          <Button onClick={() => controller.respond(request, { choice: 'deny' })} variant="outline">
            {tr('拒绝')}
          </Button>
          <Button
            disabled={
              !String(params.command || '').trim() ||
              (Array.isArray(params.choices) && !params.choices.includes('once'))
            }
            onClick={() => controller.respond(request, { choice: 'once' })}
          >
            {tr('仅允许这一次')}
          </Button>
        </div>
      </section>
    )
  }

  // Complex/multi-question answers stay in Desktop until this surface has the complete contract.
  return (
    <section className="control-card">
      <h3>{tr('需要补充信息')}</h3>
      <p>
        {tr('所属会话：')}
        {String(params.session_id || tr('未知会话'))}
      </p>
      <p>{tr('请在 Desktop 中完成此确认。本端不会自动回答或批准。')}</p>
    </section>
  )
}

export function MobileApp({ controller }: { controller: MobileController }) {
  const locale = useWebLocale()
  useEffect(() => syncDocumentLocale(locale), [locale])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const wide = useMediaQuery('(min-width: 1024px) and (min-height: 540px)')
  const [navigationCollapsed, setNavigationCollapsed] = useNavigationCollapsed()
  const reduced = useReducedMotion()
  const drag = useDragControls()
  const [drawer, setDrawer] = useState(false)

  const [dark, setDark] = useState(
    () =>
      saved('hermes-web:appearance') === 'dark' ||
      (!saved('hermes-web:appearance') && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  )

  const [draft, setDraft] = useState('')
  const [localError, setLocalError] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const stick = useRef(true)
  const draftScope = draftKey(controller.profile, state.conversation?.storedId ?? null)
  const draftScopeRef = useRef(draftScope)
  const draftRef = useRef('')
  const navigation = useRef(0)
  useLayoutEffect(() => {
    if (draftScopeRef.current !== draftScope) {
      save(draftScopeRef.current, draftRef.current)
    }

    draftScopeRef.current = draftScope
    const value = saved(draftScope)
    draftRef.current = value
    setDraft(value)
  }, [draftScope])
  useEffect(() => () => save(draftScopeRef.current, draftRef.current), [])
  useEffect(() => {
    void controller.connect()

    const wake = () => {
      void controller.wake()
    }

    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('pageshow', wake)

    return () => {
      window.removeEventListener('online', wake)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('pageshow', wake)
    }
  }, [controller])
  useEffect(() => {
    document.documentElement.classList.toggle('dark', Boolean(dark))
    document.documentElement.dataset.mobileAppearance = dark ? 'dark' : 'light'
    save('hermes-web:appearance', dark ? 'dark' : 'light')
    window.dispatchEvent(new Event('hermes-web-theme'))
  }, [dark])
  useEffect(() => {
    const update = () => {
      const geometry = viewportGeometry(window.innerHeight, window.visualViewport)
      document.documentElement.style.setProperty('--mobile-height', `${geometry.height}px`)
      document.documentElement.style.setProperty('--mobile-top', `${geometry.top}px`)
    }

    update()
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)

    return () => {
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  useLayoutEffect(() => {
    const el = textarea.current

    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`
    }
  }, [draft])
  useLayoutEffect(() => {
    if (stick.current && scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight
    }
  }, [state.conversation?.messages, state.controls, state.opening])
  useEffect(() => {
    if (wide) {
      setDrawer(false)
    }
  }, [wide])

  const changeDraft = (value: string) => {
    draftRef.current = value
    setDraft(value)
    save(draftScopeRef.current, value)
  }

  const open = (row: SessionRow) => {
    navigation.current++
    save(draftScopeRef.current, draftRef.current)
    setDrawer(false)
    stick.current = true
    setAtBottom(true)
    void controller.open(row.id)
  }

  const newChat = () => {
    navigation.current++
    save(draftScopeRef.current, draftRef.current)
    controller.newChat()
    setDrawer(false)
    stick.current = true
    setAtBottom(true)
  }

  const submit = async (event?: FormEvent, queue = false) => {
    event?.preventDefault()

    if (composing.current || !draft.trim()) {
      return
    }

    const submitted = draft
    const key = draftScopeRef.current
    const epoch = navigation.current
    const wasNew = !state.conversation

    const sent = await controller.send(submitted, queue ? 'queue' : 'normal')

    if (sent) {
      if (saved(key) === submitted) {
        save(key, '')
      }

      if (draftScopeRef.current === key && draftRef.current === submitted) {
        changeDraft('')
      }

      stick.current = true
      setAtBottom(true)
    } else if (wasNew && epoch === navigation.current && !draftRef.current) {
      changeDraft(submitted)
    }
  }

  const sidebar = (
    <SessionList controller={controller} onNew={newChat} onOpen={open} selected={state.conversation?.storedId} />
  )

  const ready = state.connection === 'ready'
  const busy = state.conversation?.running

  return (
    <div className="hermes-mobile">
      <div className="web-backdrop">
        <BackdropImage />
      </div>
      {wide ? (
        <ResizableSidebar collapsed={navigationCollapsed}>{sidebar}</ResizableSidebar>
      ) : (
        <Dialog.Root onOpenChange={setDrawer} open={drawer}>
          <Dialog.Portal>
            <Dialog.Overlay className="drawer-overlay" />
            <Dialog.Content asChild>
              <motion.aside
                animate={{ x: 0 }}
                className="mobile-drawer"
                drag="x"
                dragConstraints={{ left: 0, right: 0 }}
                dragControls={drag}
                dragElastic={locale === 'ar' ? { left: 0.03, right: 0.8 } : { left: 0.8, right: 0.03 }}
                dragListener={false}
                initial={reduced ? false : { x: locale === 'ar' ? '100%' : '-100%' }}
                onDragEnd={(_, info) => {
                  if (
                    locale === 'ar'
                      ? info.offset.x > 80 || info.velocity.x > 600
                      : info.offset.x < -80 || info.velocity.x < -600
                  ) {
                    setDrawer(false)
                  }
                }}
                transition={{ type: 'spring', stiffness: 420, damping: 40 }}
              >
                <Dialog.Title className="sr-only">{tr('会话导航')}</Dialog.Title>
                <Dialog.Description className="sr-only">{tr('查找、搜索并打开已有会话')}</Dialog.Description>
                <div className="drawer-handle" onPointerDown={e => drag.start(e)}>
                  <span>{tr('向左拖动收起')}</span>
                  <Dialog.Close asChild>
                    <Button aria-label={tr('关闭会话列表')} className="mobile-icon" size="icon" variant="ghost">
                      <X />
                    </Button>
                  </Dialog.Close>
                </div>
                {sidebar}
              </motion.aside>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
      <main aria-label={tr('Hermes 聊天')} className="chat-main">
        <header className="chat-header">
          <div>
            <IconButton
              controls={wide ? 'web-session-sidebar' : undefined}
              expanded={wide ? !navigationCollapsed : drawer}
              label={wide && !navigationCollapsed ? tr('收起会话列表') : tr('打开会话列表')}
              onClick={() => (wide ? setNavigationCollapsed(!navigationCollapsed) : setDrawer(true))}
            >
              <PanelLeft />
            </IconButton>
            <div className="header-title">
              <strong>{state.conversation?.title || tr('新对话')}</strong>
              <span>
                <i className={`connection-dot ${ready ? 'connected' : ''}`} />
                {ready
                  ? tr('已连接 GA401')
                  : state.connection === 'signin'
                    ? tr('需要登录')
                    : state.connection === 'connecting'
                      ? tr('连接中…')
                      : tr('连接已断开，任务可能仍在运行')}
              </span>
            </div>
          </div>
          <div>
            <AppearanceSettings />
            <IconButton label={dark ? tr('切换浅色') : tr('切换深色')} onClick={() => setDark(!dark)}>
              {dark ? <Sun /> : <Moon />}
            </IconButton>
            <IconButton label={tr('新建对话')} onClick={newChat}>
              <Plus />
            </IconButton>
          </div>
        </header>
        {state.connection === 'signin' && (
          <div className="connection-banner" role="status">
            <ShieldCheck size={18} />
            <span>{tr('安全连接到你的 Hermes，沿用现有登录。')}</span>
            <a href="/login?next=%2Fmobile%2F">{tr('登录')}</a>
          </div>
        )}
        {['offline', 'failed'].includes(state.connection) && (
          <div className="connection-banner" role="status">
            <WifiOff size={18} />
            <span>{tr('未连接。草稿已保留，不会自动重发消息。')}</span>
            <Button onClick={() => void controller.connect()} variant="text">
              {tr('重连')}
            </Button>
          </div>
        )}
        {(state.error || localError) && (
          <div className="error-banner" role="alert">
            {tr(localError || state.error || '')}
            <IconButton label={tr('关闭提示')} onClick={() => setLocalError('')}>
              <X />
            </IconButton>
          </div>
        )}
        {state.uncertain && (
          <div className="connection-banner uncertain" role="alert">
            <span>{tr('上一条消息的送达状态待确认。请先检查会话，避免重复执行。')}</span>
            <Button
              onClick={() => {
                void controller.refreshConversation()
              }}
              variant="text"
            >
              {tr('检查会话')}
            </Button>
            <Button onClick={() => controller.acknowledgeUncertain()} variant="text">
              {tr('我已核对')}
            </Button>
          </div>
        )}
        <div
          className="transcript"
          onScroll={e => {
            const el = e.currentTarget
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
            stick.current = bottom
            setAtBottom(bottom)
          }}
          ref={scroll}
        >
          <div className="thread-content">
            {state.opening && (
              <div className="history-loading" role="status">
                {tr('正在恢复对话…')}
              </div>
            )}
            {!state.conversation && !state.opening && (
              <div className="welcome">
                <BrandLogo className="welcome-mark" />
                <h1>{tr('新对话')}</h1>
                <p>
                  {tr('同一个 Hermes，不同的屏幕。')}
                  <br />
                  {tr('打开一段对话，或从这里开始。')}
                </p>
                <div className="welcome-actions">
                  <Button
                    onClick={() =>
                      wide
                        ? (setNavigationCollapsed(false),
                          requestAnimationFrame(() =>
                            document.querySelector<HTMLInputElement>('[data-mobile-search]')?.focus()
                          ))
                        : setDrawer(true)
                    }
                    variant="outline"
                  >
                    <MessageSquare size={17} />
                    {tr('继续已有对话')}
                    <ArrowLeft className="reverse-arrow" size={16} />
                  </Button>
                </div>
                <div className="welcome-note">
                  <ShieldCheck size={14} />
                  {tr('连接你的 GA401 · 不另建一套 Agent')}
                </div>
              </div>
            )}
            {state.conversation?.messages.map(message => (
              <MessageBody key={message.id} message={message} />
            ))}
            {state.controls.map(request => (
              <ControlCard controller={controller} key={String(request.id)} request={request} />
            ))}
            {busy && (
              <div className="working-state" role="status">
                <span className="activity-dot pulsing" />
                {tr('Hermes 正在处理')}
                <span>{tr('你可以继续输入，或停止当前任务。')}</span>
              </div>
            )}
          </div>
        </div>
        {!atBottom && (
          <Button
            className="jump-bottom"
            onClick={() => {
              stick.current = true
              setAtBottom(true)
              scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: reduced ? 'instant' : 'smooth' })
            }}
            variant="outline"
          >
            <ArrowDown size={16} />
            {tr('回到最新')}
          </Button>
        )}
        <footer className="composer-dock">
          <div className="composer-width">
            {state.queued > 0 && (
              <p className="queue-note" role="status">
                {tr('有已提交的排队消息；以服务器会话记录为准。')}
              </p>
            )}
            <form
              className="composer"
              onSubmit={e => {
                void submit(e, Boolean(busy))
              }}
            >
              <textarea
                aria-label={tr('消息')}
                dir="auto"
                onChange={e => changeDraft(e.target.value)}
                onCompositionEnd={() => {
                  composing.current = false
                }}
                onCompositionStart={() => {
                  composing.current = true
                }}
                onKeyDown={e => {
                  if (shouldSubmitKey(e.nativeEvent, composing.current)) {
                    e.preventDefault()
                    void submit(undefined, Boolean(busy))
                  }
                }}
                placeholder={
                  ready
                    ? tr('发消息给 Hermes…')
                    : state.connection === 'signin'
                      ? tr('登录后即可发送，草稿会保留…')
                      : tr('可以先写下想法，连接后发送…')
                }
                ref={textarea}
                rows={1}
                value={draft}
              />
              <div className="composer-toolbar">
                <div>
                  <IconButton disabled label={tr('图片发送尚未启用')}>
                    <Paperclip />
                  </IconButton>
                  <span className="model-label">{state.conversation?.model || tr('沿用后端默认模型')}</span>
                </div>
                <div>
                  {busy && (
                    <IconButton
                      disabled={!ready}
                      label={tr('停止当前任务')}
                      onClick={() => void controller.interrupt()}
                    >
                      <Square size={16} />
                    </IconButton>
                  )}
                  <Button
                    aria-label={busy ? tr('排队发送消息') : tr('发送消息')}
                    className="send-button"
                    disabled={!ready || !draft.trim() || state.sending || state.opening || Boolean(state.uncertain)}
                    type="submit"
                  >
                    {state.sending ? <RefreshCw className="spin" /> : <ArrowUp />}
                  </Button>
                </div>
              </div>
            </form>
            {state.conversation && (
              <div className="composer-caption" role="status">
                {tr(state.syncError || '跨端同步已保存消息；不镜像逐字输出。')}
              </div>
            )}
            <div className="composer-caption">
              <span>{busy ? tr('发送将排队，不打断当前任务') : tr('回车换行 · ⌘ / Ctrl + Enter 发送')}</span>
              <span>
                {tr('私人连接')}
                <span className="caption-dot">·</span>Hermes Web
              </span>
            </div>
          </div>
        </footer>
      </main>
    </div>
  )
}
