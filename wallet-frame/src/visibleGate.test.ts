import { describe, it, expect } from 'vitest'
import { watchVisible, MIN_VISIBLE_MS, BLIP_MS } from './visibleGate'

// A fake IntersectionObserver v2 the test can drive, and a fake clock.
function setup() {
  let t = 1000
  let cb: ((e: Array<{ isVisible?: boolean }>) => void) | null = null
  class FakeIO {
    trackVisibility = true
    constructor(c: typeof cb) { cb = c }
    observe() {}
    disconnect() {}
  }
  const gate = watchVisible({ IO: FakeIO as never, now: () => t, target: {} as Element })
  return {
    gate,
    report: (isVisible: boolean | undefined) => cb!([{ isVisible }]),
    advance: (ms: number) => { t += ms },
  }
}

describe('watchVisible', () => {
  it('lets input through where there is no IntersectionObserver', () => {
    expect(watchVisible({ IO: undefined, now: () => 0 }).ok()).toBe(true)
  })

  it('refuses until the browser has said the page is in view', () => {
    const s = setup()
    expect(s.gate.ok()).toBe(false)
  })

  it('counts a tap only after the page has been in view for a while', () => {
    const s = setup()
    s.report(true)
    expect(s.gate.ok()).toBe(false)
    s.advance(MIN_VISIBLE_MS - 1)
    expect(s.gate.ok()).toBe(false)
    s.advance(1)
    expect(s.gate.ok()).toBe(true)
  })

  it('refuses while covered, and restarts the wait when it is uncovered', () => {
    const s = setup()
    s.report(true); s.advance(MIN_VISIBLE_MS)
    s.report(false); s.advance(BLIP_MS + 1)
    expect(s.gate.ok()).toBe(false)
    s.report(true)
    expect(s.gate.ok()).toBe(false)
    s.advance(MIN_VISIBLE_MS)
    expect(s.gate.ok()).toBe(true)
  })

  it('lets a tap through a short blip after a settled stretch', () => {
    const s = setup()
    s.report(true); s.advance(MIN_VISIBLE_MS + 50)
    s.report(false); s.advance(BLIP_MS - 100)
    expect(s.gate.ok()).toBe(true)
    s.advance(200)
    expect(s.gate.ok()).toBe(false)
  })

  it('does not grant a blip allowance to a page that never settled', () => {
    const s = setup()
    s.report(true); s.advance(MIN_VISIBLE_MS - 100)
    s.report(false)
    expect(s.gate.ok()).toBe(false)
  })

  it('ignores v1-only readings', () => {
    const s = setup()
    s.report(undefined); s.advance(MIN_VISIBLE_MS * 2)
    expect(s.gate.ok()).toBe(false)
  })
})
