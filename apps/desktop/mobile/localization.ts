import { useSyncExternalStore } from 'react'

import { BUNDLED_LOCALES, TRANSLATIONS } from '../src/i18n/catalog'
import { isRtlLocale, LOCALE_OPTIONS } from '../src/i18n/languages'
import type { BundledLocale } from '../src/i18n/types'

import { mobileEnglish } from './localization-extra'

export const LOCALES = BUNDLED_LOCALES
export const LANGUAGE_OPTIONS = LOCALE_OPTIONS
export const LOCALE_KEY = 'hermes-web:locale:v1'
const eventName = 'hermes-web-language'
let selected: BundledLocale | undefined
const indexes = new Map<BundledLocale, Map<string, string>>()

const officialPaths: Record<string, string> = {
  新对话: 'sidebar.nav.new-session',
  新建对话: 'sidebar.nav.new-session',
  消息: 'composer.message',
  搜索会话: 'sidebar.searchAria',
  搜索对话与内容: 'sidebar.searchPlaceholder',
  清除搜索: 'sidebar.clearSearch',
  对话: 'sidebar.sessions',
  刷新会话: 'common.refresh',
  重试: 'common.retry',
  加载会话: 'sidebar.loading',
  加载更早的会话: 'sidebar.loadMore',
  未命名对话: 'sidebar.row.untitledPlaceholder',
  复制: 'common.copy',
  复制回复: 'common.copy',
  已复制: 'common.copied',
  会话运行中: 'sidebar.row.sessionRunning',
  需要你输入: 'sidebar.row.needsInput',
  完成: 'common.done',
  执行中: 'sidebar.statusDivider.working',
  已完成: 'sidebar.statusDivider.done',
  停止当前任务: 'composer.stop',
  发送消息: 'composer.send',
  排队发送消息: 'composer.queueMessage',
  '连接中…': 'common.connecting',
  关闭提示: 'common.close',
  语言: 'language.label',
  继续已有对话: 'common.continue',
  打开会话列表: 'sidebar.showSessions',
  关闭会话列表: 'common.close',
  'Desktop 底纹': 'settings.appearance.backdropTitle',
  字体: 'settings.appearance.chatFontTitle',
  主题默认字体: 'settings.appearance.chatFontReset'
}

function valueAt(object: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined),
      object
    )
}

function catalogIndex(locale: BundledLocale) {
  let index = indexes.get(locale)

  if (index) {
    return index
  }

  index = new Map<string, string>()

  const walk = (source: unknown, target: unknown) => {
    if (typeof source === 'string' && typeof target === 'string') {
      index!.set(source, target)

      return
    }

    if (source && target && typeof source === 'object' && typeof target === 'object') {
      for (const [key, value] of Object.entries(source)) {
        walk(value, (target as Record<string, unknown>)[key])
      }
    }
  }

  walk(TRANSLATIONS.zh, TRANSLATIONS[locale])
  indexes.set(locale, index)

  return index
}

export function normalizeWebLocale(raw: unknown): BundledLocale {
  if (typeof raw !== 'string') {
    return 'en'
  }

  const normalized = raw.toLowerCase().replaceAll('_', '-')

  if (/^zh-(tw|hk|hant)/u.test(normalized)) {
    return 'zh-hant'
  }

  return LOCALES.find(locale => normalized === locale || normalized.startsWith(`${locale}-`)) ?? 'en'
}

export function webText(locale: BundledLocale, source: string): string {
  if (locale === 'zh') {
    return source
  }

  const aliased = officialPaths[source] ? valueAt(TRANSLATIONS[locale], officialPaths[source]) : undefined

  if (typeof aliased === 'string') {
    return aliased
  }

  return catalogIndex(locale).get(source) ?? mobileEnglish[source] ?? source
}

export function getWebLocale(): BundledLocale {
  if (selected) {
    return selected
  }

  let stored: string | null = null

  try {
    stored = localStorage.getItem(LOCALE_KEY)
  } catch {
    /* Use browser language. */
  }

  selected = normalizeWebLocale(stored ?? navigator.language)

  return selected
}

export function syncDocumentLocale(locale: BundledLocale) {
  document.documentElement.lang = locale
  document.documentElement.dir = isRtlLocale(locale) ? 'rtl' : 'ltr'
}

export function setWebLocale(value: string) {
  selected = normalizeWebLocale(value)

  try {
    localStorage.setItem(LOCALE_KEY, selected)
  } catch {
    /* This window still switches. */
  }

  syncDocumentLocale(selected)
  window.dispatchEvent(new Event(eventName))
}

export function useWebLocale() {
  return useSyncExternalStore(listener => {
    window.addEventListener(eventName, listener)

    return () => window.removeEventListener(eventName, listener)
  }, getWebLocale)
}

export const tr = (source: string) => webText(getWebLocale(), source)
