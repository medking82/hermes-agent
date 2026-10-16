import { latestSessionTodoSnapshot, parseTodoRevision, parseTodos, type TodoItem } from '../src/lib/todos'

export type LiveStatus = 'idle' | 'starting' | 'waiting' | 'working'
export const isLiveStatus = (value: unknown): value is LiveStatus =>
  value === 'idle' || value === 'starting' || value === 'waiting' || value === 'working'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  streaming?: boolean
  name?: string
  result?: unknown
  args?: unknown
  toolCallId?: string
  delivery?: 'pending' | 'unknown'
}
export interface Conversation {
  status?: LiveStatus
  liveId: string
  storedId: string
  title: string
  model: string
  running: boolean
  messages: Message[]
  todos?: TodoItem[]
  todoRevision?: number
  error?: string
}
export interface Snapshot {
  session_id: string
  todo_state?: unknown
  status?: unknown
  stored_session_id?: string
  resumed?: string
  queued?: { user: string } | null
  running?: boolean
  info?: { title?: string; model?: string; running?: boolean; cwd?: string }
  messages?: Array<{
    role: string
    content?: unknown
    text?: string
    display_kind?: string
    display_content?: unknown
    display_commentary?: unknown
    codex_message_items?: unknown
    id?: number
    tool_name?: string
    _row_id?: number
    tool_call_id?: string
    name?: string
  }>
  inflight?: { assistant?: string; user?: string; streaming?: boolean }
}
export interface EventFrame {
  type: string
  session_id?: string
  payload?: unknown
}

function messageText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .filter(p => p?.type === 'text')
    .map(p => p.text ?? '')
    .join('\n')
}

type HistoryRow = NonNullable<Snapshot['messages']>[number]

function publicFinalText(value: unknown): string {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return ''
    }
  }

  if (!Array.isArray(value)) {
    return ''
  }

  return value
    .flatMap(item => {
      if (!item || item.type !== 'message' || item.role !== 'assistant') {
        return []
      }

      const phase = typeof item.phase === 'string' ? item.phase.trim().toLowerCase() : item.phase

      if (phase != null && phase !== 'final' && phase !== 'final_answer') {
        return []
      }

      if (!Array.isArray(item.content)) {
        return []
      }

      return item.content
        .filter(
          (part: { type?: string; text?: unknown } | null) =>
            part?.type === 'output_text' && typeof part.text === 'string'
        )
        .map((part: { text: string }) => part.text)
        .join('')
    })
    .join('\n')
}

function displayText(row: HistoryRow): string {
  // An explicit display projection is authoritative, including intentional emptiness.
  const content = row.display_content !== undefined ? row.display_content : (row.content ?? row.text)
  let text = messageText(content)

  if (row.role === 'tool') {
    try {
      const value: unknown = JSON.parse(text)

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const fields = value as Record<string, unknown>
        const key = ['output', 'content', 'diff', 'text'].find(name => typeof fields[name] === 'string')

        if (key) {
          const { [key]: body, ...metadata } = fields

          return [body, Object.keys(metadata).length ? JSON.stringify(metadata, null, 2) : '']
            .filter(Boolean)
            .join('\n\n')
        }

        return JSON.stringify(value, null, 2)
      }
    } catch {
      /* Plain-text tool output is already displayable. */
    }

    return text
  }

  if (row.role !== 'assistant') {
    return text
  }

  if (row.display_content === undefined && !text.trim()) {
    text = publicFinalText(row.codex_message_items)
  }

  const commentary = Array.isArray(row.display_commentary)
    ? row.display_commentary.filter((part): part is string => typeof part === 'string' && Boolean(part.trim()))
    : []

  // Never promote reasoning, analysis or raw commentary-phase provider items.
  return [...commentary.filter(part => !text.includes(part)), text].filter(Boolean).join('\n\n')
}

export function fromSnapshot(snapshot: Snapshot): Conversation {
  const messages: Message[] = (snapshot.messages ?? [])
    .filter(row => ['user', 'assistant', 'tool'].includes(row.role) && row.display_kind !== 'hidden')
    .map((row, index) => ({
      id: String(row._row_id ?? row.id ?? `history-${index}`),
      role: row.role as Message['role'],
      text: displayText(row),
      name: row.name ?? row.tool_name,
      toolCallId: row.tool_call_id,
      ...(row.role === 'tool' ? { result: row.display_content !== undefined ? row.display_content : row.content } : {})
    }))
    .filter(message => message.role !== 'assistant' || Boolean(message.text.trim()))

  const todoState =
    parseTodos(snapshot.todo_state) !== null
      ? snapshot.todo_state
      : latestSessionTodoSnapshot(
          messages.map(message => ({
            parts:
              message.role === 'tool' ? [{ type: 'tool-call', toolName: message.name, result: message.result }] : []
          }))
        )

  if (snapshot.inflight?.assistant) {
    messages.push({
      id: 'stream',
      role: 'assistant',
      text: snapshot.inflight.assistant,
      streaming: Boolean(snapshot.running)
    })
  }

  return {
    liveId: snapshot.session_id,
    storedId: snapshot.stored_session_id ?? snapshot.resumed ?? snapshot.session_id,
    title: snapshot.info?.title || '新对话',
    model: snapshot.info?.model || '',
    status: isLiveStatus(snapshot.status) ? snapshot.status : undefined,
    running: Boolean(snapshot.running ?? snapshot.info?.running),
    ...(parseTodos(todoState) !== null
      ? { todos: parseTodos(todoState)!, todoRevision: parseTodoRevision(todoState) ?? undefined }
      : {}),
    messages
  }
}

export function applyEvent(state: Conversation, event: EventFrame): Conversation {
  if (event.session_id !== state.liveId) {
    return state
  }

  const payload = (event.payload ?? {}) as Record<string, unknown>

  if (event.type === 'todo.updated') {
    const todos = parseTodos(payload)
    const revision = parseTodoRevision(payload)

    if (todos === null || revision === null || revision < (state.todoRevision ?? 0)) {
      return state
    }

    return { ...state, todos, todoRevision: revision }
  }

  if (event.type === 'session.info') {
    return {
      ...state,
      ...(isLiveStatus(payload.status) ? { status: payload.status } : {}),
      ...(typeof payload.running === 'boolean' ? { running: payload.running } : {}),
      ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
      ...(typeof payload.title === 'string' && payload.title ? { title: payload.title } : {})
    }
  }

  if (event.type === 'message.start') {
    return { ...state, running: true, error: undefined }
  }

  if (event.type === 'message.delta') {
    if (typeof payload.text !== 'string' || !payload.text) {
      return state
    }

    const messages = [...state.messages]
    const last = messages.at(-1)

    if (last?.role === 'assistant' && last.streaming) {
      messages[messages.length - 1] = { ...last, text: last.text + payload.text }
    } else {
      messages.push({ id: `stream-${messages.length}`, role: 'assistant', text: payload.text, streaming: true })
    }

    return { ...state, running: true, messages }
  }

  if (event.type === 'message.interim' || event.type === 'message.complete') {
    const messages = [...state.messages]
    const last = messages.at(-1)
    const text = messageText(payload.text)

    if (last?.role === 'assistant' && last.streaming) {
      messages[messages.length - 1] = { ...last, text: text || last.text, streaming: false }
    } else if (text && !payload.response_reused) {
      messages.push({ id: `answer-${messages.length}`, role: 'assistant', text })
    }

    return { ...state, messages, error: typeof payload.error === 'string' ? payload.error : state.error }
  }

  if (event.type === 'tool.start') {
    const messages = state.messages.map(m => (m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m))
    const toolId = payload.tool_id ?? payload.tool_call_id
    const baseId = `tool-${toolId ?? messages.length}`
    let id = baseId
    let suffix = messages.length

    while (messages.some(message => message.id === id)) {
      id = `${baseId}-${suffix++}`
    }

    return {
      ...state,
      messages: [
        ...messages,
        {
          id,
          toolCallId: toolId == null ? undefined : String(toolId),
          role: 'tool',
          name: String(payload.name ?? payload.tool ?? '工具'),
          args: payload.args,
          text: String(payload.args_text ?? ''),
          streaming: true
        }
      ]
    }
  }

  if (event.type === 'tool.complete') {
    const name = String(payload.name ?? payload.tool ?? '工具')
    let index = state.messages.findLastIndex(m => m.role === 'tool' && m.streaming && m.name === name)

    if (payload.tool_id != null || payload.tool_call_id != null) {
      const toolId = String(payload.tool_id ?? payload.tool_call_id)

      const matches = (message: Message) => message.role === 'tool' && message.toolCallId === toolId

      index = state.messages.findLastIndex(message => message.streaming && matches(message))

      if (index < 0) {
        // A resumed unfinished receipt has no result yet. Never replace completed
        // history just because a later turn reused its native ID.
        index = state.messages.findLastIndex(
          message => matches(message) && !message.text.trim() && (message.result == null || message.result === '')
        )
      }
    }

    if (index < 0) {
      return state
    }

    const messages = [...state.messages]
    messages[index] = {
      ...messages[index],
      streaming: false,
      result: payload.result ?? payload.result_text,
      text: displayText({
        role: 'tool',
        content:
          typeof (payload.result_text ?? payload.result) === 'string'
            ? (payload.result_text ?? payload.result)
            : JSON.stringify(payload.result ?? '')
      })
    }

    return { ...state, messages }
  }

  return state
}
