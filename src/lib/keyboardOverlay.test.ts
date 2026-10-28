import { describe, it, expect, beforeEach, vi } from 'vitest'

// The keyboard is drawn over the page only while an app frame holds it.
describe('holdKeyboardOverlay', () => {
  let vk: { overlaysContent: boolean }
  beforeEach(() => {
    vi.resetModules()
    vk = { overlaysContent: false }
    vi.stubGlobal('navigator', { virtualKeyboard: vk })
    vi.stubGlobal('window', { matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' }) })
  })

  it('on while held, off once released', async () => {
    const { holdKeyboardOverlay } = await import('./keyboardOverlay')
    const release = holdKeyboardOverlay()
    expect(vk.overlaysContent).toBe(true)
    release()
    expect(vk.overlaysContent).toBe(false)
  })

  it('two frames overlapping (page change): stays on until both are gone', async () => {
    const { holdKeyboardOverlay } = await import('./keyboardOverlay')
    const a = holdKeyboardOverlay()
    const b = holdKeyboardOverlay()
    a()
    expect(vk.overlaysContent).toBe(true)
    a() // releasing twice changes nothing
    expect(vk.overlaysContent).toBe(true)
    b()
    expect(vk.overlaysContent).toBe(false)
  })

  it('desktop (no touch screen): never switched on', async () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    const { holdKeyboardOverlay } = await import('./keyboardOverlay')
    holdKeyboardOverlay()
    expect(vk.overlaysContent).toBe(false)
  })
})
