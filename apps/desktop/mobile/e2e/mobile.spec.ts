import { readFile, writeFile } from 'node:fs/promises'

import { expect, type Page, test } from '@playwright/test'

// Test contexts deliberately choose Chinese; production follows the browser's language.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('hermes-web:locale:v1')) {
      localStorage.setItem('hermes-web:locale:v1', 'zh')
    }
  })
})

// SYNTHETIC FIXTURES: do not mistake these for real backend/model acceptance.
async function fixture(page: Page, long = false, rich = false) {
  let submits = 0
  let connections = 0

  let messages: Array<{ role: string; content: string; codex_message_items?: unknown }> = long
    ? Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: `测试夹具消息 ${i}：这是一段用于检查阅读位置和滚动的内容。\n\n第二段内容。`
      }))
    : [
        { role: 'user', content: '测试夹具：检查移动界面' },
        {
          role: 'assistant',
          content: '## 随时继续\n\n这是**测试夹具**，用于验证界面，不是真实模型结果。\n\n- 会话可恢复\n- 草稿不会丢失'
        }
      ]

  if (rich) {
    messages[messages.length - 1].content += '\n\n```ts\nconst value = 1\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |'
  }

  let running = false
  await page.route('**/api/auth/ws-ticket', route => route.fulfill({ json: { ticket: `fixture-${++connections}` } }))
  await page.route('**/api/sessions?*', route =>
    route.fulfill({
      json: {
        sessions: [
          {
            id: 'fixture-session',
            title: '测试夹具 · 移动体验',
            cwd: '/fixture/mobile',
            last_active: Date.now() / 1000,
            live_lease: true,
            preview: '会话与输入测试'
          },
          {
            id: 'fixture-elsewhere',
            title: '夹具 · 另一端持有',
            last_active: Date.now() / 1000,
            live_lease: true,
            preview: '租约标记'
          }
        ],
        total: 2
      }
    })
  )
  await page.route('**/api/sessions/search?*', route =>
    route.fulfill({
      json: {
        results: [
          { session_id: 'fixture-session', title: '测试夹具 · 移动体验', snippet: '搜索命中测试', model: 'fixture' }
        ]
      }
    })
  )
  await page.route('**/api/sessions/fixture-session?*', route =>
    route.fulfill({
      json: { id: 'fixture-session', message_count: messages.length, profile: 'default' }
    })
  )
  await page.route('**/api/sessions/fixture-session/messages?*', route =>
    route.fulfill({
      json: {
        session_id: 'fixture-session',
        profile: 'default',
        messages: messages.map((message, index) => ({ ...message, id: index + 1 }))
      }
    })
  )

  let emitNative: (type: string, payload: unknown) => void = () => {}
  let liveStatus: 'idle' | 'starting' | 'waiting' | 'working' = 'working'
  await page.routeWebSocket('**/api/ws?*', ws => {
    const event = (type: string, payload: unknown) =>
      ws.send(
        JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id: 'fixture-session', payload } })
      )

    emitNative = event
    ws.onMessage(raw => {
      const request = JSON.parse(String(raw))

      if (request.id === undefined) {
        return
      }

      let result: unknown = {}

      if (['session.resume', 'session.create'].includes(request.method)) {
        result = {
          session_id: 'fixture-session',
          stored_session_id: 'fixture-session',
          messages: messages.map((message, index) => ({ ...message, _row_id: index + 1 })),
          running,
          status: running ? 'working' : 'idle',
          info: { title: '测试夹具 · 移动体验', model: 'fixture-model' }
        }
      }

      if (request.method === 'session.events.since') {
        result = { events: [] }
      }

      if (request.method === 'session.active_list') {
        result = {
          sessions: [
            {
              current: false,
              id: 'fixture-live',
              last_active: Date.now() / 1000,
              message_count: 2,
              model: 'fixture-model',
              preview: '会话与输入测试',
              session_key: 'fixture-session',
              started_at: Date.now() / 1000,
              status: liveStatus,
              title: '测试夹具 · 移动体验'
            }
          ]
        }
      }

      if (request.method === 'prompt.submit') {
        submits++
        messages = [...messages, { role: 'user', content: request.params.text }]
        running = true
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { accepted: true } }))
        setTimeout(() => {
          event('message.start', {})
          event('message.delta', { text: '测试夹具回复：已收到。' })
          messages = [...messages, { role: 'assistant', content: '测试夹具回复：已收到。' }]
          running = false
          event('message.complete', { text: '测试夹具回复：已收到。', status: 'complete' })
          event('session.info', { running: false })
        }, 60)

        return
      }

      ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    })
  })

  return {
    replaceHistory: (rows: typeof messages) => {
      messages = rows
    },
    setLiveStatus: (status: 'idle' | 'starting' | 'waiting' | 'working') => {
      liveStatus = status
    },
    emit: (type: string, payload: unknown) => emitNative(type, payload),
    submits: () => submits,
    connections: () => connections,
    saveReply(text: string) {
      messages = [
        ...messages,
        {
          role: 'assistant',
          content: '',
          codex_message_items: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
        }
      ]
    }
  }
}

async function openSession(page: Page) {
  const opener = page.getByRole('button', { name: '打开会话列表' })

  if (await opener.isVisible()) {
    await opener.click()
  }

  await page.getByRole('button', { name: /测试夹具 · 移动体验/ }).click()
  await expect(page.getByRole('button', { name: '发送消息', exact: true }))
    .toBeEnabled({ timeout: 1000 })
    .catch(async () => {
      await page.getByRole('textbox', { name: '消息', exact: true }).fill('草稿')
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled()
      await page.getByRole('textbox', { name: '消息', exact: true }).fill('')
    })
  await expect(page.getByRole('status').filter({ hasText: '正在恢复对话' })).toHaveCount(0)
}

test('returns to the management Dashboard without submitting work', async ({ page }, info) => {
  const backend = await fixture(page)
  await page.route('**/sessions?profile=default', route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<main>Fixture Dashboard Destination</main>'
    })
  )
  await page.goto('/mobile/')
  await openSession(page)
  const exit = page.locator('.chat-header').getByRole('link', { name: '返回 Dashboard' })
  await expect(exit).toHaveAttribute('href', '/sessions?profile=default')

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 740 })
    await expect(exit).toBeInViewport()
    const box = await exit.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByRole('button', { name: '新建对话' })).toBeInViewport()
  }

  await page.getByRole('button', { name: '新建对话' }).click()
  await expect(page.locator('.welcome')).toBeVisible()
  const opener = page.getByRole('button', { name: '打开会话列表' })
  await opener.click()
  await expect(
    page.getByRole('dialog', { name: '会话导航' }).getByRole('link', { name: '返回 Dashboard' })
  ).toBeVisible()
  await page.getByRole('button', { name: '关闭会话列表' }).click()
  await page.screenshot({ path: info.outputPath('dashboard-return.png') })
  await exit.click()
  await expect(page).toHaveURL(/\/sessions\?profile=default$/)
  await expect(page.getByText('Fixture Dashboard Destination')).toBeVisible()
  expect(backend.submits()).toBe(0)
})

test('combines session filters without promoting backend leases to running', async ({ page }, info) => {
  const backend = await fixture(page)
  const now = Date.now() / 1000

  const rows = [
    {
      id: 'fixture-session',
      title: '测试夹具 · 筛选目标',
      cwd: '/fixture/mobile',
      source: 'desktop',
      last_active: now
    },
    {
      id: 'fixture-elsewhere',
      title: '测试夹具 · 仅后端连接',
      cwd: '/fixture/mobile',
      source: 'desktop',
      last_active: now,
      live_lease: true
    },
    { id: 'other-project', title: '测试夹具 · 其他项目', cwd: '/fixture/other', source: 'desktop', last_active: now },
    { id: 'cli-session', title: '测试夹具 · CLI来源', cwd: '/fixture/mobile', source: 'cli', last_active: now },
    {
      id: 'old-session',
      title: '测试夹具 · 较早会话',
      cwd: '/fixture/mobile',
      source: 'desktop',
      last_active: now - 40 * 86400
    }
  ]

  const metadataReads: string[] = []
  await page.route('**/api/sessions?*', route => route.fulfill({ json: { sessions: rows, total: rows.length } }))
  await page.route('**/api/sessions/search?*', route =>
    route.fulfill({
      json: {
        results: rows.map(({ cwd: _cwd, live_lease: _lease, ...row }) => ({
          ...row,
          session_id: row.id,
          snippet: '测试夹具 needle'
        }))
      }
    })
  )

  for (const row of rows) {
    await page.route(`**/api/sessions/${row.id}?*`, route => {
      metadataReads.push(row.id)

      return route.fulfill({ json: row })
    })
  }

  await page.goto('/mobile/')
  const opener = page.getByRole('button', { name: '打开会话列表' })

  if (await opener.isVisible()) {
    await opener.click()
  }

  await page.getByLabel('按项目筛选').selectOption('/fixture/mobile')
  await page.getByRole('searchbox', { name: '搜索会话' }).fill('needle')
  await expect.poll(() => new Set(metadataReads).size).toBe(5)
  await expect(page.getByLabel('按项目筛选')).toBeVisible()
  await page.locator('.session-filters > summary').click()
  await page.getByLabel('按来源筛选').selectOption('source:desktop')
  await page.getByLabel('按时间筛选').selectOption('today')
  await page.getByLabel('按状态筛选').selectOption('working')
  const list = page.locator('.session-scroll')
  await expect(list.getByRole('button', { name: /筛选目标/ })).toBeVisible()
  await expect(list.locator('.session-row')).toHaveCount(1)
  await expect(list.getByText('测试夹具 · 仅后端连接')).toHaveCount(0)
  await page.getByRole('button', { name: '清除筛选' }).click()
  await expect(page.getByRole('searchbox', { name: '搜索会话' })).toHaveValue('needle')
  await expect(list.locator('.session-row')).toHaveCount(5)
  await page.getByRole('searchbox', { name: '搜索会话' }).fill('')
  await expect(page.getByRole('status', { name: '后端已连接；运行状态未知' })).toHaveCount(1)
  await page.getByLabel('按状态筛选').selectOption('leased')
  await expect(list.getByText('测试夹具 · 仅后端连接')).toBeVisible()
  await expect(list.locator('.session-row')).toHaveCount(1)
  await expect(page.getByRole('status', { name: '会话运行中' })).toHaveCount(0)

  await expect.poll(() => list.evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(96)
  await expect(list.getByText('测试夹具 · 仅后端连接')).toBeInViewport()

  const geometry = await page
    .locator('.session-filters')
    .evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth }))

  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1)
  const touch = await page.getByLabel('按状态筛选').boundingBox()
  expect(touch?.height).toBeGreaterThanOrEqual(44)
  await page.screenshot({ path: `mobile/test-results/session-filters-${info.project.name}.png`, fullPage: true })
  await page.getByRole('button', { name: '清除筛选' }).click()
  await expect(page.getByRole('searchbox', { name: '搜索会话' })).toHaveValue('')
  await expect(list.locator('.session-row')).toHaveCount(5)
  expect(backend.submits()).toBe(0)
  await page.setViewportSize({ width: 568, height: 360 })
  await expect(page.locator('#web-session-sidebar')).toHaveCount(0)

  if (!(await page.getByRole('dialog', { name: '会话导航' }).isVisible())) {
    await opener.click()
  }

  const panel = page.locator('.session-filters')

  if (!(await panel.evaluate(node => (node as HTMLDetailsElement).open))) {
    await panel.locator('summary').click()
  }

  await expect.poll(() => list.evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(96)
  await list.locator('.session-row').first().scrollIntoViewIfNeeded()
  await expect(list.locator('.session-row').first()).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('renders stored uploads through same-origin media and opens the Desktop image lightbox', async ({
  page
}, info) => {
  const backend = await fixture(page)
  const path = '/home/fixture/.hermes/images/upload_fixture.png'
  backend.replaceHistory([{ role: 'user', content: `@image:${path}\n[screenshot]\n夹具：历史图片` }])
  const bytes = await readFile('mobile/public/hermes-icon.png')
  const mediaReads: string[] = []
  await page.route('**/api/fs/read-data-url?*', route => {
    mediaReads.push(route.request().url())

    return route.fulfill({ json: { dataUrl: `data:image/png;base64,${bytes.toString('base64')}` } })
  })
  await page.goto('/mobile/')
  await openSession(page)
  const image = page.getByRole('img', { name: '会话图片' })
  await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  expect(mediaReads.length).toBe(1)
  const query = new URL(mediaReads[0]).searchParams
  expect(query.get('path')).toBe(path)
  expect(query.get('session_id')).toBe('fixture-session')
  expect(query.get('profile')).toBe('default')
  await page.getByRole('button', { name: '查看图片' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.screenshot({ path: `mobile/test-results/parity-image-${info.project.name}.png`, fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('uses native tool receipts and revisioned task state in the same conversation', async ({ page }, info) => {
  const backend = await fixture(page)
  await page.goto('/mobile/')
  await openSession(page)

  for (let i = 0; i < 5; i++) {
    backend.emit('tool.start', { tool_id: `tool-${i}`, name: 'skill_view', args: { name: 'fixture' } })
    backend.emit('tool.complete', {
      tool_id: `tool-${i}`,
      name: 'skill_view',
      result: { output: `FIXTURE_OUTPUT_${i}` }
    })
  }

  const group = page.getByRole('button', { name: /5 项工具调用/ })
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await group.click()
  await expect(page.getByText('FIXTURE_OUTPUT_0', { exact: true })).toBeVisible()
  backend.emit('todo.updated', {
    revision: 3,
    todos: [
      { id: 'one', content: '夹具：已完成', status: 'completed' },
      { id: 'two', content: '夹具：当前工作', status: 'in_progress' },
      { id: 'three', content: '夹具：后续验收', status: 'pending', parent: 'two' }
    ]
  })
  await expect(page.getByRole('button', { name: /任务 1\/3/ })).toBeVisible()
  await expect(page.getByText('夹具：当前工作')).toBeVisible()
  backend.emit('message.delta', { text: '夹具：新的工具段' })
  backend.emit('tool.start', { tool_id: 'fail', name: 'terminal', args: { command: 'fixture command' } })
  await expect(page.getByRole('button', { name: /terminal.*执行中/ })).toBeVisible()
  backend.emit('tool.complete', {
    tool_id: 'fail',
    name: 'terminal',
    result: { output: 'FIXTURE_FAILED_OUTPUT', exit_code: 1 }
  })
  await expect(page.getByText(/FIXTURE_FAILED_OUTPUT/)).toBeVisible()
  await page.screenshot({ path: `mobile/test-results/parity-tools-tasks-${info.project.name}.png`, fullPage: true })
})

test('session rows show real runtime status and follow sessions.changed broadcasts', async ({ page }, info) => {
  const backend = await fixture(page)
  await page.goto('/mobile/')
  await openSession(page)
  const opener = page.getByRole('button', { name: '打开会话列表' })

  if (await opener.isVisible()) {
    await opener.click()
  }

  const row = page.getByRole('button', { name: /测试夹具 · 移动体验/ })
  await expect(row.getByRole('status', { name: '会话运行中' })).toBeVisible()
  const leasedRow = page.getByRole('button', { name: /夹具 · 另一端持有/ })
  await expect(leasedRow.getByRole('status', { name: '后端已连接；运行状态未知' })).toBeVisible()
  backend.setLiveStatus('waiting')
  backend.emit('sessions.changed', {})
  await expect(row.getByRole('status', { name: '需要你输入' })).toBeVisible()
  await page.screenshot({ path: `mobile/test-results/parity-live-status-${info.project.name}.png`, fullPage: true })
})

test('follows asynchronous transcript growth but does not steal an upward reading position', async ({ page }, info) => {
  await fixture(page, true)
  await page.goto('/mobile/')
  await openSession(page)
  const viewport = page.locator('.transcript')
  await expect.poll(() => viewport.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5)
  await page.locator('.thread-content').evaluate(el => {
    const block = document.createElement('div')
    block.dataset.delayedLayout = 'true'
    block.style.height = '420px'
    el.append(block)
  })
  await expect
    .poll(() => viewport.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight), { timeout: 900 })
    .toBeLessThan(5)
  await viewport.hover()

  if (info.project.use.browserName === 'webkit') {
    // Mobile WebKit has no Playwright wheel support. This branch verifies layout/state,
    // not a physical iOS swipe; Chromium above exercises trusted wheel input.
    await viewport.evaluate(el => {
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
  } else {
    await page.mouse.wheel(0, -480)
  }

  await expect(page.getByRole('button', { name: '回到最新' })).toBeVisible()
  const top = await viewport.evaluate(el => el.scrollTop)
  await page.locator('[data-delayed-layout]').evaluate(el => {
    ;(el as HTMLElement).style.height = '840px'
  })
  await page.waitForTimeout(120)
  expect(Math.abs((await viewport.evaluate(el => el.scrollTop)) - top)).toBeLessThan(3)
  await page.getByRole('button', { name: '回到最新' }).click()
  await expect.poll(() => viewport.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5)
})

test('official Desktop theme and locale matrix keeps the original backdrop and bounded layout', async ({
  page
}, info) => {
  test.setTimeout(60_000)
  await fixture(page)
  await page.addInitScript(() => localStorage.setItem('hermes-web:appearance', 'dark'))
  const externalRequests: string[] = []
  page.on('request', request => {
    if (/^https?:/u.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') {
      externalRequests.push(request.url())
    }
  })
  await page.goto('/mobile/')
  await openSession(page)
  await page.getByRole('button', { name: '外观设置' }).click()

  const themeNames = await page
    .locator('[data-theme-value]')
    .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-theme-value')!))

  expect(themeNames.length).toBeGreaterThan(2)
  const themes = []

  for (const skin of themeNames) {
    await page.locator(`[data-theme-value="${skin}"]`).click()
    await expect(page.locator('html')).toHaveAttribute('data-hermes-theme', skin)
    themes.push(
      await page.evaluate(() => ({
        skin: document.documentElement.dataset.hermesTheme,
        surface: document.documentElement.style.getPropertyValue('--mobile-surface'),
        font: document.documentElement.style.getPropertyValue('--dt-font-sans')
      }))
    )

    if (['nous', 'catppuccin', 'solarized'].includes(skin)) {
      await page.getByRole('button', { name: '完成', exact: true }).click()
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({
        animations: 'disabled',
        path: `mobile/test-results/matrix-${info.project.name}-${skin}.png`,
        fullPage: true
      })
      await page.getByRole('button', { name: '外观设置' }).click()
    }
  }

  await page.locator('[data-theme-value="nous"]').click()
  const languages = []

  const localeNames = await page
    .locator('#mobile-language option')
    .evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value))

  for (const locale of localeNames) {
    await page.locator('#mobile-language').selectOption(locale)
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr')
    languages.push({ locale, direction: await page.locator('html').getAttribute('dir') })

    const sidebar = (await page.locator('.desktop-sidebar').isVisible())
      ? await page.locator('.desktop-sidebar').boundingBox()
      : null

    if (sidebar) {
      const chat = await page.locator('.chat-main').boundingBox()
      expect(locale === 'ar' ? sidebar.x > chat!.x : sidebar.x < chat!.x).toBe(true)
    }
  }

  await page.locator('#mobile-language').selectOption('ar')
  await page.locator('.appearance-panel button').last().click()

  if (!(await page.locator('.desktop-sidebar').isVisible())) {
    await page.locator('.chat-header > div:first-child > button').click()
    await expect
      .poll(() =>
        page.locator('.mobile-drawer').evaluate(node => Math.abs(node.getBoundingClientRect().right - innerWidth) < 2)
      )
      .toBe(true)
    await page.keyboard.press('Escape')
  }

  await page.screenshot({
    animations: 'disabled',
    path: `mobile/test-results/matrix-${info.project.name}-ar.png`,
    fullPage: true
  })
  await page.locator('.chat-header [aria-haspopup="dialog"]').click()
  await page.locator('#mobile-language').selectOption('en')
  await page.locator('[data-appearance-tab="text"]').click()
  await page.locator('#mobile-font').click()
  await page.getByRole('option', { name: 'Segoe UI', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--dt-font-sans')))
    .toContain('Segoe UI')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect
    .poll(() => page.locator('.web-backdrop img').evaluate(node => (node as HTMLImageElement).naturalWidth))
    .toBe(1280)
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveAttribute('dir', 'auto')
  expect(externalRequests).toEqual([])
  await page.screenshot({
    animations: 'disabled',
    path: `mobile/test-results/matrix-${info.project.name}-en.png`,
    fullPage: true
  })
  await writeFile(
    info.outputPath('appearance-matrix.json'),
    JSON.stringify({ project: info.project.name, themes, languages, externalRequests }, null, 2)
  )
})

test('long multilingual history never takes width away from the chat', async ({ page }) => {
  await fixture(page)
  await page.route('**/api/sessions?*', route =>
    route.fulfill({
      json: {
        sessions: [
          {
            id: 'fixture-session',
            title: '测试夹具 · 移动体验 — 中文 English 日本語 العربية '.repeat(12),
            preview: 'https://example.invalid/' + 'long-unbroken-content'.repeat(80),
            last_active: 1
          }
        ],
        total: 1
      }
    })
  )

  for (const width of [834, 1024, 1280]) {
    await page.setViewportSize({ width, height: 1100 })
    await page.goto('/mobile/')

    if (width < 1024) {
      await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
    }

    await expect(page.getByRole('button', { name: /测试夹具 · 移动体验/ })).toBeVisible()
    const sidebar = await page.locator(width < 1024 ? '.mobile-drawer' : '.desktop-sidebar').boundingBox()
    const chat = await page.locator('.chat-main').boundingBox()
    // WebKit reports a ~1e-5px transformed width during the drawer spring settle.
    expect(Math.round(sidebar!.width)).toBeLessThanOrEqual(width < 1024 ? 360 : 320)
    expect(chat!.width).toBeGreaterThan(width / 2)
  }
})

test('restores Desktop colors and glass settings without changing connection or draft', async ({ page }) => {
  await fixture(page)
  await page.goto('/mobile/')
  await page.getByRole('textbox', { name: '消息' }).fill('外观调整时保留草稿')
  await page.getByRole('button', { name: '外观设置' }).click()
  await expect(page.getByRole('dialog', { name: '外观' })).toBeVisible()
  await page.locator('[data-theme-value="nous"]').click()
  await page.locator('[data-appearance-tab="glass"]').click()
  await page.getByLabel('透明面板与背景层次').check()
  await page.getByRole('slider', { name: '面板不透明度' }).focus()
  await page.keyboard.press('Home')
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--mobile-panel-opacity')))
    .toBe('0%')
  await page.getByLabel('透明面板与背景层次').uncheck()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.mobileGlass)).toBe('false')
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('外观调整时保留草稿')
  await page.reload()
  await page.getByRole('button', { name: '外观设置' }).click()
  await expect(page.locator('[data-theme-value="nous"]')).toHaveAttribute('aria-checked', 'true')
  await page.locator('[data-appearance-tab="glass"]').click()
  await expect(page.getByLabel('透明面板与背景层次')).not.toBeChecked()
  await expect(page.getByRole('slider', { name: '面板不透明度' })).toHaveValue('0')
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await expect
    .poll(() =>
      page
        .locator('img[src="/mobile/hermes-icon.png"]')
        .first()
        .evaluate(node => (node as HTMLImageElement).naturalWidth)
    )
    .toBe(128)
  expect((await page.request.get('/mobile/favicon.png')).status()).toBe(200)
  expect((await page.request.get('/mobile/icon-512.png')).status()).toBe(200)
})

test('real unauthenticated backend stays gated, shell fits the device', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/mobile/')
  await expect(page.getByRole('link', { name: '登录', exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
  await page.screenshot({
    animations: 'disabled',
    path: `mobile/test-results/${info.project.name}-real-signin.png`,
    fullPage: true
  })
})
test('finds history, protects IME Enter and sends one explicit click', async ({ page }) => {
  const backend = await fixture(page)
  await page.goto('/mobile/')
  await openSession(page)
  const input = page.getByRole('textbox', { name: '消息', exact: true })
  await input.fill('中文候选确认')
  await input.dispatchEvent('compositionstart')
  await input.press('Meta+Enter')
  expect(backend.submits()).toBe(0)
  await input.dispatchEvent('compositionend')
  await input.press('Enter')
  expect(backend.submits()).toBe(0)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('测试夹具回复：已收到。', { exact: true })).toBeVisible()
  expect(backend.submits()).toBe(1)
  await expect(input).toHaveValue('')
})
test('draft survives reload and keyboard viewport resize does not cover input', async ({ page }) => {
  await fixture(page)
  await page.goto('/mobile/')
  const input = page.getByRole('textbox', { name: '消息', exact: true })
  await input.fill('未发送的中文草稿')
  await page.reload()
  await expect(input).toHaveValue('未发送的中文草稿')
  await page.setViewportSize({ width: 390, height: 480 })
  await expect
    .poll(async () => {
      const box = await input.boundingBox()

      return box ? box.y + box.height : Infinity
    })
    .toBeLessThanOrEqual(480)
})
test('streaming does not pull a reader away from old messages', async ({ page }) => {
  await fixture(page, true)
  await page.goto('/mobile/')
  await openSession(page)
  const transcript = page.locator('.transcript')
  await transcript.evaluate(el => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await expect(page.getByRole('button', { name: '回到最新' })).toBeVisible()
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('检查滚动')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  // Sending deliberately follows the user's new turn. Scrolling UP afterwards must stay put.
  await transcript.evaluate(el => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await page.waitForTimeout(400)
  expect(await transcript.evaluate(el => el.scrollTop)).toBeLessThan(80)
})
test('supports dark mode, readable touch controls and a split-view fallback', async ({ page }, info) => {
  await fixture(page)
  await page.goto('/mobile/')
  await openSession(page)
  const toggle = page.getByRole('button', { name: /切换浅色|切换深色/ })
  await toggle.click()
  const send = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox()
  expect(send!.height).toBeGreaterThanOrEqual(44)
  expect(send!.width).toBeGreaterThanOrEqual(44)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({
    animations: 'disabled',
    path: `mobile/test-results/${info.project.name}-fixture-chat.png`,
    fullPage: true
  })
  await page.setViewportSize({ width: 600, height: 800 })
  await expect(page.getByRole('button', { name: '打开会话列表' })).toBeVisible()
  await page.getByRole('button', { name: '打开会话列表' }).click()
  await expect(page.getByRole('dialog', { name: '会话导航' })).toBeVisible()
  await page.getByRole('button', { name: '关闭会话列表' }).click()
  await expect(page.getByRole('dialog', { name: '会话导航' })).toHaveCount(0)
})

test('adaptive navigation preserves drafts across orientation and CSS viewport sizes', async ({ page }, info) => {
  await fixture(page, true)
  await page.setViewportSize({ width: 834, height: 1194 })
  await page.goto('/mobile/')
  await expect(page.locator('.desktop-sidebar')).not.toBeVisible()
  await openSession(page)
  const input = page.getByRole('textbox', { name: '消息', exact: true })
  await input.fill('旋转与缩窗不能丢掉的草稿')

  const sizes = [
    { name: 'iphone-portrait', width: 390, height: 844 },
    { name: 'iphone-landscape', width: 844, height: 390 },
    { name: 'ipad-portrait', width: 834, height: 1194 },
    { name: 'ipad-landscape', width: 1194, height: 834 },
    { name: 'macbook-air', width: 1440, height: 900 },
    { name: '1080p', width: 1920, height: 1080 },
    { name: '2k', width: 2560, height: 1440 },
    { name: '4k', width: 3840, height: 2160 }
  ]

  const evidence = []

  for (const size of sizes) {
    await page.setViewportSize(size)
    const split = size.width >= 1024 && size.height >= 540

    if (split) {
      await expect(page.locator('.desktop-sidebar')).toBeVisible()
    } else {
      await expect(page.locator('.desktop-sidebar')).not.toBeVisible()
    }

    // Separate assertions keep Playwright's negated matcher explicit.
    if (split) {
      await expect(page.getByRole('separator', { name: '调整侧栏宽度' })).toBeVisible()
    } else {
      await expect(page.getByRole('button', { name: '打开会话列表', exact: true })).toBeVisible()
    }

    await expect(input).toHaveValue('旋转与缩窗不能丢掉的草稿')
    await expect
      .poll(async () => {
        const box = await input.boundingBox()

        return box ? box.y + box.height : Infinity
      })
      .toBeLessThanOrEqual(size.height)

    const geometry = await page.evaluate(() => ({
      width: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
      chat: document.querySelector('.chat-main')!.getBoundingClientRect().width,
      thread: document.querySelector('.thread-content')!.getBoundingClientRect().width,
      pointerFine: matchMedia('(pointer: fine)').matches
    }))

    expect(geometry.overflow).toBe(false)
    expect(geometry.chat).toBeGreaterThan(size.width / 2)
    expect(geometry.thread).toBeLessThanOrEqual(980)

    if (size.width >= 1600) {
      const paragraph = page.locator('.assistant .message-text p').first()
      expect((await paragraph.boundingBox())!.width).toBeLessThanOrEqual(800)
    }

    evidence.push({ size, ...geometry })

    if (['iphone-landscape', 'ipad-landscape', 'macbook-air'].includes(size.name)) {
      await page.screenshot({
        animations: 'disabled',
        path: `mobile/test-results/adaptive-${info.project.name}-${size.name}.png`
      })
    }
  }

  await writeFile(info.outputPath('responsive-matrix.json'), JSON.stringify(evidence, null, 2))
})

test('sidebar supports drag keyboard reset collapse persistence and resize clamping', async ({ page }, info) => {
  const backend = await fixture(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/mobile/')
  const separator = page.getByRole('separator', { name: '调整侧栏宽度' })
  await expect(separator).toBeVisible()
  await separator.focus()
  const start = Number(await separator.getAttribute('aria-valuenow'))
  await page.keyboard.press('ArrowRight')
  await expect(separator).toHaveAttribute('aria-valuenow', String(start + 20))
  const box = await separator.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width / 2 + 55, box!.y + box!.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(start + 20)
  const dragged = await separator.getAttribute('aria-valuenow')
  await page.reload()
  await expect(separator).toHaveAttribute('aria-valuenow', dragged!)
  await separator.dblclick()
  await expect(separator).toHaveAttribute('aria-valuenow', '292')
  await page.getByRole('button', { name: '收起会话列表', exact: true }).click()
  await expect(separator).not.toBeVisible()
  await page.reload()
  await expect(page.locator('.desktop-sidebar')).not.toBeVisible()
  await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
  await expect(separator).toBeVisible()
  await separator.focus()
  await page.keyboard.press('End')
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(360)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(separator).not.toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(separator).toBeVisible()

  if (['ipad', 'iphone'].includes(info.project.name)) {
    await separator.focus()
    await page.keyboard.press('Enter')
    const touchBox = (await separator.boundingBox())!
    expect(touchBox.width).toBeGreaterThanOrEqual(44)
    const cdp = await page.context().newCDPSession(page)

    const x = touchBox.x + touchBox.width / 2,
      y = touchBox.y + touchBox.height / 2

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 40, y }] })
    await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(292)
    // A secondary finger on the grip must not take ownership of the active resize.
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { id: 0, x: x + 40, y },
        { id: 1, x: x + 43, y: y + 10 }
      ]
    })
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { id: 0, x: x + 40, y },
        { id: 1, x: x + 63, y: y + 10 }
      ]
    })
    await expect(separator).toHaveAttribute('aria-valuenow', '332')
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
    await expect(separator).toHaveAttribute('aria-valuenow', '292')
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 40, y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(separator).toHaveAttribute('aria-valuenow', '332')
    await cdp.detach()
  }

  await separator.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '外观设置' }).click()
  await page.locator('#mobile-language').selectOption('ar')
  await page.locator('.appearance-panel button').last().click()
  const rtlSeparator = page.getByRole('separator', { name: 'Resize sidebar' })
  const rtlWidth = Number(await rtlSeparator.getAttribute('aria-valuenow'))
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await rtlSeparator.press('ArrowLeft')
  await expect(rtlSeparator).toHaveAttribute('aria-valuenow', String(rtlWidth + 20))
  const rtlBox = (await rtlSeparator.boundingBox())!
  await page.mouse.move(rtlBox.x + rtlBox.width / 2, rtlBox.y + rtlBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(rtlBox.x + rtlBox.width / 2 - 35, rtlBox.y + rtlBox.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(rtlSeparator).toHaveAttribute('aria-valuenow', String(rtlWidth + 55))
  expect(backend.submits()).toBe(0)
})

test('full-range glass keeps text opaque with independent backdrop blur and reset', async ({
  page,
  browserName
}, info) => {
  const backend = await fixture(page)
  await page.goto('/mobile/')
  const input = page.getByRole('textbox', { name: '消息', exact: true })
  await input.fill('外观改变不能提交或丢掉此草稿')
  await page.getByRole('button', { name: '外观设置' }).click()
  await page.locator('[data-appearance-tab="glass"]').click()
  await page.getByLabel('透明面板与背景层次').check()

  const range = async (name: string, value: string) =>
    page.getByRole('slider', { name, exact: true }).evaluate((node, value) => {
      const input = node as HTMLInputElement
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, value)

  await range('面板不透明度', '0')
  await range('底纹强度', '35')
  await range('背景模糊', '8')
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--mobile-panel-opacity')))
    .toBe('0%')
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--mobile-backdrop-alpha')))
    .toBe('0.35')
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--mobile-glass-blur')))
    .toBe('8px')

  const result = await page.evaluate(() => {
    const text = document.querySelector('.header-title strong')!
    const composer = document.querySelector('.composer-dock form')!
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d')!
    context.fillStyle = getComputedStyle(composer).backgroundColor
    context.fillRect(0, 0, 1, 1)

    return {
      textOpacity: getComputedStyle(text).opacity,
      alpha: context.getImageData(0, 0, 1, 1).data[3],
      imageOpacity: getComputedStyle(document.querySelector('.web-backdrop > div')!).opacity,
      sidebarAlpha: document.querySelector('.desktop-sidebar')
        ? getComputedStyle(document.querySelector('.desktop-sidebar')!).backgroundColor
        : null
    }
  })

  expect(result.textOpacity).toBe('1')
  expect(result.alpha).toBeGreaterThanOrEqual(200)
  expect(result.imageOpacity).toBe('0.35')
  const dialog = page.getByRole('dialog', { name: '外观' })
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  await dialog.evaluate(node => (node.scrollTop = node.scrollHeight))
  expect(await dialog.evaluate(node => node.scrollLeft)).toBe(0)
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await page.screenshot({ animations: 'disabled', path: `mobile/test-results/glass-${info.project.name}.png` })
  await page.reload()
  await expect(input).toHaveValue('外观改变不能提交或丢掉此草稿')
  await page.getByRole('button', { name: '外观设置' }).click()
  await page.locator('[data-appearance-tab="glass"]').click()
  await expect(page.getByRole('slider', { name: '面板不透明度', exact: true })).toHaveValue('0')
  await expect(page.getByRole('slider', { name: '底纹强度', exact: true })).toHaveValue('35')
  await expect(page.getByRole('slider', { name: '背景模糊', exact: true })).toHaveValue('8')
  await page.getByRole('button', { name: '恢复默认外观' }).click()
  await expect(page.getByRole('slider', { name: '面板不透明度', exact: true })).toHaveValue('94')
  await expect(page.getByRole('slider', { name: '底纹强度', exact: true })).toHaveValue('2.5')
  await expect(page.getByRole('slider', { name: '背景模糊', exact: true })).toHaveValue('12')

  if (browserName === 'chromium') {
    await page.locator('[data-appearance-tab="glass"]').click()
    await page.getByLabel('透明面板与背景层次').check()
    await expect
      .poll(() => page.locator('.appearance-panel').evaluate(node => getComputedStyle(node).backdropFilter))
      .toBe('blur(12px)')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }]
    })
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)).toBe(true)
    expect(await page.locator('.appearance-panel').evaluate(node => getComputedStyle(node).backdropFilter)).toBe('none')
    await cdp.detach()
  }

  expect(backend.submits()).toBe(0)
  await writeFile(info.outputPath('glass-evidence.json'), JSON.stringify(result, null, 2))
})

test('uses Desktop typography tokens with UI-base and chat-only scaling', async ({ page }, info) => {
  await fixture(page, false, true)
  await page.goto('/mobile/')
  await openSession(page)

  const sizes = () =>
    page.evaluate(() => {
      const native = document.createElement('div')
      native.dataset.slot = 'aui_thread-content'
      native.style.setProperty(
        '--chat-text-scale',
        document.documentElement.style.getPropertyValue('--web-chat-text-scale')
      )
      const paragraph = document.createElement('p')
      paragraph.dataset.slot = 'aui_assistant-message-content'
      native.append(paragraph)
      const ui = document.createElement('span')
      ui.style.fontSize = '0.8125rem'
      native.append(ui)
      document.body.append(native)
      const size = (node: Element) => parseFloat(getComputedStyle(node).fontSize)

      const result = {
        native: size(paragraph),
        nativeLineHeight: parseFloat(getComputedStyle(paragraph).lineHeight),
        assistantLineHeight: parseFloat(
          getComputedStyle(document.querySelector('.message.assistant .message-text p')!).lineHeight
        ),
        ui: size(ui),
        assistant: size(document.querySelector('.message.assistant .message-text p')!),
        user: size(document.querySelector('.message.user .message-text')!),
        composer: size(document.querySelector('.composer textarea')!),
        header: size(document.querySelector('.header-title strong')!),
        coarse: matchMedia('(pointer: coarse)').matches,
        code: [...document.querySelectorAll('.message.assistant .message-text code')].map(size),
        table: [...document.querySelectorAll('.message.assistant .message-text table')].map(size)
      }

      native.remove()

      return result
    })

  const before = await sizes()
  expect(before.assistant).toBeCloseTo(before.native, 2)
  expect(before.assistantLineHeight).toBeCloseTo(before.nativeLineHeight, 2)
  expect(before.user).toBeCloseTo(before.native, 2)
  expect(before.composer).toBeCloseTo(before.coarse ? Math.max(16, before.native) : before.native, 2)
  expect(before.header).toBeCloseTo(before.ui, 2)
  await page.screenshot({ path: `mobile/test-results/typography-default-${info.project.name}.png`, fullPage: true })
  await page.getByRole('button', { name: '外观设置' }).click()
  await page.getByRole('tab', { name: '字体与字号', exact: true }).click()
  await page.locator('#mobile-ui-text-scale').selectOption('125')
  const scaledUi = await sizes()
  expect(scaledUi.assistant / before.assistant).toBeCloseTo(1.25, 2)
  expect(scaledUi.user / before.user).toBeCloseTo(1.25, 2)
  expect(scaledUi.header / before.header).toBeCloseTo(1.25, 2)
  await page.locator('#mobile-chat-text-scale').selectOption('150')
  const scaledChat = await sizes()
  expect(scaledChat.header).toBeCloseTo(scaledUi.header, 2)
  expect(scaledChat.assistant).toBeCloseTo(scaledChat.native, 2)
  expect(scaledChat.user).toBeCloseTo(scaledChat.native, 2)
  expect(scaledChat.composer).toBeCloseTo(scaledChat.coarse ? Math.max(16, scaledChat.native) : scaledChat.native, 2)
  expect(scaledChat.code.every((size, i) => size > scaledUi.code[i])).toBe(true)
  expect(scaledChat.table.every((size, i) => size > scaledUi.table[i])).toBe(true)
  await writeFile(
    info.outputPath('typography-evidence.json'),
    JSON.stringify({ before, scaledUi, scaledChat }, null, 2)
  )
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await page.screenshot({ path: `mobile/test-results/typography-${info.project.name}.png`, fullPage: true })
})

test('appearance groups show theme swatches font samples and persistent reachable actions', async ({ page }, info) => {
  const backend = await fixture(page, false, true)
  await page.addInitScript(() => localStorage.setItem('hermes-web:appearance', 'dark'))
  await page.goto('/mobile/')
  await openSession(page)
  const input = page.getByRole('textbox', { name: '消息', exact: true })
  await input.fill('设置改版不能提交此草稿')

  const before = await page
    .locator('.message-text')
    .first()
    .evaluate(node => parseFloat(getComputedStyle(node).fontSize))

  const chatSizes = () =>
    page
      .locator('.assistant .message-text, .assistant .message-text code, .assistant .message-text table')
      .evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).fontSize)))

  const beforeSizes = await chatSizes()
  await page.getByRole('button', { name: '外观设置' }).click()
  await expect(page.getByRole('tab', { name: '配色与语言', exact: true })).toBeVisible()
  const ember = page.getByRole('radio', { name: 'Ember', exact: true })
  await expect(ember.locator('[data-theme-swatch]')).toHaveCount(4)
  await ember.click()
  await expect(page.locator('html')).toHaveAttribute('data-hermes-theme', 'ember')
  await page.getByRole('tab', { name: '字体与字号', exact: true }).click()
  await page.locator('#mobile-font').click()
  const inter = page.getByRole('option', { name: 'Inter', exact: true })
  await expect(inter.locator('[data-font-shape]')).toHaveCount(1)
  await expect(inter.locator('[data-font-shape]')).toHaveCSS('font-family', /Inter/)
  await page.screenshot({
    animations: 'disabled',
    path: `mobile/test-results/settings-${info.project.name}-font-menu.png`
  })
  await inter.click()
  await expect(page.getByLabel('字体预览', { exact: true })).toHaveCSS('font-family', /Inter/)
  await page.locator('#mobile-ui-text-scale').selectOption('175')
  await expect
    .poll(() =>
      page
        .locator('.message-text')
        .first()
        .evaluate(node => parseFloat(getComputedStyle(node).fontSize))
    )
    .toBeCloseTo(before * 1.75, 2)
  const uiScaledSizes = await chatSizes()
  uiScaledSizes.forEach((size, index) => expect(size / beforeSizes[index]).toBeCloseTo(1.75, 2))
  await page.locator('#mobile-chat-text-scale').selectOption('150')
  await expect
    .poll(() =>
      page
        .locator('.message-text')
        .first()
        .evaluate(node => parseFloat(getComputedStyle(node).fontSize))
    )
    .toBeGreaterThan(before)

  const afterSizes = await chatSizes()
  expect(afterSizes.length).toBe(beforeSizes.length)
  expect(afterSizes.every((size, index) => size > beforeSizes[index])).toBe(true)

  const viewports = [
    { width: 390, height: 664 },
    { width: 844, height: 390 },
    { width: 834, height: 1194 },
    { width: 1280, height: 800 }
  ]

  const rows = []

  for (const size of viewports) {
    await page.setViewportSize(size)
    const footer = page.locator('.appearance-footer')
    await expect(footer.getByRole('button', { name: '完成', exact: true })).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('button', { name: '关闭外观设置', exact: true })).toBeInViewport({ ratio: 1 })
    const body = page.locator('.appearance-body')
    await body.evaluate(node => (node.scrollTop = node.scrollHeight))
    await expect(footer.getByRole('button', { name: '完成', exact: true })).toBeInViewport({ ratio: 1 })

    const fit = await page.getByRole('dialog', { name: '外观' }).evaluate(node => ({
      dialog: node.scrollWidth <= node.clientWidth,
      doc: document.documentElement.scrollWidth <= innerWidth,
      body: node.querySelector('.appearance-body')!.scrollWidth <= node.querySelector('.appearance-body')!.clientWidth
    }))

    expect(fit).toEqual({ dialog: true, doc: true, body: true })
    rows.push({ size, ...fit })
  }

  await page.setViewportSize({ width: 390, height: 664 })
  await page.locator('#mobile-ui-text-scale').selectOption('100')
  await page.screenshot({ animations: 'disabled', path: `mobile/test-results/settings-${info.project.name}-fonts.png` })
  await page.getByRole('tab', { name: '配色与语言', exact: true }).click()
  await page.screenshot({
    animations: 'disabled',
    path: `mobile/test-results/settings-${info.project.name}-themes.png`
  })
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await expect(input).toHaveValue('设置改版不能提交此草稿')
  await page.reload()
  await page.getByRole('button', { name: '外观设置' }).click()
  await page.getByRole('tab', { name: '字体与字号', exact: true }).click()
  await expect(page.locator('#mobile-chat-text-scale')).toHaveValue('150')
  expect(backend.submits()).toBe(0)
  await writeFile(info.outputPath('settings-evidence.json'), JSON.stringify(rows, null, 2))
})

test('direct index deployment entry boots without a client history route', async ({ page }) => {
  const backend = await fixture(page)
  await page.goto('/mobile/index.html?entry=deployment-check')
  await expect(page.getByText('已连接 GA401', { exact: true })).toBeVisible()
  await openSession(page)
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('仅测试入口，不提交模型请求')
  expect(backend.submits()).toBe(0)
  expect(new URL(page.url()).pathname).toBe('/mobile/index.html')
})

test('public sidecar replies and other-process saved updates render without empty assistant rows', async ({ page }) => {
  const backend = await fixture(page)
  backend.saveReply('PUBLIC_SIDECAR_REPLY')
  await page.goto('/mobile/')
  await openSession(page)
  await expect(page.getByText('PUBLIC_SIDECAR_REPLY', { exact: true })).toBeVisible()
  backend.saveReply('REMOTE_SAVED_UPDATE_NO_WEBSOCKET_EVENT')
  await expect(page.getByText('REMOTE_SAVED_UPDATE_NO_WEBSOCKET_EVENT', { exact: true })).toBeVisible({ timeout: 9000 })
  expect(
    await page
      .locator('.message.assistant .message-text')
      .evaluateAll(nodes => nodes.every(node => Boolean(node.textContent?.trim())))
  ).toBe(true)
  expect(backend.submits()).toBe(0)
})
