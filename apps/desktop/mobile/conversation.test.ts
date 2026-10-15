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
