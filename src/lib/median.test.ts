import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

describe('syncMedianStatusBar', () => {
  it('does nothing outside a Median app', async () => {
    vi.stubGlobal('window', {} as Window)
    const { syncMedianStatusBar } = await import('./median')
    expect(() => syncMedianStatusBar('dark')).not.toThrow()
  })

  it('sets the page colour with readable icons', async () => {
    const set = vi.fn()
    vi.stubGlobal('window', { median: { statusbar: { set } } })
    const { syncMedianStatusBar } = await import('./median')
    syncMedianStatusBar('light')
    syncMedianStatusBar('dark')
    expect(set.mock.calls).toEqual([
      [{ style: 'dark', color: 'F5F4F0', overlay: false }],
      [{ style: 'light', color: '000000', overlay: false }],
    ])
  })

  it('waits for the bridge and applies the latest theme once it is ready', async () => {
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
