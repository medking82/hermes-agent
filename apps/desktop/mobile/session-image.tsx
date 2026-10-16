import { useEffect, useState } from 'react'

import { ImageLightbox } from '../src/components/chat/zoomable-image'

import type { BrowserApi } from './browser-api'
import { tr } from './localization'

const BITMAP_DATA = /^data:image\/(png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$/

export function SessionImage({
  path,
  sessionId,
  profile,
  api
}: {
  path: string
  sessionId: string
  profile: string
  api: BrowserApi
}) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    setSrc('')
    setFailed(false)

    // Only persisted uploads auto-load. Markdown/assistant paths never enter this reader.
    if (
      path.includes(String.fromCharCode(0)) ||
      !/^\/[^\\]*\/\.hermes(?:\/profiles\/[^/]+)?\/images\/[^/]+\.(png|jpe?g|gif|webp|bmp)$/i.test(path) ||
      path.split('/').some(part => part === '.' || part === '..')
    ) {
      setFailed(true)

      return () => abort.abort()
    }

    const query = new URLSearchParams({ path, profile, session_id: sessionId })

    const timeout = setTimeout(() => {
      setFailed(true)
      abort.abort()
    }, 60_000)

    void api
      .request<{ dataUrl: string }>(`/api/fs/read-data-url?${query}`, { signal: abort.signal })
      .then(value => {
        if (abort.signal.aborted) {
          return
        }

        if (
          typeof value.dataUrl !== 'string' ||
          value.dataUrl.length > 32 * 1024 * 1024 ||
          !BITMAP_DATA.test(value.dataUrl)
        ) {
          throw new Error('Not a supported image')
        }

        setSrc(value.dataUrl)
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setFailed(true)
        }
      })
      .finally(() => clearTimeout(timeout))

    return () => {
      clearTimeout(timeout)
      abort.abort()
    }
  }, [path, sessionId, profile, api])

  if (failed) {
    return (
      <span className="image-error" role="status">
        {tr('图片无法载入')}
      </span>
    )
  }

  if (!src) {
    return (
      <span className="mobile-photo-loading" role="status">
        {tr('正在载入图片…')}
      </span>
    )
  }

  const save = () => {
    const a = window.document.createElement('a')
    a.href = src
    a.download = path.split('/').at(-1) || 'image.png'
    a.click()
  }

  return (
    <>
      <button aria-label={tr('查看图片')} className="mobile-photo" onClick={() => setOpen(true)} type="button">
        <img alt={tr('会话图片')} onError={() => setFailed(true)} src={src} />
      </button>
      <ImageLightbox
        alt={tr('会话图片')}
        copy={{
          downloadImage: tr('下载图片'),
          savingImage: tr('保存中…'),
          zoomIn: tr('放大'),
          zoomOut: tr('缩小'),
          resetZoom: tr('重置缩放')
        }}
        onClick={save}
        onOpenChange={setOpen}
        open={open}
        saving={false}
        src={src}
      />
    </>
  )
}
