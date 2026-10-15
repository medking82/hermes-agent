import type { ServerRequest } from '@hermes/shared'

import type { PromptSubmitParams } from '../../shared/src/gateway-contract.generated'
import { HermesGateway } from '../src/api/client'

import { BrowserApi, SignInRequired } from './browser-api'
import { applyEvent, type Conversation, fromSnapshot, type Snapshot } from './conversation'

export interface SessionRow {
  id: string
  title?: string | null
  preview?: string
  cwd?: string | null
  git_repo_root?: string | null
  model?: string | null
  last_active?: number
  started_at?: number
  is_active?: boolean
}
export interface MobileState {
  connection: 'connecting' | 'ready' | 'offline' | 'signin' | 'failed'
  sessions: SessionRow[]
  total: number
  listLoading: boolean
  listError?: string
  opening: boolean
  sending: boolean
  conversation: Conversation | null
  error?: string
  uncertain?: string
  queued: number
  controls: ServerRequest[]
  syncError?: string
}
export class MobileController {
  private state: MobileState = {
    connection: 'connecting',
    sessions: [],
    total: 0,
    listLoading: false,
    opening: false,
    sending: false,
    conversation: null,
    queued: 0,
    controls: []
  }
  private listeners = new Set<() => void>()
  private openGeneration = 0
  private listGeneration = 0
  private attempt = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private watchTimer?: ReturnType<typeof setTimeout>
  private watching = false
  private savedVersion?: { storedId: string; stamp: string; fetchedAt: number }
  private connecting = false
  private disposed = false
  private unsupportedAuthority = false
  private readonly off: Array<() => void>
  readonly profile = 'default'

  constructor(
    readonly api = new BrowserApi(),
    private readonly gateway = new HermesGateway()
  ) {
    this.off = [
      gateway.onAny(event => {
        if (event.type === 'gateway.ready' && (event.payload as { session_authority?: boolean })?.session_authority) {
          this.unsupportedAuthority = true
          clearTimeout(this.reconnectTimer)
          this.update({
            connection: 'failed',
            error: '后端使用共享会话协议，本候选版暂不支持；没有提交任务。请继续使用 Desktop。'
          })
          this.gateway.close()

          return
        }

        const current = this.state.conversation

        if (!current) {
          return
        }

        const next = applyEvent(current, event)

        if (next !== current) {
          this.update({ conversation: next })
        }

        if (event.type === 'message.complete' && event.session_id === current.liveId) {
          // Completion precedes the authoritative idle event. A single read closes that race.
          void this.refreshConversation().catch(error => this.fail(error))
          void this.loadSessions()
        }
      }),
      gateway.onState(status => {
        // A real transport replacement enters connecting before attach, even if the old
        // socket's close event is still queued. Healthy connect() reuse emits no transition.
        if (status === 'connecting') {
          this.update({ controls: [] })
        }

        if ((status === 'closed' || status === 'error') && !this.disposed && !this.unsupportedAuthority) {
          this.update({ connection: 'offline', controls: [] })
          this.scheduleReconnect()
        }
      }),
      gateway.onRequest(request => {
        this.update({ controls: [...this.state.controls.filter(c => c.id !== request.id), request] })

        return true
      })
    ]
  }
  getSnapshot = (): MobileState => this.state
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)

    return () => {
      this.listeners.delete(fn)
    }
  }
  private update(patch: Partial<MobileState>) {
    if (this.disposed) {
      return
    }

    this.state = { ...this.state, ...patch }

    for (const fn of this.listeners) {
      fn()
    }
  }
  private fail(error: unknown) {
    this.update(
      error instanceof SignInRequired
        ? { connection: 'signin', error: undefined }
        : { error: error instanceof Error ? error.message : '连接暂时不可用' }
    )
  }
  async connect() {
    if (this.disposed || this.connecting || this.unsupportedAuthority) {
      return
    }

    this.connecting = true
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    let transportReady = false
    this.update({ connection: 'connecting', error: undefined })

    try {
      const url = await this.api.socketUrl()

      if (this.disposed) {
        return
      }

      await this.gateway.connect(url)

      if (this.unsupportedAuthority) {
        return
      }

      if (this.disposed) {
        this.gateway.close()

        return
      }

      this.attempt = 0
      transportReady = true
      this.update({ connection: 'ready' })

      if (this.state.conversation) {
        await this.refreshConversation()
      }

      await this.loadSessions()
      this.scheduleWatch()
    } catch (error) {
      if (this.unsupportedAuthority) {
        return
      }

      this.fail(error)

      if (!transportReady && !(error instanceof SignInRequired)) {
        this.update({ connection: 'offline' })
        this.scheduleReconnect()
      }
    } finally {
      this.connecting = false
    }
  }
  private scheduleReconnect() {
    if (
      this.disposed ||
      this.unsupportedAuthority ||
      this.reconnectTimer ||
      this.state.connection === 'signin' ||
      document.hidden ||
      this.attempt >= 5
    ) {
      return
    }

    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = undefined
        void this.connect()
      },
      Math.min(1000 * 2 ** this.attempt++, 16_000)
    )
  }
  async wake() {
    if (document.hidden) {
      return
    }

    this.attempt = 0

    if (this.state.connection !== 'ready') {
      await this.connect()
    } else {
      try {
        await this.refreshConversation()
        await this.loadSessions()
      } catch (error) {
        this.fail(error)
      }
    }
  }
  async loadSessions(query = '', more = false) {
    const generation = ++this.listGeneration
    const offset = more ? this.state.sessions.length : 0
    this.update({ listLoading: true, listError: undefined })

    try {
      if (query.trim()) {
        const result = await this.api.request<{
          results: Array<{ session_id: string; title?: string; snippet: string; model?: string; last_active?: number }>
        }>(`/api/sessions/search?q=${encodeURIComponent(query)}&profile=${this.profile}`)

        if (generation !== this.listGeneration) {
          return
        }

        const rows = [
          ...new Map(
            result.results.map(r => [
              r.session_id,
              {
                id: r.session_id,
                title: r.title,
                preview: r.snippet.replace(/<[^>]*>/g, ''),
                model: r.model,
                last_active: r.last_active
              }
            ])
          ).values()
        ]

        this.update({ sessions: rows, total: rows.length })
      } else {
        const result = await this.api.request<{ sessions: SessionRow[]; total: number }>(
          `/api/sessions?profile=${this.profile}&limit=40&offset=${offset}&min_messages=0&archived=exclude&order=recent`
        )

        if (generation !== this.listGeneration) {
          return
        }

        this.update({
          sessions: [
            ...new Map([...(more ? this.state.sessions : []), ...result.sessions].map(s => [s.id, s])).values()
          ],
          total: result.total
        })
      }
    } catch (error) {
      if (generation === this.listGeneration) {
        this.update({ listError: error instanceof Error ? error.message : '会话加载失败' })

        if (error instanceof SignInRequired) {
          this.fail(error)
        }
      }
    } finally {
      if (generation === this.listGeneration) {
        this.update({ listLoading: false })
      }
    }
  }
  async open(storedId: string) {
    const generation = ++this.openGeneration
    this.update({ opening: true, sending: false, error: undefined })

    try {
      const snapshot = await this.gateway.request<Snapshot>('session.resume', {
        session_id: storedId,
        profile: this.profile,
        lazy: true,
        inline_images: false
      })

      if (generation !== this.openGeneration) {
        return
      }

      this.update({ conversation: fromSnapshot(snapshot), opening: false, queued: snapshot.queued ? 1 : 0 })
      this.restoreControls(snapshot)
      this.scheduleWatch()
    } catch (error) {
      if (generation === this.openGeneration) {
        this.update({ opening: false })
        this.fail(error)
      }
    }
  }
  newChat() {
    this.openGeneration++
    clearTimeout(this.watchTimer)
    this.update({
      conversation: null,
      opening: false,
      sending: false,
      error: undefined,
      syncError: undefined,
      queued: 0
    })
  }
  private scheduleWatch() {
    clearTimeout(this.watchTimer)

    if (this.disposed || !this.state.conversation || this.state.connection !== 'ready' || document.hidden) {
      return
    }

    this.watchTimer = setTimeout(() => void this.watchSavedConversation(), 3000)
  }
  private async watchSavedConversation() {
    const current = this.state.conversation

    if (this.disposed || this.watching || !current || this.state.connection !== 'ready' || document.hidden) {
      return
    }

    this.watching = true
    const generation = this.openGeneration

    try {
      // Read-only bounded REST projection: the live turn may belong to another process.
      // Polling must never resume a task, create an agent, or replay a submit.
      const metadata = await this.api.request<{
        message_count?: number
        last_active?: number
        ended_at?: number
        runtime_revision?: number
      }>(`/api/sessions/${encodeURIComponent(current.storedId)}?profile=${this.profile}`)

      if (this.disposed || generation !== this.openGeneration) {
        return
      }

      const stamp = JSON.stringify([
        metadata.message_count,
        metadata.last_active,
        metadata.ended_at,
        metadata.runtime_revision
      ])

      if (
        Number.isSafeInteger(metadata.message_count) &&
        this.savedVersion?.storedId === current.storedId &&
        this.savedVersion.stamp === stamp &&
        Date.now() - this.savedVersion.fetchedAt < 15000
      ) {
        return
      }

      const page = await this.api.request<{ session_id: string; messages: NonNullable<Snapshot['messages']> }>(
        `/api/sessions/${encodeURIComponent(current.storedId)}/messages?profile=${this.profile}&limit=120&order=latest&include_compacted=true&inline_images=false`
      )

      if (!Array.isArray(page.messages)) {
        throw new Error('Invalid history response')
      }

      if (
        this.disposed ||
        generation !== this.openGeneration ||
        this.state.connection !== 'ready' ||
        current !== this.state.conversation ||
        this.state.opening ||
        this.state.sending ||
        current.messages.some(message => message.streaming || message.delivery)
      ) {
        return
      }

      const ids = page.messages.map(row => row.id ?? row._row_id)

      if (ids.some(id => !Number.isSafeInteger(id) || Number(id) <= 0)) {
        throw new Error('Invalid history identity')
      }

      const tail = fromSnapshot({ session_id: current.liveId, messages: page.messages }).messages
      const firstId = tail.find(message => current.messages.some(existing => existing.id === message.id))?.id
      const boundary = firstId === undefined ? -1 : current.messages.findIndex(message => message.id === firstId)
      const tailIds = new Set(ids.map(String))
      const prefix = ids.length < 120 || boundary < 0 ? [] : current.messages.slice(0, boundary)

      if (
        (ids.length === 120 && current.messages.length > 0 && boundary < 0) ||
        prefix.some(message => tailIds.has(message.id))
      ) {
        // IDs identify rows, not display positions. An unproven boundary needs a full snapshot.
        if (await this.refreshConversation()) {
          this.savedVersion = { storedId: current.storedId, stamp, fetchedAt: Date.now() }
          this.update({ syncError: undefined })
        }

        return
      }

      this.update({ conversation: { ...current, messages: [...prefix, ...tail] }, syncError: undefined })
      this.savedVersion = { storedId: current.storedId, stamp, fetchedAt: Date.now() }
    } catch (error) {
      if (generation === this.openGeneration && !this.disposed) {
        if (error instanceof SignInRequired) {
          this.fail(error)
        } else {
          this.update({ syncError: '读取跨端更新失败，稍后会重试。' })
        }
      }
    } finally {
      this.watching = false
      this.scheduleWatch()
    }
  }
  async refreshConversation() {
    const current = this.state.conversation

    if (!current || this.state.connection !== 'ready') {
      return
    }

    const generation = this.openGeneration

    const snapshot = await this.gateway.request<Snapshot>('session.resume', {
      session_id: current.storedId,
      profile: this.profile,
      lazy: true,
      inline_images: false
    })

    if (
      generation === this.openGeneration &&
      current === this.state.conversation &&
      this.state.connection === 'ready'
    ) {
      this.update({ conversation: fromSnapshot(snapshot) })
      this.restoreControls(snapshot)
      this.scheduleWatch()

      return true
    }

    return false
  }
  private restoreControls(snapshot: Snapshot) {
    const requests =
      (
        snapshot as Snapshot & {
          open_requests?: Array<{ id: string; method: string; params: Record<string, unknown> }>
        }
      ).open_requests ?? []

    // No synthetic approval responses; these are pending requests on this authenticated socket.
    if (!requests.length) {
      return
    }

    // Native requests are re-delivered by the shared transport; only disclose unresolved ones.
    this.update({ error: '此会话有待处理的确认。如果下方未出现操作卡，请在 Desktop 中处理。' })
  }
  async send(text: string, mode: 'normal' | 'queue' = 'normal') {
    if (
      this.state.connection !== 'ready' ||
      this.state.opening ||
      this.state.sending ||
      this.state.uncertain ||
      !text.trim()
    ) {
      return false
    }

    const generation = this.openGeneration
    this.update({ sending: true, error: undefined })
    let admitted = false
    let submissionId = ''

    try {
      submissionId = crypto.randomUUID()
      let conversation = this.state.conversation

      if (!conversation) {
        const created = await this.gateway.request<Snapshot>('session.create', {
          profile: this.profile,
          source: 'web',
          close_on_disconnect: false,
          idempotency_key: crypto.randomUUID()
        })

        if (generation !== this.openGeneration) {
          return false
        }

        conversation = fromSnapshot(created)
        this.update({ conversation })
      }

      // Never automatically retry a submit: loss of ACK is not proof of non-delivery.
      admitted = true

      if (mode !== 'queue') {
        this.update({
          conversation: {
            ...conversation,
            running: true,
            messages: [...conversation.messages, { id: submissionId, role: 'user', text, delivery: 'pending' }]
          }
        })
      }

      const result = await this.gateway.request<Record<string, unknown>>(
        'prompt.submit',
        {
          session_id: conversation.liveId,
          profile: this.profile,
          text,
          queued: mode === 'queue'
        } satisfies PromptSubmitParams,
        1_800_000
      )

      if (generation !== this.openGeneration) {
        return true
      }

      if (['queued', 'steered', 'redirected'].includes(String(result?.status)) || mode === 'queue') {
        const live = this.state.conversation!
        this.update({
          queued: result?.status === 'queued' || mode === 'queue' ? 1 : 0,
          error:
            result?.status === 'steered'
              ? '消息已作为当前任务的补充信息提交。'
              : result?.status === 'redirected'
                ? '消息已提交，当前任务已转向此请求。'
                : undefined,
          conversation: { ...live, messages: live.messages.filter(message => message.id !== submissionId) }
        })
      } else {
        const live = this.state.conversation!
        this.update({
          conversation: {
            ...live,
            messages: live.messages.map(message =>
              message.id === submissionId ? { ...message, delivery: undefined } : message
            )
          }
        })
      }

      return true
    } catch (error) {
      if (generation === this.openGeneration) {
        if (admitted) {
          this.update({ uncertain: text })
          const live = this.state.conversation

          if (live) {
            this.update({
              conversation: {
                ...live,
                messages: live.messages.map(message =>
                  message.id === submissionId ? { ...message, delivery: 'unknown' } : message
                )
              }
            })
          }
        }

        this.fail(error)
      }

      return false
    } finally {
      if (generation === this.openGeneration) {
        this.update({ sending: false })
      }
    }
  }
  acknowledgeUncertain() {
    this.update({ uncertain: undefined, error: undefined })
  }
  async interrupt() {
    const current = this.state.conversation

    if (!current || this.state.connection !== 'ready') {
      return
    }

    try {
      await this.gateway.request('session.interrupt', { session_id: current.liveId, profile: this.profile })
      await this.refreshConversation()
    } catch (error) {
      this.fail(error)
    }
  }
  respond(control: ServerRequest, result: Record<string, unknown>) {
    if (!control || this.state.connection !== 'ready' || !this.state.controls.includes(control)) {
      return
    }

    if (control.method === 'approval') {
      const choice = result.choice

      if (choice !== 'once' && choice !== 'deny') {
        return
      }

      if (
        choice === 'once' &&
        (!String(control.params.command ?? '').trim() ||
          (Array.isArray(control.params.choices) && !control.params.choices.includes('once')))
      ) {
        return
      }
    }

    control.respond(result)
    this.update({ controls: this.state.controls.filter(c => c.id !== control.id) })
  }
  dispose() {
    this.disposed = true
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.watchTimer)

    for (const off of this.off) {
      off()
    }

    this.gateway.close()
    this.listeners.clear()
  }
}
