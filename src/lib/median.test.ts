import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

let store: Map<string, string>
beforeEach(() => {
  store = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } })
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.useRealTimers() })

describe('syncMedianStatusBar', () => {
  it('does nothing outside a Median app', async () => {
    vi.stubGlobal('window', {} as Window)
    const { syncMedianStatusBar } = await import('./median')
    expect(() => syncMedianStatusBar('dark')).not.toThrow()
  })

  it('sets the page colour with readable icons, drawn behind the page (overlay)', async () => {
    const set = vi.fn()
    vi.stubGlobal('window', { median: { statusbar: { set } } })
    store.set('mp_statusbar_overlay', 'yes')
    const { syncMedianStatusBar } = await import('./median')
    syncMedianStatusBar('light')
    syncMedianStatusBar('dark')
    expect(set.mock.calls).toEqual([
      [{ style: 'dark', color: 'F5F4F0', overlay: true }],
      [{ style: 'light', color: '000000', overlay: true }],
    ])
  })

  it('a web view with no top inset under the overlay goes back to the solid bar, and remembers', async () => {
    vi.useFakeTimers()
    const set = vi.fn()
    vi.stubGlobal('window', { median: { statusbar: { set } } })
    const { syncMedianStatusBar } = await import('./median') // no document → top inset 0
    syncMedianStatusBar('light')
    expect(set).toHaveBeenLastCalledWith({ style: 'dark', color: 'F5F4F0', overlay: true })
    vi.advanceTimersByTime(700)
    expect(set).toHaveBeenLastCalledWith({ style: 'dark', color: 'F5F4F0', overlay: false })
    expect(store.get('mp_statusbar_overlay')).toBe('no')
    syncMedianStatusBar('dark')
    expect(set).toHaveBeenLastCalledWith({ style: 'light', color: '000000', overlay: false })
  })

  it('waits for the bridge and applies the latest theme once it is ready', async () => {
    store.set('mp_statusbar_overlay', 'no')
    const earlier = vi.fn()
    const w: any = { median_library_ready: earlier }
    vi.stubGlobal('window', w)
    const { syncMedianStatusBar } = await import('./median')
    syncMedianStatusBar('light')
    syncMedianStatusBar('dark')
    const set = vi.fn()
    w.median = { statusbar: { set } }
    w.median_library_ready()
    expect(earlier).toHaveBeenCalled()
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({ style: 'light', color: '000000', overlay: false })
  })
})
