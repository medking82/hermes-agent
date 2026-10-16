import { expect, it } from 'vitest'

import { BUILTIN_THEMES, nousTheme } from '../src/themes/presets'

import { paletteForPreferences, readVisualPreferences, WEB_THEMES } from './appearance'

it('uses Desktop110 chat default while preserving an explicit saved100 choice', () => {
  expect(readVisualPreferences(null).chatTextScale).toBe(110)
  expect(readVisualPreferences('{"chatTextScale":100}').chatTextScale).toBe(100)
  expect(readVisualPreferences('{"chatTextScale":"invalid"}').chatTextScale).toBe(110)
  expect(readVisualPreferences(null).uiTextScale).toBe(100)
})

it('uses the official Desktop catalog and default rather than a forced gold theme', () => {
  expect(Object.keys(WEB_THEMES)).toEqual(Object.keys(BUILTIN_THEMES))
  expect(readVisualPreferences(null)).toEqual({
    skin: 'nous',
    glass: false,
    opacity: 94,
    backdrop: true,
    font: '',
    backdropStrength: 2.5,
    blur: 12,
    uiTextScale: 100,
    chatTextScale: 110
  })
  expect(paletteForPreferences(readVisualPreferences(null), true)).toBe(nousTheme.darkColors)
  expect(paletteForPreferences(readVisualPreferences(null), false)).toBe(nousTheme.colors)
})
it('uses the Desktop light synthesis for every dark-only preset', () => {
  for (const skin of Object.keys(BUILTIN_THEMES)) {
    const preferences = readVisualPreferences(JSON.stringify({ skin }))
    expect(preferences.skin).toBe(skin)

    const light = paletteForPreferences(preferences, false),
      dark = paletteForPreferences(preferences, true)

    expect(light.background).not.toBe(dark.background)
    expect(light.foreground).not.toBe(dark.foreground)
  }
})
it('restores only known local choices and never accepts a remote background/font', () => {
  expect(
    readVisualPreferences(
      '{"skin":"catppuccin","glass":true,"opacity":200,"background":"https://untrusted.invalid/image","font":"url(https://untrusted.invalid/font)"}'
    )
  ).toEqual({
    skin: 'catppuccin',
    glass: true,
    opacity: 100,
    backdrop: true,
    font: '',
    backdropStrength: 2.5,
    blur: 12,
    uiTextScale: 100,
    chatTextScale: 110
  })
  expect(readVisualPreferences('{"skin":"unknown","opacity":10}').opacity).toBe(10)
  expect(readVisualPreferences('bad JSON')).toEqual(readVisualPreferences(null))
  expect(readVisualPreferences('null')).toEqual(readVisualPreferences(null))
})
it('allows fully clear navigation while bounding independent backdrop and blur settings', () => {
  expect(readVisualPreferences('{"opacity":0,"backdropStrength":70,"blur":24}')).toMatchObject({
    opacity: 0,
    backdropStrength: 70,
    blur: 24
  })
  expect(readVisualPreferences('{"opacity":-3,"backdropStrength":101,"blur":100}')).toMatchObject({
    opacity: 0,
    backdropStrength: 100,
    blur: 32
  })
  expect(readVisualPreferences('{"backdropStrength":"bad","blur":null}')).toMatchObject({
    backdropStrength: 2.5,
    blur: 12
  })
})

it('stores separate UI-base and chat-relative preferences with Desktop-aligned presets', () => {
  expect(readVisualPreferences('{"uiTextScale":90,"chatTextScale":175}')).toMatchObject({
    uiTextScale: 90,
    chatTextScale: 175
  })
  expect(readVisualPreferences('{"uiTextScale":999,"chatTextScale":"bad"}')).toMatchObject({
    uiTextScale: 100,
    chatTextScale: 110
  })
})
