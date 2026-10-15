import { Check, Palette, X } from 'lucide-react'
import { Dialog, RadioGroup, Tabs } from 'radix-ui'
import { useEffect, useState } from 'react'

import { Button } from '../src/components/ui/button'
import { DialogPortalContainerContext } from '../src/components/ui/dialog-portal-context'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../src/components/ui/select'
import { selectableCardClass } from '../src/lib/selectable-card'
import { CHAT_FONT_SUGGESTIONS, resolveChatFontFamily } from '../src/themes/chat-font'
import { paletteFor } from '../src/themes/palette'
import { DEFAULT_TYPOGRAPHY } from '../src/themes/presets'

import { readVisualPreferences, TEXT_SCALE_PRESETS, VISUAL_KEY, WEB_THEMES } from './appearance'
import { LANGUAGE_OPTIONS, setWebLocale, tr, useWebLocale } from './localization'

function readStored() {
  try {
    return localStorage.getItem(VISUAL_KEY)
  } catch {
    return null
  }
}

export function AppearanceSettings() {
  const locale = useWebLocale()
  const [preferences, setPreferences] = useState(() => readVisualPreferences(readStored()))
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    try {
      localStorage.setItem(VISUAL_KEY, JSON.stringify(preferences))
    } catch {
      /* This window still updates. */
    }

    window.dispatchEvent(new Event('hermes-web-theme'))
  }, [preferences])
  const theme = WEB_THEMES[preferences.skin]
  const font = resolveChatFontFamily(preferences.font, theme.typography?.fontSans ?? DEFAULT_TYPOGRAPHY.fontSans)
  const dark = document.documentElement.dataset.mobileAppearance === 'dark'
  const labels = { theme: tr('配色与语言'), text: tr('字体与字号'), glass: tr('玻璃与底纹') }

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button aria-label={tr('外观设置')} className="mobile-icon" size="icon" variant="ghost">
          <Palette />
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="appearance-overlay" />
        <Dialog.Content className="appearance-panel" ref={setContainer}>
          <DialogPortalContainerContext.Provider value={container}>
            <header className="appearance-header">
              <Dialog.Title>{tr('外观')}</Dialog.Title>
              <Dialog.Close asChild>
                <Button aria-label={tr('关闭外观设置')} className="mobile-icon" size="icon" variant="ghost">
                  <X />
                </Button>
              </Dialog.Close>
            </header>
            <Dialog.Description className="sr-only">
              {tr('沿用 Desktop 色板；仅保存到此浏览器，不会修改 Windows Desktop 设置。')}
            </Dialog.Description>
            <Tabs.Root className="appearance-tabs" defaultValue="theme" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
              <Tabs.List aria-label={tr('外观分组')} className="appearance-tabs-list">
                {Object.entries(labels).map(([value, label]) => (
                  <Tabs.Trigger className="appearance-tab" data-appearance-tab={value} key={value} value={value}>
                    {label}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>
              <div className="appearance-body">
                <Tabs.Content className="appearance-section" value="theme">
                  <RadioGroup.Root
                    aria-label={tr('Desktop 配色')}
                    className="appearance-theme-grid"
                    onValueChange={skin => setPreferences({ ...preferences, skin })}
                    value={preferences.skin}
                  >
                    {Object.values(WEB_THEMES).map(theme => {
                      const colors = paletteFor(theme, dark ? 'dark' : 'light')

                      return (
                        <RadioGroup.Item
                          aria-label={theme.label}
                          className={`${selectableCardClass({ active: preferences.skin === theme.name, prominent: true })} appearance-theme-choice`}
                          data-theme-value={theme.name}
                          key={theme.name}
                          value={theme.name}
                        >
                          <span className="theme-choice-name">
                            {theme.label}
                            {preferences.skin === theme.name && <Check aria-hidden size={14} />}
                          </span>
                          <span aria-hidden className="theme-swatch-row">
                            {[colors.background, colors.foreground, colors.primary, colors.accent].map(
                              (color, index) => (
                                <span data-theme-swatch key={index} style={{ backgroundColor: color }} />
                              )
                            )}
                          </span>
                        </RadioGroup.Item>
                      )
                    })}
                  </RadioGroup.Root>
                  <div className="appearance-field">
                    <label htmlFor="mobile-language">{tr('语言')}</label>
                    <select id="mobile-language" onChange={e => setWebLocale(e.target.value)} value={locale}>
                      {LANGUAGE_OPTIONS.map(language => (
                        <option key={language.id} value={language.id}>
                          {language.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="settings-note">{tr('外观仅保存在此浏览器。')}</p>
                </Tabs.Content>
                <Tabs.Content className="appearance-section" value="text">
                  <div className="appearance-size-grid">
                    {(['uiTextScale', 'chatTextScale'] as const).map(key => (
                      <div className="appearance-field" key={key}>
                        <label htmlFor={key === 'uiTextScale' ? 'mobile-ui-text-scale' : 'mobile-chat-text-scale'}>
                          {tr(key === 'uiTextScale' ? '界面字号' : '聊天字号')}
                        </label>
                        <select
                          id={key === 'uiTextScale' ? 'mobile-ui-text-scale' : 'mobile-chat-text-scale'}
                          onChange={e => setPreferences({ ...preferences, [key]: Number(e.target.value) })}
                          value={preferences[key]}
                        >
                          {TEXT_SCALE_PRESETS.map(scale => (
                            <option key={scale} value={scale}>
                              {scale}%
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                  <p className="settings-note">{tr('界面与聊天字号独立；不改变浏览器或 Desktop 缩放。')}</p>
                  <div className="appearance-field">
                    <label htmlFor="mobile-font">{tr('字体')}</label>
                    <Select
                      onValueChange={font =>
                        setPreferences({ ...preferences, font: font === 'theme-default' ? '' : font })
                      }
                      value={preferences.font || 'theme-default'}
                    >
                      <SelectTrigger aria-label={tr('字体')} className="appearance-font-trigger" id="mobile-font">
                        <SelectValue>
                          <span style={{ fontFamily: font }}>{preferences.font || tr('主题默认字体')}</span>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="appearance-font-menu">
                        {['', ...CHAT_FONT_SUGGESTIONS].map(value => (
                          <SelectItem
                            aria-label={value || tr('主题默认字体')}
                            key={value || 'theme-default'}
                            textValue={value || tr('主题默认字体')}
                            value={value || 'theme-default'}
                          >
                            <span className="font-option">
                              <span
                                style={{
                                  fontFamily: resolveChatFontFamily(
                                    value,
                                    theme.typography?.fontSans ?? DEFAULT_TYPOGRAPHY.fontSans
                                  )
                                }}
                              >
                                {value || tr('主题默认字体')}
                              </span>
                              <span
                                aria-hidden="true"
                                data-font-shape
                                style={{
                                  fontFamily: resolveChatFontFamily(
                                    value,
                                    theme.typography?.fontSans ?? DEFAULT_TYPOGRAPHY.fontSans
                                  )
                                }}
                              >
                                Aa Bb Il1 O0 · 中文
                              </span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div aria-label={tr('字体预览')} className="appearance-font-preview" style={{ fontFamily: font }}>
                    <span className="settings-note">{tr('字体预览')}</span>
                    <p>{tr('敏捷的棕色狐狸跳过懒狗。0123456789')}</p>
                    <p>Aa Bb Il1 O0 · 中文</p>
                  </div>
                  <p className="settings-note">{tr('按设备可用字体实际渲染，缺失时回退；不自动下载字体。')}</p>
                </Tabs.Content>
                <Tabs.Content className="appearance-section" value="glass">
                  <div className="appearance-size-grid">
                    <label className="glass-toggle" htmlFor="mobile-backdrop">
                      <input
                        checked={preferences.backdrop}
                        id="mobile-backdrop"
                        onChange={e => setPreferences({ ...preferences, backdrop: e.target.checked })}
                        type="checkbox"
                      />
                      {tr('Desktop 底纹')}
                    </label>
                    <label className="glass-toggle" htmlFor="mobile-glass">
                      <input
                        checked={preferences.glass}
                        id="mobile-glass"
                        onChange={e => setPreferences({ ...preferences, glass: e.target.checked })}
                        type="checkbox"
                      />
                      {tr('透明面板与背景层次')}
                    </label>
                  </div>
                  {[
                    {
                      key: 'opacity',
                      id: 'mobile-opacity',
                      label: tr('面板不透明度'),
                      max: 100,
                      step: 1,
                      unit: '%',
                      disabled: !preferences.glass
                    },
                    {
                      key: 'backdropStrength',
                      id: 'mobile-backdrop-strength',
                      label: tr('底纹强度'),
                      max: 100,
                      step: 0.5,
                      unit: '%',
                      disabled: !preferences.backdrop
                    },
                    {
                      key: 'blur',
                      id: 'mobile-blur',
                      label: tr('背景模糊'),
                      max: 32,
                      step: 1,
                      unit: 'px',
                      disabled: !preferences.glass
                    }
                  ].map(item => (
                    <div className="appearance-field" key={item.key}>
                      <label htmlFor={item.id}>
                        {item.label}
                        <span>
                          {preferences[item.key as 'opacity' | 'backdropStrength' | 'blur']}
                          {item.unit}
                        </span>
                      </label>
                      <input
                        aria-label={item.label}
                        disabled={item.disabled}
                        id={item.id}
                        max={item.max}
                        min={0}
                        onChange={e => setPreferences({ ...preferences, [item.key]: Number(e.target.value) })}
                        step={item.step}
                        type="range"
                        value={preferences[item.key as 'opacity' | 'backdropStrength' | 'blur']}
                      />
                    </div>
                  ))}
                  <details className="appearance-help">
                    <summary>{tr('透明效果说明')}</summary>
                    <p>{tr('网页只透出本页背景，不会透出其他应用。系统要求减少透明度时，会自动使用实色面板。')}</p>
                    <p>{tr('文字不会一起变透明。输入框与设置保留可读衬底。')}</p>
                  </details>
                </Tabs.Content>
              </div>
            </Tabs.Root>
            <footer className="appearance-footer">
              <Button onClick={() => setPreferences(readVisualPreferences(null))} variant="ghost">
                {tr('恢复默认外观')}
              </Button>
              <Dialog.Close asChild>
                <Button>{tr('完成')}</Button>
              </Dialog.Close>
            </footer>
          </DialogPortalContainerContext.Provider>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
