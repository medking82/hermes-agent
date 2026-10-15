import { describe, expect, it } from 'vitest'

import { draftKey, projectMatches, shouldSubmitKey, viewportGeometry } from './input'

describe('iOS composition and keyboard policy', () => {
  it('does not hide full-text hits behind an invisible project filter', () => {
    expect(projectMatches('/project', 'search', undefined)).toBe(true)
    expect(projectMatches('/project', '', '/project')).toBe(true)
    expect(projectMatches('/project', '', '/other')).toBe(false)
  })
  it('only submits explicit modified Enter, never candidate confirmation', () => {
    const base = { key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, isComposing: false, keyCode: 13 }
    expect(shouldSubmitKey(base, false)).toBe(false)
    expect(shouldSubmitKey({ ...base, metaKey: true }, false)).toBe(true)
    expect(shouldSubmitKey({ ...base, ctrlKey: true }, false)).toBe(true)
    expect(shouldSubmitKey({ ...base, metaKey: true, isComposing: true }, false)).toBe(false)
    expect(shouldSubmitKey({ ...base, metaKey: true, keyCode: 229 }, false)).toBe(false)
    expect(shouldSubmitKey({ ...base, metaKey: true }, true)).toBe(false)
    expect(shouldSubmitKey({ ...base, metaKey: true, shiftKey: true }, false)).toBe(false)
  })
  it('uses the visible viewport without zoom-induced keyboard jumps', () => {
    expect(viewportGeometry(844, { height: 494, offsetTop: 0, scale: 1 })).toEqual({ height: 494, top: 0 })
    expect(viewportGeometry(844, { height: 400, offsetTop: 15, scale: 2 })).toEqual({ height: 844, top: 0 })
  })
  it('keeps drafts isolated by profile and durable conversation identity', () => {
    expect(draftKey('default', 'same')).not.toBe(draftKey('other', 'same'))
    expect(draftKey('default', null)).not.toBe(draftKey('default', 'same'))
  })
})
