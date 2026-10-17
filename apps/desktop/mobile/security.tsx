import { ShieldCheck, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { type FormEvent, useEffect, useRef, useState } from 'react'

import { Button } from '../src/components/ui/button'

import type { BrowserApi } from './browser-api'
import { tr } from './localization'

interface HeldTask {
  session_key: string
  title: string
}
interface SecurityRequest {
  id: string
  method: 'approval' | 'sudo'
  params: { session_id: string; command?: string; description?: string; choices?: string[] }
}
interface SecuritySnapshot {
  generation: string
  backend: string
  profile: string
  session_key: string
  runtime_id: string
  requests: SecurityRequest[]
}

function SecurityCard({
  request,
  answer
}: {
  request: SecurityRequest
  answer: (request: SecurityRequest, result: { choice: string } | { value: string }) => void
}) {
  const password = useRef<HTMLInputElement>(null)
  const submitted = useRef(false)
  const [busy, setBusy] = useState(false)

  const send = (result: { choice: string } | { value: string }) => {
    if (submitted.current) {
      return
    }
    submitted.current = true
    setBusy(true)
    answer(request, result)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const input = password.current

    if (!input || !input.value || submitted.current) {
      return
    }
    const value = input.value
    input.value = ''
    send({ value })
  }

  useEffect(() => {
    const input = password.current

    return () => {
      if (input) {
        input.value = ''
      }
    }
  }, [])
  const command = typeof request.params.command === 'string' ? request.params.command : ''

  return (
    <section
      aria-label={tr(request.method === 'sudo' ? 'sudo 认证' : '操作确认')}
      className="control-card security-card"
    >
      <h3>{tr(request.method === 'sudo' ? 'sudo 认证' : '需要你的确认')}</h3>
      <p>{request.params.description}</p>
      <pre>{command || tr('命令信息缺失，不能批准。')}</pre>
      <small>
        {tr('请求：')}
        {request.id}
      </small>
      {request.method === 'sudo' ? (
        <form autoComplete="off" onSubmit={submit}>
          <label>
            {tr('sudo 密码')}
            <input
              autoCapitalize="none"
              autoComplete="off"
              disabled={busy || !command.trim()}
              enterKeyHint="done"
              maxLength={4096}
              ref={password}
              spellCheck={false}
              type="password"
            />
          </label>
          <p>{tr('仅直接交给原执行后端，不会写入聊天或保存。')}</p>
          <div className="security-actions">
            <Button
              disabled={busy}
              onClick={() => {
                if (password.current) {
                  password.current.value = ''
                }
                send({ value: '' })
              }}
              type="button"
              variant="outline"
            >
              {tr('取消认证')}
            </Button>
            <Button disabled={busy || !command.trim()} type="submit">
              {tr('提交 sudo 密码')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="security-actions">
          <Button disabled={busy} onClick={() => send({ choice: 'deny' })} variant="outline">
            {tr('拒绝')}
          </Button>
          <Button
            disabled={busy || !command.trim() || (request.params.choices && !request.params.choices.includes('once'))}
            onClick={() => send({ choice: 'once' })}
          >
            {tr('仅允许这一次')}
          </Button>
        </div>
      )}
    </section>
  )
}

function sameConnection(previous: SecuritySnapshot | null, next: SecuritySnapshot) {
  return (
    !previous ||
    (previous.generation === next.generation &&
      previous.backend === next.backend &&
      previous.runtime_id === next.runtime_id)
  )
}

function isSnapshotFor(data: SecuritySnapshot & { type: string }, sessionKey: string) {
  return (
    data.type === 'snapshot' &&
    data.profile === 'default' &&
    data.session_key === sessionKey &&
    typeof data.generation === 'string' &&
    Boolean(data.generation) &&
    typeof data.backend === 'string' &&
    typeof data.runtime_id === 'string' &&
    Array.isArray(data.requests)
  )
}

function isBoundRequest(request: SecurityRequest, runtime: string) {
  return (
    typeof request.id === 'string' &&
    ['approval', 'sudo'].includes(request.method) &&
    request.params?.session_id === runtime
  )
}

function SecurityWatch({ api, task }: { api: BrowserApi; task: HeldTask }) {
  const [snapshot, setSnapshot] = useState<SecuritySnapshot | null>(null)
  const [notice, setNotice] = useState('正在核对原执行后端…')
  const current = useRef<SecuritySnapshot | null>(null)
  const socket = useRef<WebSocket | null>(null)
  const sent = useRef(new Set<string>())
  const deadlines = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const fail = useRef(() => {})
  useEffect(() => {
    let alive = true
    let freshness: ReturnType<typeof setTimeout>

    const refreshed = () => {
      clearTimeout(freshness)
      freshness = setTimeout(() => fail.current(), 15_000)
    }

    const disconnect = () => {
      clearTimeout(freshness)
      current.current = null
      const ws = socket.current
      socket.current = null
      ws?.close()

      for (const timer of deadlines.current.values()) {
        clearTimeout(timer)
      }
      deadlines.current.clear()
    }

    fail.current = () => {
      if (!alive) {
        return
      }
      alive = false
      disconnect()
      setSnapshot(null)
      setNotice('安全连接已结束；已清空输入，不会自动重发。请重新选择任务。')
    }

    refreshed()
    void api
      .socketUrl('/api/plugins/neo-mobile-web/security/ws')
      .then(url => {
        if (!alive) {
          return
        }
        const target = new URL(url)

        if (target.protocol !== 'wss:' && !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
          fail.current()

          return
        }

        const ws = new WebSocket(url)
        socket.current = ws

        ws.onopen = () => {
          if (alive && socket.current === ws) {
            ws.send(JSON.stringify({ session_key: task.session_key }))
          }
        }

        ws.onmessage = event => {
          if (!alive || socket.current !== ws) {
            return
          }

          try {
            refreshed()
            const data = JSON.parse(event.data)

            if (data.type === 'answer') {
              if (!sent.current.has(data.id) || !['ok', 'expired'].includes(data.status)) {
                throw new Error()
              }
              clearTimeout(deadlines.current.get(data.id))
              deadlines.current.delete(data.id)
              setNotice(data.status === 'ok' ? '原后端已接收；命令结果请查看任务。' : '请求已结束或已由另一端处理。')
              setSnapshot(value => value && { ...value, requests: value.requests.filter(row => row.id !== data.id) })

              return
            }

            if (!isSnapshotFor(data, task.session_key)) {
              throw new Error()
            }

            const prior = current.current

            if (!sameConnection(prior, data)) {
              throw new Error()
            }

            if (data.requests.some((row: SecurityRequest) => !isBoundRequest(row, data.runtime_id))) {
              throw new Error()
            }

            if (
              prior &&
              data.requests.some((row: SecurityRequest) => {
                const original = prior.requests.find(previous => previous.id === row.id)

                return (
                  original &&
                  (original.method !== row.method ||
                    original.params.command !== row.params.command ||
                    original.params.description !== row.params.description ||
                    JSON.stringify(original.params.choices) !== JSON.stringify(row.params.choices))
                )
              })
            ) {
              throw new Error()
            }

            current.current = data
            setSnapshot({
              ...data,
              requests: data.requests.filter((row: SecurityRequest) => !sent.current.has(row.id))
            })

            if (!prior) {
              setNotice('已连接原执行后端；不会接管或重启任务。')
            }
          } catch {
            fail.current()
          }
        }

        ws.onclose = () => {
          if (socket.current === ws) {
            fail.current()
          }
        }

        ws.onerror = () => {
          if (socket.current === ws) {
            fail.current()
          }
        }
      })
      .catch(() => fail.current())

    return () => {
      alive = false
      disconnect()
    }
  }, [api, task.session_key])

  const answer = (request: SecurityRequest, result: { choice: string } | { value: string }) => {
    const bound = current.current
    const ws = socket.current

    if (
      !bound ||
      !ws ||
      ws.readyState !== 1 ||
      sent.current.has(request.id) ||
      !bound.requests.some(row => row.id === request.id && row.method === request.method)
    ) {
      return
    }

    sent.current.add(request.id)

    try {
      ws.send(JSON.stringify({ generation: bound.generation, id: request.id, result }))
      deadlines.current.set(
        request.id,
        setTimeout(() => fail.current(), 12_000)
      )
      setNotice('已提交，正在等待原后端确认；不会自动重发。')
    } catch {
      fail.current()
    }
  }

  return (
    <div className="security-watch">
      <h3>{task.title}</h3>
      <p className="security-identity">
        {tr('所属会话：')}
        {task.session_key}
      </p>
      <p role="status">{tr(notice)}</p>
      {snapshot && (
        <>
          <p className="security-identity">
            {tr('执行后端：')}
            {snapshot.backend}
          </p>
          <p className="security-identity">
            {tr('运行会话：')}
            {snapshot.runtime_id} · default
          </p>
          {!snapshot.requests.length && <p>{tr('当前没有待处理的审批或 sudo 请求。')}</p>}
          {snapshot.requests.map(request => (
            <SecurityCard answer={answer} key={`${snapshot.generation}:${request.id}`} request={request} />
          ))}
        </>
      )}
    </div>
  )
}

function SecurityBody({ api }: { api: BrowserApi }) {
  const [tasks, setTasks] = useState<HeldTask[]>([])
  const [task, setTask] = useState<HeldTask | null>(null)
  const [notice, setNotice] = useState('正在读取任务…')
  useEffect(() => {
    const abort = new AbortController()
    void api
      .request<{ sessions: HeldTask[] }>('/api/plugins/neo-mobile-web/security/sessions?profile=default', {
        signal: abort.signal
      })
      .then(data => {
        if (abort.signal.aborted) {
          return
        }
        setTasks(data.sessions)
        setNotice(data.sessions.length ? '选择原任务以处理安全请求，无需切换 PC 标签。' : '当前没有可核对的活动任务。')
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setNotice('安全请求入口不可用，请确认服务版本与登录状态。')
        }
      })

    return () => abort.abort()
  }, [api])

  return (
    <div className="security-body">
      {task ? (
        <>
          <Button onClick={() => setTask(null)} variant="outline">
            {tr('重新选择任务')}
          </Button>
          <SecurityWatch api={api} key={task.session_key} task={task} />
        </>
      ) : (
        <>
          <p role="status">{tr(notice)}</p>
          <div className="security-task-list">
            {tasks.map(row => (
              <Button key={row.session_key} onClick={() => setTask(row)} variant="outline">
                <span>
                  {row.title}
                  <small>{row.session_key}</small>
                </span>
              </Button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function SecurityPanel({ api, enabled }: { api: BrowserApi; enabled: boolean }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const hide = () => {
      if (document.hidden) {
        setOpen(false)
      }
    }
    const leave = () => setOpen(false)
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', leave)
    window.addEventListener('offline', leave)

    return () => {
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', leave)
      window.removeEventListener('offline', leave)
    }
  }, [])
  useEffect(() => {
    if (!enabled) {
      setOpen(false)
    }
  }, [enabled])

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger asChild>
        <Button aria-label={tr('安全请求')} className="mobile-icon" disabled={!enabled} size="icon" variant="ghost">
          <ShieldCheck />
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="appearance-overlay" />
        <Dialog.Content className="appearance-panel security-panel">
          <header className="appearance-header">
            <Dialog.Title>{tr('安全请求')}</Dialog.Title>
            <Dialog.Close asChild>
              <Button aria-label={tr('关闭安全请求')} className="mobile-icon" size="icon" variant="ghost">
                <X />
              </Button>
            </Dialog.Close>
          </header>
          <Dialog.Description className="security-description">
            {tr('核对任务、命令和执行后端后再操作。密码不会进入聊天。')}
          </Dialog.Description>
          {open && enabled && <SecurityBody api={api} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
