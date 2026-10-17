import type { ModelOptionsResult } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { ChevronDown, X } from 'lucide-react'
import { useRef, useState } from 'react'

import {
  type ModelCatalogController,
  ModelCatalogMenu,
  ModelMenuCloseContext
} from '../src/app/shell/model-catalog-menu'
import { ConfirmHost } from '../src/components/confirm-host'
import { ModelVisibilityDialog } from '../src/components/model-visibility-dialog'
import { Button } from '../src/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../src/components/ui/dropdown-menu'
import { I18nProvider } from '../src/i18n'
import { modelOptionsQueryKey } from '../src/lib/model-options'
import { displayModelName } from '../src/lib/model-status-label'
import { $modelVisibilityOpen, setModelVisibilityOpen } from '../src/store/model-visibility'

import type { MobileController, MobileState } from './controller'
import { tr, useWebLocale } from './localization'

interface PickerProps {
  controller: MobileController
  state: MobileState
}

export function ModelPicker({ controller, state }: PickerProps) {
  const locale = useWebLocale()
  const [open, setOpen] = useState(false)
  const visibilityOpen = useStore($modelVisibilityOpen)
  const request = catalogRequest(controller)

  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: Infinity,
            refetchOnWindowFocus: false
          }
        }
      })
  )

  const disabled =
    state.connection !== 'ready' ||
    state.opening ||
    state.sending ||
    state.modelChanging ||
    Boolean(state.uncertain) ||
    Boolean(state.conversation?.running)

  const model = state.conversation?.model || state.draftModel?.model

  const changeOpen = (next: boolean) => {
    if (next) {
      client.clear()
    }

    setOpen(next)
  }

  return (
    <I18nProvider configClient={null} initialLocale={locale} key={locale}>
      <QueryClientProvider client={client}>
        <DropdownMenu onOpenChange={changeOpen} open={open}>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={tr('选择模型')}
              className="model-trigger"
              disabled={disabled}
              title={disabled ? tr('连接恢复且任务结束后才能切换模型。') : tr('选择模型')}
              type="button"
              variant="ghost"
            >
              <span className="model-label">{model ? displayModelName(model) : tr('沿用后端默认模型')}</span>
              <ChevronDown aria-hidden size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" aria-label={tr('选择模型')} className="mobile-model-menu" side="top">
            <header className="mobile-model-header">
              <strong>{tr('选择模型')}</strong>
              <Button
                aria-label={tr('关闭提示')}
                onClick={() => setOpen(false)}
                size="icon"
                type="button"
                variant="ghost"
              >
                <X />
              </Button>
            </header>
            <Catalog close={() => setOpen(false)} controller={controller} request={request} state={state} />
          </DropdownMenuContent>
        </DropdownMenu>
        <ModelVisibilityDialog
          className="mobile-model-visibility"
          onOpenChange={setModelVisibilityOpen}
          open={visibilityOpen}
          profile={controller.profile}
          request={request}
          sessionId={state.conversation?.liveId}
        />
        <ConfirmHost />
      </QueryClientProvider>
    </I18nProvider>
  )
}

function catalogRequest(controller: MobileController) {
  return async <T,>(method: string): Promise<T> => {
    if (method !== 'model.options') {
      throw new Error('Unsupported catalog operation')
    }

    const result = await controller.modelOptions()

    return { ...result, providers: result.providers?.filter(provider => provider.authenticated !== false) } as T
  }
}

function Catalog({
  controller,
  state,
  close,
  request
}: PickerProps & { close: () => void; request: ReturnType<typeof catalogRequest> }) {
  const [error, setError] = useState('')
  const pending = useRef(false)
  const sessionId = state.conversation?.liveId

  const options = useQuery({
    queryKey: modelOptionsQueryKey(controller.profile, sessionId),
    queryFn: () => request<ModelOptionsResult>('model.options')
  })

  const current = state.conversation ? options.data : (state.draftModel ?? options.data)

  const menu: ModelCatalogController = {
    allowSpeed: false,
    current: {
      model: current?.model ?? '',
      provider: current?.provider ?? '',
      effort: '',
      effortPending: true,
      fast: false
    },
    presetFor: () => ({}),

    select: async (model, provider) => {
      if (pending.current) {
        return false
      }

      pending.current = true
      setError('')

      try {
        await controller.selectModel({ model, provider })
        close()

        return true
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : tr('模型切换失败，请重试。'))

        return false
      } finally {
        pending.current = false
      }
    }
  }

  return (
    <ModelMenuCloseContext.Provider
      value={() => {
        if (!pending.current) {
          close()
        }
      }}
    >
      {options.isPending ? (
        <p role="status">{tr('正在加载模型…')}</p>
      ) : options.error ? (
        <div role="alert">
          <p>{options.error.message}</p>
          <Button onClick={() => void options.refetch()} type="button" variant="ghost">
            {tr('重试')}
          </Button>
        </div>
      ) : (
        <ModelCatalogMenu controller={menu} profile={controller.profile} request={request} sessionId={sessionId} />
      )}
      {error && <p role="alert">{tr(error)}</p>}
      {state.modelChanging && <p role="status">{tr('正在切换模型…')}</p>}
    </ModelMenuCloseContext.Provider>
  )
}
