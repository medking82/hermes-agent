import type { ModelOptionsResult } from '@hermes/shared'
import { ChevronDown, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useState } from 'react'

import { Button } from '../src/components/ui/button'

import type { MobileController, MobileState } from './controller'
import { tr, useWebLocale } from './localization'

export function ModelPicker({ controller, state }: { controller: MobileController; state: MobileState }) {
  useWebLocale()
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<ModelOptionsResult>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [value, setValue] = useState('')
  const [attempt, setAttempt] = useState(0)

  const disabled =
    state.connection !== 'ready' ||
    state.opening ||
    state.sending ||
    state.modelChanging ||
    Boolean(state.uncertain) ||
    Boolean(state.conversation?.running)

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    setCatalog(undefined)
    setValue('')
    void controller
      .modelOptions()
      .then(result => {
        if (cancelled) {
          return
        }
        setCatalog(result)
        const current = state.conversation ? result : (state.draftModel ?? result)
        setValue(JSON.stringify([current.provider, current.model]))
      })
      .catch(reason => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : '模型列表加载失败，请重试。')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
    // A session-keyed component owns the picker. Reopen/retry refreshes its catalog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, open, attempt])

  const providers =
    catalog?.providers?.filter(provider => provider.authenticated !== false && provider.models?.length) ?? []

  const selected = providers
    .flatMap(provider => (provider.models ?? []).map(model => ({ model, provider: provider.slug })))
    .find(option => JSON.stringify([option.provider, option.model]) === value)

  const apply = async () => {
    if (!selected || disabled) {
      return
    }
    setError('')

    try {
      await controller.selectModel(selected)
      setOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '模型切换失败，请重试。')
    }
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger asChild>
        <Button
          aria-label={tr('选择模型')}
          className="model-trigger"
          disabled={disabled}
          title={disabled ? tr('连接恢复且任务结束后才能切换模型。') : tr('选择模型')}
          type="button"
          variant="ghost"
        >
          <span className="model-label">
            {state.conversation?.model || state.draftModel?.model || tr('沿用后端默认模型')}
          </span>
          <ChevronDown aria-hidden size={14} />
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="appearance-overlay" />
        <Dialog.Content className="appearance-panel">
          <header className="appearance-header">
            <Dialog.Title>{tr('选择模型')}</Dialog.Title>
            <Dialog.Close asChild>
              <Button aria-label={tr('关闭提示')} className="mobile-icon" size="icon" type="button" variant="ghost">
                <X />
              </Button>
            </Dialog.Close>
          </header>
          <div className="model-picker-body">
            <Dialog.Description>{tr('只影响此对话，不修改全局默认模型；不会发送消息。')}</Dialog.Description>
            {loading ? (
              <p role="status">{tr('正在加载模型…')}</p>
            ) : (
              <>
                {providers.length ? (
                  <>
                    <label htmlFor="mobile-model">{tr('模型')}</label>
                    <select
                      disabled={disabled}
                      id="mobile-model"
                      onChange={event => setValue(event.target.value)}
                      value={selected ? value : ''}
                    >
                      <option disabled value="">
                        {tr('选择模型')}
                      </option>
                      {providers.map(provider => (
                        <optgroup key={provider.slug} label={provider.name}>
                          {provider.models?.map(model => (
                            <option
                              disabled={provider.unavailable_models?.includes(model)}
                              key={model}
                              value={JSON.stringify([provider.slug, model])}
                            >
                              {model}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </>
                ) : (
                  !error && <p role="status">{tr('没有可用的已配置模型。')}</p>
                )}
              </>
            )}
            {error && (
              <div role="alert">
                <p>{tr(error)}</p>
                <Button onClick={() => setAttempt(n => n + 1)} type="button" variant="ghost">
                  {tr('重试')}
                </Button>
              </div>
            )}
            <Button disabled={disabled || loading || !selected} onClick={() => void apply()} type="button">
              {tr(state.modelChanging ? '正在切换模型…' : '应用模型')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
