import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { BrowserApi } from './browser-api'

export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,image/bmp'
export const MAX_PHOTOS = 4
// Keep base64 history thumbnails below the existing 32 MiB media-reader budget.
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024
const MAX_BATCH_BYTES = 50 * 1024 * 1024
const MIME_TYPES = new Set(PHOTO_ACCEPT.split(','))

export interface PhotoDraft {
  id: string
  name: string
  bytes: number
  path?: string
  preview?: string
  status: 'uploading' | 'ready' | 'failed'
  error?: string
}

export function isPhotoPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length < 2048 &&
    !Array.from(path).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    /^\/[^\s\\]*\/\.hermes\/images\/dashboard_[A-Za-z0-9_.-]+\.(png|jpe?g|gif|webp|bmp)$/i.test(path) &&
    !path.split('/').some(part => part === '.' || part === '..')
  )
}

export function photoMessage(text: string, photos: PhotoDraft[]): string {
  const refs = photos.filter(p => p.status === 'ready' && isPhotoPath(p.path)).map(p => `@image:${p.path}`)

  return [text, ...refs].filter(Boolean).join('\n')
}

function readDraft(scope: string): PhotoDraft[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(`${scope}:photos`) || '[]')

    if (!Array.isArray(values)) {
      return []
    }

    let totalBytes = 0

    return values
      .slice(0, MAX_PHOTOS)
      .filter((p): p is PhotoDraft =>
        Boolean(
          p &&
          typeof p.id === 'string' &&
          typeof p.name === 'string' &&
          p.name.length <= 128 &&
          p.status === 'ready' &&
          isPhotoPath(p.path) &&
          Number.isFinite(p.bytes) &&
          p.bytes > 0 &&
          p.bytes <= MAX_PHOTO_BYTES
        )
      )
      .filter(photo => {
        if (totalBytes + photo.bytes > MAX_BATCH_BYTES) {
          return false
        }

        totalBytes += photo.bytes

        return true
      })
  } catch {
    return []
  }
}

function persist(scope: string, photos: PhotoDraft[]) {
  try {
    const ready = photos
      .filter(p => p.status === 'ready')
      .map(({ id, name, path, bytes, status }) => ({ id, name, path, bytes, status }))

    if (ready.length) {
      localStorage.setItem(`${scope}:photos`, JSON.stringify(ready))
    } else {
      localStorage.removeItem(`${scope}:photos`)
    }
  } catch {
    /* Storage may be unavailable; never store image bytes in localStorage. */
  }
}

function dataUrl(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const abort = () => reader.abort()
    const cleanup = () => signal.removeEventListener('abort', abort)

    reader.onerror = () => {
      cleanup()
      reject(new Error('读取照片失败，请重新选择。'))
    }

    reader.onabort = () => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }

    reader.onload = () => {
      cleanup()
      resolve(String(reader.result))
    }

    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))

      return
    }

    signal.addEventListener('abort', abort, { once: true })
    reader.readAsDataURL(file)
  })
}

/** Uploaded refs belong to the local draft, never a backend-wide next-turn attachment buffer. */
export function usePhotoDraft(
  api: BrowserApi,
  profile: string,
  scope: string,
  epoch: number,
  adoptNewSession: boolean
) {
  const [photos, setPhotos] = useState<PhotoDraft[]>(() => readDraft(scope))
  const [error, setError] = useState('')
  const current = useRef(photos)
  const owner = useRef({ scope, epoch })
  const jobs = useRef(new Map<string, AbortController>())
  const urls = useRef(new Map<string, string>())
  const queue = useRef(Promise.resolve())
  const generation = useRef(0)
  const disposed = useRef(false)
  const photoOwners = useRef(new Map(photos.map(photo => [photo.id, scope])))

  const update = (next: PhotoDraft[]) => {
    current.current = next

    for (const photo of next) {
      photoOwners.current.set(photo.id, owner.current.scope)
    }

    setPhotos(next)
    persist(owner.current.scope, next)
  }

  const release = (id: string) => {
    jobs.current.get(id)?.abort()
    jobs.current.delete(id)
    const url = urls.current.get(id)

    if (url) {
      URL.revokeObjectURL(url)
      urls.current.delete(id)
    }
  }

  useLayoutEffect(() => {
    if (owner.current.scope === scope && owner.current.epoch === epoch) {
      return
    }

    const adopt = adoptNewSession && owner.current.epoch === epoch && owner.current.scope.endsWith(',null]')
    persist(owner.current.scope, current.current)
    generation.current++

    for (const id of jobs.current.keys()) {
      release(id)
    }

    for (const id of urls.current.keys()) {
      release(id)
    }

    const next = adopt
      ? current.current.filter(p => p.status === 'ready').map(p => ({ ...p, preview: undefined }))
      : readDraft(scope)

    if (adopt) {
      persist(owner.current.scope, [])
    }

    owner.current = { scope, epoch }
    update(next)
    setError('')
  }, [scope, epoch, adoptNewSession]) // Sending only permits the new-draft → created-session adoption, never explicit navigation.
  useEffect(() => {
    disposed.current = false
    const lifetime = generation
    const pending = jobs.current
    const previews = urls.current

    return () => {
      disposed.current = true
      lifetime.current++

      for (const abort of pending.values()) {
        abort.abort()
      }

      for (const url of previews.values()) {
        URL.revokeObjectURL(url)
      }
    }
  }, [])

  const add = (files: File[]) => {
    const admitted: Array<{ file: File; photo: PhotoDraft; abort: AbortController }> = []
    const batch = [...current.current]

    for (const file of files) {
      if (!MIME_TYPES.has(file.type.toLowerCase())) {
        setError('仅支持 JPEG、PNG、GIF、WebP、BMP；HEIC/HEIF 请先转为 JPEG。')

        continue
      }

      if (!file.size || file.size > MAX_PHOTO_BYTES) {
        setError('单张照片需大于 0 且不超过 20 MB。')

        continue
      }

      if (batch.length >= MAX_PHOTOS || batch.reduce((sum, p) => sum + p.bytes, 0) + file.size > MAX_BATCH_BYTES) {
        setError('最多添加 4 张照片，总大小不超过 50 MB。')

        break
      }

      const id = crypto.randomUUID()
      const preview = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined

      if (preview) {
        urls.current.set(id, preview)
      }

      const photo: PhotoDraft = { id, name: file.name.slice(0, 128), bytes: file.size, status: 'uploading', preview }
      const abort = new AbortController()
      jobs.current.set(id, abort)
      batch.push(photo)
      admitted.push({ file, photo, abort })
    }

    update(batch)
    const token = generation.current
    const requestScope = owner.current.scope

    for (const { file, photo, abort } of admitted) {
      queue.current = queue.current.then(async () => {
        const valid = () =>
          !disposed.current &&
          token === generation.current &&
          requestScope === owner.current.scope &&
          !abort.signal.aborted &&
          current.current.some(p => p.id === photo.id)

        if (!valid()) {
          return
        }

        const deadline = setTimeout(() => abort.abort(), 60_000)

        try {
          const body = await dataUrl(file, abort.signal)

          if (!valid()) {
            return
          }

          const result = await api.request<{ ok: boolean; path: string }>(
            `/api/chat/image-upload?profile=${encodeURIComponent(profile)}`,
            {
              method: 'POST',
              body: JSON.stringify({ filename: file.name, data_url: body }),
              signal: abort.signal
            }
          )

          if (!valid()) {
            return
          }

          if (!result.ok || !isPhotoPath(result.path)) {
            throw new Error('上传未返回有效的照片路径。')
          }

          update(current.current.map(p => (p.id === photo.id ? { ...p, status: 'ready', path: result.path } : p)))
        } catch (cause) {
          if (
            !disposed.current &&
            token === generation.current &&
            requestScope === owner.current.scope &&
            current.current.some(p => p.id === photo.id)
          ) {
            const message = abort.signal.aborted
              ? '照片上传已超时，请移除后重选。'
              : cause instanceof Error
                ? cause.message
                : '照片上传失败，请移除后重选。'

            update(current.current.map(p => (p.id === photo.id ? { ...p, status: 'failed', error: message } : p)))
          }
        } finally {
          clearTimeout(deadline)
          jobs.current.delete(photo.id)
        }
      })
    }
  }

  const remove = (ids: string[]) => {
    for (const id of ids) {
      release(id)
    }

    update(current.current.filter(p => !ids.includes(p.id)))
  }

  const complete = (ids: string[]) => {
    const scopes = new Set(ids.map(id => photoOwners.current.get(id)).filter((key): key is string => Boolean(key)))

    for (const key of scopes) {
      persist(
        key,
        readDraft(key).filter(photo => !ids.includes(photo.id))
      )
    }

    remove(ids)

    for (const id of ids) {
      photoOwners.current.delete(id)
    }
  }

  return {
    photos,
    error,
    dismissError: () => setError(''),
    add,
    remove,
    complete,
    blocked: photos.some(p => p.status !== 'ready')
  }
}
