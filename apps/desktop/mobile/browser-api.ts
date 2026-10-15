export class SignInRequired extends Error {
  constructor() {
    super('登录已过期，请重新登录。')
    this.name = 'SignInRequired'
  }
}

/** Browser-only transport: no provider credentials, native tickets or arbitrary hosts. */
export class BrowserApi {
  constructor(private readonly origin = window.location.origin) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, this.origin)

    if (
      !path.startsWith('/api/') ||
      url.origin !== this.origin ||
      !url.pathname.startsWith('/api/') ||
      path.includes('\\')
    ) {
      throw new Error('Only same-origin Hermes API requests are supported')
    }

    const response = await fetch(url, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(60_000)
    })

    if (response.status === 401 || response.status === 403) {
      throw new SignInRequired()
    }

    if (!response.ok) {
      throw new Error(`Hermes 请求失败 (${response.status})`)
    }

    return response.json() as Promise<T>
  }

  async socketUrl(): Promise<string> {
    const { ticket } = await this.request<{ ticket: string }>('/api/auth/ws-ticket', { method: 'POST' })

    if (!ticket) {
      throw new Error('后端没有返回连接凭证')
    }

    const url = new URL('/api/ws', this.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('ticket', ticket)

    return url.toString()
  }
}
