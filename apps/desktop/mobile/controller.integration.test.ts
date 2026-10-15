// Synthetic sockets, REAL MobileController / HermesGateway / shared channel.
// No network requests, actual approvals, credentials, or model invocations.
import { expect, it, vi } from 'vitest'

import { HermesGateway } from '../src/api/client'

import type { BrowserApi } from './browser-api'
import { MobileController } from './controller'

class Socket extends EventTarget {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 0
  sent: string[] = []
  constructor(_url: string) {
    super()
    Socket.instances.push(this)
  }
  send(text: string) {
    this.sent.push(text)
  }
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }
  frame(value: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
  }
  close() {
    this.readyState = 3
    this.dispatchEvent(new CloseEvent('close'))
  }
}

it('fences approval cards when the real gateway replaces a closing socket before its close event', async () => {
  Socket.instances = []
  vi.stubGlobal('WebSocket', Socket)

  const api = {
    socketUrl: vi.fn(async () => 'ws://synthetic.invalid/api/chat/ws'),
    request: vi.fn(async () => ({ sessions: [], total: 0 }))
  } as unknown as BrowserApi

  const controller = new MobileController(api, new HermesGateway())

  const frame = {
    jsonrpc: '2.0',
    id: 'synthetic-approval',
    method: 'approval',
    params: { session_id: 'synthetic', command: 'echo synthetic', choices: ['once', 'deny'] }
  }

  try {
    const initial = controller.connect()
    await vi.waitFor(() => expect(Socket.instances).toHaveLength(1))
    const old = Socket.instances[0]
    old.open()
    await initial
    old.frame(frame)
    const oldCard = controller.getSnapshot().controls[0]
    expect(oldCard).toBeTruthy()
    // A healthy connect reuses the actual transport and must retain valid cards.
    await controller.connect()
    expect(Socket.instances).toHaveLength(1)
    expect(controller.getSnapshot().controls).toContain(oldCard)
    // readyState can change before the queued browser close event is delivered.
    old.readyState = 2
    const reconnect = controller.connect()
    await vi.waitFor(() => expect(Socket.instances).toHaveLength(2))
    expect(controller.getSnapshot().controls).toHaveLength(0)
    const replacement = Socket.instances[1]
    replacement.open()
    await reconnect
    // Even a legitimate replay with the identical request ID cannot revive an old callback.
    replacement.frame(frame)
    const replayedCard = controller.getSnapshot().controls[0]
    expect(replayedCard).toBeTruthy()
    expect(replayedCard).not.toBe(oldCard)
    controller.respond(oldCard, { choice: 'once' })
    expect(replacement.sent.map(text => JSON.parse(text)).filter(f => f.id === frame.id)).toHaveLength(0)
    controller.respond(replayedCard, { choice: 'once' })
    expect(replacement.sent.map(text => JSON.parse(text)).filter(f => f.id === frame.id)).toEqual([
      { jsonrpc: '2.0', id: frame.id, result: { choice: 'once' } }
    ])
  } finally {
    controller.dispose()

    for (const socket of Socket.instances) {
      socket.close()
    }

    vi.unstubAllGlobals()
  }
})
