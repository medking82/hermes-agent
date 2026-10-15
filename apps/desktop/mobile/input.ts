export interface SubmitKey {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  isComposing: boolean
  keyCode: number
}

export function shouldSubmitKey(event: SubmitKey, composing: boolean): boolean {
  return (
    event.key === 'Enter' &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !composing &&
    !event.isComposing &&
    event.keyCode !== 229
  )
}

export function viewportGeometry(
  layoutHeight: number,
  viewport?: { height: number; offsetTop: number; scale: number } | null
) {
  return viewport && viewport.scale === 1
    ? { height: viewport.height, top: viewport.offsetTop }
    : { height: layoutHeight, top: 0 }
}

export function projectMatches(project: string, query: string, path?: string | null): boolean {
  return Boolean(query.trim()) || !project || path === project
}

export function draftKey(profile: string, storedId: string | null): string {
  return `hermes-web:draft:${JSON.stringify([profile, storedId])}`
}
