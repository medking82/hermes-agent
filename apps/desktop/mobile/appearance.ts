import { CHAT_FONT_SUGGESTIONS } from '../src/themes/chat-font'
import { paletteFor } from '../src/themes/palette'
import { BUILTIN_THEMES, DEFAULT_SKIN_NAME } from '../src/themes/presets'

// A new version resets the prototype's forced-gold defaults, preserving drafts and v1 settings.
export const VISUAL_KEY = 'hermes-web:visual:v2'
export const WEB_THEMES = BUILTIN_THEMES
// Desktop's appearance/typography presets; values here are browser-local text sizing, not Electron zoom.
export const TEXT_SCALE_PRESETS = [90, 100, 110, 125, 150, 175] as const

function textScale(value: unknown): number {
  return typeof value === 'number' && TEXT_SCALE_PRESETS.some(preset => preset === value) ? value : 100
}

export interface VisualPreferences {
  skin: string
  glass: boolean
  opacity: number
  backdrop: boolean
  backdropStrength: number
  blur: number
  font: string
  uiTextScale: number
  chatTextScale: number
}

export function readVisualPreferences(raw: string | null): VisualPreferences {
  const defaults: VisualPreferences = {
    skin: DEFAULT_SKIN_NAME,
    glass: false,
    opacity: 94,
    backdrop: true,
    font: '',
    backdropStrength: 2.5,
    blur: 12,
    uiTextScale: 100,
    chatTextScale: 100
  }

  let value: unknown

  try {
    value = JSON.parse(raw ?? 'null')
  } catch {
    return defaults
  }

  if (!value || typeof value !== 'object') {
    return defaults
  }

  const item = value as Record<string, unknown>

  return {
    skin: typeof item.skin === 'string' && Object.hasOwn(WEB_THEMES, item.skin) ? item.skin : defaults.skin,
    glass: typeof item.glass === 'boolean' ? item.glass : defaults.glass,
    opacity:
      typeof item.opacity === 'number' && Number.isFinite(item.opacity)
        ? Math.max(0, Math.min(100, Math.round(item.opacity)))
        : defaults.opacity,
    backdrop: typeof item.backdrop === 'boolean' ? item.backdrop : defaults.backdrop,
    backdropStrength:
      typeof item.backdropStrength === 'number' && Number.isFinite(item.backdropStrength)
        ? Math.max(0, Math.min(100, item.backdropStrength))
        : defaults.backdropStrength,
    blur:
      typeof item.blur === 'number' && Number.isFinite(item.blur)
        ? Math.max(0, Math.min(32, Math.round(item.blur)))
        : defaults.blur,
    font: typeof item.font === 'string' && CHAT_FONT_SUGGESTIONS.some(font => font === item.font) ? item.font : '',
    uiTextScale: textScale(item.uiTextScale),
    chatTextScale: textScale(item.chatTextScale)
  }
}

export function paletteForPreferences(preferences: VisualPreferences, dark: boolean) {
  return paletteFor(WEB_THEMES[preferences.skin], dark ? 'dark' : 'light')
}
