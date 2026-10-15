import { expect, it } from 'vitest'

import { LOCALES, normalizeWebLocale, webText } from './localization'
import { mobileEnglish } from './localization-extra'

it('does not leak Chinese source labels into the declared English shell', () => {
  for (const source of Object.keys(mobileEnglish)) {
    expect(webText('en', source)).not.toMatch(/[\u3400-\u9fff]/u)
  }
})

it('uses official Desktop labels in the selected language without changing protocol identifiers', () => {
  expect(webText('en', '新对话')).toBe('New session')
  expect(webText('en', '消息')).toBe('Message')
  expect(webText('ar', '新对话')).not.toMatch(/[\u3400-\u9fff]/u)
  expect(webText('zh', '新对话')).toBe('新对话')
  expect(webText('en', 'session.create')).toBe('session.create')
  expect(LOCALES).toContain('zh-hant')
  expect(LOCALES).toContain('ar')
})
it('normalizes browser locale variants and falls back safely', () => {
  expect(normalizeWebLocale('zh-TW')).toBe('zh-hant')
  expect(normalizeWebLocale('en-US')).toBe('en')
  expect(normalizeWebLocale('ja-JP')).toBe('ja')
  expect(normalizeWebLocale('invalid')).toBe('en')
})
