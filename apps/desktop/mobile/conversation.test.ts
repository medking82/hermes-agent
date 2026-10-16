import { expect, it } from 'vitest'

import { applyEvent, type Conversation, fromSnapshot } from './conversation'

it('restores public output_text from Responses sidecars without exposing reasoning or raw commentary', () => {
  const state = fromSnapshot({
    session_id: 'live',
    messages: [
      {
        role: 'assistant',
        content: '',
        codex_message_items: JSON.stringify([
          {
            type: 'message',
            role: 'assistant',
            phase: 'analysis',
            content: [{ type: 'output_text', text: 'PRIVATE_REASONING' }]
          },
          {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'UNPROJECTED_COMMENTARY' }]
          },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PUBLIC_REPLY' }] }
        ])
      }
    ]
  })

  expect(state.messages.map(message => message.text)).toEqual(['PUBLIC_REPLY'])
})

it('renders structured tool output as readable text without losing failure metadata', () => {
  const state = fromSnapshot({
    session_id: 'live',
    messages: [
      {
        role: 'tool',
        tool_name: 'terminal',
        content: JSON.stringify({ output: 'LINE_ONE\nLINE_TWO', exit_code: 1 })
      }
    ]
  })

  expect(state.messages[0].name).toBe('terminal')
  expect(state.messages[0].text).toContain('LINE_ONE\nLINE_TWO')
  expect(state.messages[0].text).toContain('"exit_code": 1')
})

it('applies revisioned todo.updated and ignores stale or unrelated task snapshots', () => {
  const initial = fromSnapshot({
    session_id: 'live',
    todo_state: { revision: 4, todos: [{ id: 'one', content: '处理任务', status: 'in_progress' }] }
  })

  const event = { type: 'todo.updated', session_id: 'live', payload: { revision: 5, todos: [] } }
  const cleared = applyEvent(initial, event)
  expect(cleared.todos).toEqual([])
  expect(cleared.todoRevision).toBe(5)
  expect(
    applyEvent(cleared, {
      ...event,
      payload: { revision: 4, todos: [{ id: 'one', content: '过时任务', status: 'in_progress' }] }
    })
  ).toBe(cleared)
  expect(applyEvent(initial, { ...event, session_id: 'other' })).toBe(initial)
})

it('pairs tool_call_id-only concurrent receipts completing out of order', () => {
  let state = fromSnapshot({ session_id: 'live' })

  for (const tool_call_id of ['a', 'b']) {
    state = applyEvent(state, { type: 'tool.start', session_id: 'live', payload: { name: 'terminal', tool_call_id } })
  }

  for (const tool_call_id of ['b', 'a']) {
    state = applyEvent(state, {
      type: 'tool.complete',
      session_id: 'live',
      payload: { name: 'terminal', tool_call_id, result: { output: tool_call_id.toUpperCase() } }
    })
  }

  expect(state.messages.map(message => message.text)).toEqual(['A', 'B'])
  expect(state.messages.every(message => !message.streaming)).toBe(true)
})

it('pairs concurrent native tool_id receipts and preserves full arguments', () => {
  let state = fromSnapshot({ session_id: 'live' })
  state = applyEvent(state, {
    type: 'tool.start',
    session_id: 'live',
    payload: { name: 'terminal', tool_id: 'a', args: { command: 'first' } }
  })
  state = applyEvent(state, {
    type: 'tool.start',
    session_id: 'live',
    payload: { name: 'terminal', tool_id: 'b', args: { command: 'second' } }
  })
  expect(state.messages.filter(message => message.streaming).map(message => message.id)).toEqual(['tool-a', 'tool-b'])
  state = applyEvent(state, {
    type: 'tool.complete',
    session_id: 'live',
    payload: { name: 'terminal', tool_id: 'a', result: { output: 'FIRST_RESULT', exit_code: 0 } }
  })
  expect(state.messages[0].id).toBe('tool-a')
  expect(state.messages[0].streaming).toBe(false)
  expect(state.messages[0]).toMatchObject({ args: { command: 'first' } })
  expect(state.messages[0].text).toContain('FIRST_RESULT')
  expect(state.messages[1].streaming).toBe(true)
})

it.each(['tool_id', 'tool_call_id'])(
  'reuses %s without overwriting earlier tool results or render identities',
  field => {
    let state = fromSnapshot({
      session_id: 'live',
      messages: [{ id: 11, role: 'tool', tool_name: 'terminal', tool_call_id: 'a', content: 'OLD' }]
    })

    for (const output of ['FIRST', 'SECOND']) {
      state = applyEvent(state, {
        type: 'tool.start',
        session_id: 'live',
        payload: { [field]: 'a', name: 'terminal' }
      })
      state = applyEvent(state, {
        type: 'tool.complete',
        session_id: 'live',
        payload: { [field]: 'a', name: 'terminal', result: { output } }
      })
      expect(state.messages[0].text).toBe('OLD')
      expect(state.messages.at(-1)?.text).toContain(output)
      expect(state.messages.at(-1)?.streaming).toBe(false)
    }

    expect(state.messages[1].text).toContain('FIRST')
    expect(new Set(state.messages.map(message => message.id)).size).toBe(state.messages.length)
  }
)

it('does not alias generated render ids to an unknown native tool identity', () => {
  let state = fromSnapshot({ session_id: 'live' })
  state = applyEvent(state, { type: 'tool.start', session_id: 'live', payload: { tool_id: 'a', name: 'terminal' } })
  state = applyEvent(state, {
    type: 'tool.complete',
    session_id: 'live',
    payload: { tool_id: 'a', name: 'terminal', result: { output: 'FIRST' } }
  })
  state = applyEvent(state, { type: 'tool.start', session_id: 'live', payload: { tool_id: 'a', name: 'terminal' } })
  const generatedId = state.messages.at(-1)!.id.slice('tool-'.length)
  expect(generatedId).not.toBe('a')
  expect(
    applyEvent(state, {
      type: 'tool.complete',
      session_id: 'live',
      payload: { tool_id: generatedId, name: 'terminal', result: { output: 'WRONG' } }
    })
  ).toBe(state)

  const completed = applyEvent(state, {
    type: 'tool.complete',
    session_id: 'live',
    payload: { tool_id: 'a', name: 'terminal', result: { output: 'SECOND' } }
  })

  expect(completed.messages[0].text).toContain('FIRST')
  expect(completed.messages[1].text).toContain('SECOND')
  expect(completed.messages[1].streaming).toBe(false)
})

it('does not overwrite completed history when the reused-id tool start was missed', () => {
  const state = fromSnapshot({
    session_id: 'live',
    running: true,
    messages: [{ id: 11, role: 'tool', tool_name: 'terminal', tool_call_id: 'a', content: 'OLD' }]
  })

  const completed = applyEvent(state, {
    type: 'tool.complete',
    session_id: 'live',
    payload: { tool_id: 'a', name: 'terminal', result: { output: 'NEW' } }
  })

  expect(completed).toBe(state)
  expect(completed.messages[0].text).toBe('OLD')
})

it.each([0, ''])('matches falsy native ID %j without completing another same-name tool', nativeId => {
  let state = fromSnapshot({ session_id: 'live', messages: [] })

  for (const tool_id of [nativeId, 'other']) {
    state = applyEvent(state, { type: 'tool.start', session_id: 'live', payload: { name: 'terminal', tool_id } })
  }

  const updated = applyEvent(state, {
    type: 'tool.complete',
    session_id: 'live',
    payload: { name: 'terminal', tool_id: nativeId, result: { output: 'TARGET' } }
  })

  expect(updated.messages[0].text).toContain('TARGET')
  expect(updated.messages[0].streaming).toBe(false)
  expect(updated.messages[1].streaming).toBe(true)
  expect(updated.messages[1].text).toBe('')
})

it('updates a resumed tool receipt by native identity without overwriting a different tool', () => {
  const state = fromSnapshot({
    session_id: 'live',
    messages: [
      { id: 11, role: 'tool', tool_name: 'terminal', tool_call_id: 'a', content: '' },
      { id: 12, role: 'tool', tool_name: 'terminal', tool_call_id: 'b', content: 'KEEP_B' }
    ]
  })

  const updated = applyEvent(state, {
    type: 'tool.complete',
    session_id: 'live',
    payload: {
      name: 'terminal',
      tool_id: 'a',
      result: { output: 'RESTORED_A', exit_code: 0 }
    }
  })

  expect(updated.messages[0].id).toBe('11')
  expect(updated.messages[0].text).toContain('RESTORED_A')
  expect(updated.messages[1].text).toBe('KEEP_B')
})

it('carries the runtime session status from resume and live session.info events', () => {
  const state = fromSnapshot({ session_id: 'live', status: 'waiting', running: true } as never)
  expect(state.status).toBe('waiting')

  const working = applyEvent(state, {
    type: 'session.info',
    session_id: 'live',
    payload: { running: true, status: 'working' }
  })

  expect(working.status).toBe('working')
  expect(working.running).toBe(true)
  expect(applyEvent(state, { type: 'session.info', session_id: 'other', payload: { status: 'working' } })).toBe(state)
})

it('restores the latest confirmed revisioned Todo result from saved history', () => {
  const todos = [{ id: 'task', content: '历史任务', status: 'in_progress' }]

  const state = fromSnapshot({
    session_id: 'saved',
    messages: [{ role: 'tool', tool_name: 'todo_list', content: JSON.stringify({ todos, revision: 8 }) }]
  })

  expect(state.todos).toEqual(todos)
  expect(state.todoRevision).toBe(8)
})

const snapshot = {
  session_id: 'live',
  stored_session_id: 'saved',
  messages: [{ role: 'user', content: '你好' }],
  running: true,
  info: { model: 'existing-model' },
  inflight: { assistant: '正在处理', streaming: true }
}

it('restores running text from the server, without marking disconnection as a stopped task', () => {
  const state = fromSnapshot(snapshot)
  expect(state.running).toBe(true)
  expect(state.messages.at(-1)?.text).toBe('正在处理')
  expect(state.storedId).toBe('saved')
})
it('ignores events for other conversations and preserves interim commentary', () => {
  const state = fromSnapshot(snapshot)
  expect(applyEvent(state, { type: 'message.delta', session_id: 'other', payload: { text: 'wrong' } })).toBe(state)

  let next = applyEvent(state, {
    type: 'message.interim',
    session_id: 'live',
    payload: { text: '正在处理', already_streamed: true }
  })

  next = applyEvent(next, { type: 'message.delta', session_id: 'live', payload: { text: '完成' } })
  next = applyEvent(next, {
    type: 'message.complete',
    session_id: 'live',
    payload: { text: '完成', status: 'complete' }
  })
  expect(next.messages.filter(m => m.role === 'assistant').map(m => m.text)).toEqual(['正在处理', '完成'])
})
it('keeps a completed answer visible until the later idle bookend', () => {
  let state: Conversation = fromSnapshot(snapshot)
  state = applyEvent(state, {
    type: 'message.complete',
    session_id: 'live',
    payload: { text: '回答', status: 'complete' }
  })
  expect(state.messages.at(-1)?.text).toBe('回答')
  state = applyEvent(state, { type: 'session.info', session_id: 'live', payload: { running: false } })
  expect(state.running).toBe(false)
})

it('filters only empty assistant rows and preserves non-text user turns', () => {
  const state = fromSnapshot({
    session_id: 'live',
    messages: [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'SYNTHETIC_IMAGE' } }] },
      { role: 'assistant', content: '' }
    ]
  })

  expect(state.messages.map(row => row.role)).toEqual(['user'])
})
