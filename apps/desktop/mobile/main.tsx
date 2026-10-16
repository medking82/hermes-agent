import './mobile.css'

import { createRoot } from 'react-dom/client'

import { resolveChatFontFamily } from '../src/themes/chat-font'
import { renderedModeFor } from '../src/themes/palette'
import { DEFAULT_TYPOGRAPHY, nousTheme } from '../src/themes/presets'

import { MobileApp } from './app'
import { paletteForPreferences, readVisualPreferences, VISUAL_KEY, WEB_THEMES } from './appearance'
import { MobileController } from './controller'
import { getWebLocale, syncDocumentLocale } from './localization'

// Use Desktop's actual palette. No backend settings writes and no Electron emulation.
function applyPalette() {
  const root = document.documentElement

  let stored: string | null = null
  let storedMode: string | null = null

  try {
    stored = localStorage.getItem(VISUAL_KEY)
    storedMode = localStorage.getItem('hermes-web:appearance')
  } catch {
    /* Use local defaults when storage is unavailable. */
  }

  const preferences = readVisualPreferences(stored)
  const mode = root.dataset.mobileAppearance ?? storedMode
  const dark = mode === 'dark' || (mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  const colors = paletteForPreferences(preferences, dark)
  const typography = { ...DEFAULT_TYPOGRAPHY, ...nousTheme.typography, ...WEB_THEMES[preferences.skin].typography }
  const rendered = renderedModeFor(colors, dark ? 'dark' : 'light')
  root.dataset.hermesTheme = preferences.skin
  root.dataset.hermesMode = rendered
  syncDocumentLocale(getWebLocale())
  root.dataset.mobileBackdrop = String(preferences.backdrop)
  root.dataset.mobileGlass = String(preferences.glass)
  root.style.setProperty('--mobile-panel-opacity', `${preferences.glass ? preferences.opacity : 100}%`)
  root.style.setProperty('--mobile-glass-blur', preferences.glass ? `${preferences.blur}px` : '0px')
  root.style.setProperty('--mobile-backdrop-alpha', String(preferences.backdropStrength / 100))
  root.style.setProperty('--web-ui-text-scale', String(preferences.uiTextScale / 100))
  root.style.setProperty('--web-chat-text-scale', String(preferences.chatTextScale / 100))

  for (const [key, variable] of [
    ['baseSize', '--dt-base-size'],
    ['lineHeight', '--dt-line-height'],
    ['letterSpacing', '--dt-letter-spacing']
  ] as const) {
    const value = typography[key]

    if (typeof value === 'string' && value.trim()) {root.style.setProperty(variable, value)}
    else {root.style.removeProperty(variable)}
  }

  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors.background)
  root.classList.toggle('dark', rendered === 'dark')
  root.style.colorScheme = rendered

  for (const [key, value] of Object.entries(colors)) {
    if (typeof value === 'string') {
      root.style.setProperty(`--dt-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, value)
    }
  }

  const seeds: Record<string, string> = {
    '--theme-foreground': colors.foreground,
    '--theme-primary': colors.primary,
    '--theme-secondary': colors.secondary,
    '--theme-accent-soft': colors.accent,
    '--theme-midground': colors.midground ?? colors.ring,
    '--theme-warm': colors.primary,
    '--theme-background-seed': colors.background,
    '--theme-sidebar-seed': colors.sidebarBackground ?? colors.background,
    '--theme-card-seed': colors.card,
    '--theme-elevated-seed': colors.popover,
    '--theme-bubble-seed': colors.userBubble ?? colors.popover,
    '--dt-font-sans': resolveChatFontFamily(preferences.font, typography.fontSans),
    '--dt-font-mono': typography.fontMono,
    '--backdrop-invert-mul': rendered === 'dark' ? '0' : '1',
    '--ui-text-primary': colors.foreground,
    '--ui-text-secondary': colors.mutedForeground,
    '--ui-text-tertiary': colors.mutedForeground,
    '--ui-stroke-secondary': colors.border,
    '--mobile-surface': colors.background,
    '--mobile-sidebar': colors.sidebarBackground ?? colors.card,
    '--mobile-muted': colors.mutedForeground,
    '--mobile-soft': colors.muted,
    '--mobile-border': colors.border,
    '--mobile-accent': colors.primary,
    '--mobile-ink': colors.foreground,
    '--mobile-accent-ink': colors.primaryForeground,
    '--mobile-elevated': colors.popover,
    '--mobile-bubble': colors.userBubble ?? colors.muted,
    '--mobile-danger': colors.destructive
  }

  for (const [key, value] of Object.entries(seeds)) {
    root.style.setProperty(key, value)
  }
}

applyPalette()
window.addEventListener('hermes-web-theme', applyPalette)
const controller = new MobileController()
createRoot(document.getElementById('root')!).render(<MobileApp controller={controller} />)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    controller.dispose()
    window.removeEventListener('hermes-web-theme', applyPalette)
  })
}
