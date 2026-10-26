import { describe, it, expect, vi } from 'vitest'
import { onVitePreloadError, isChunkLoadError } from './lazyRetry'

// Vite 5's preload helper, as it handles a failed import(): it dispatches a
// cancelable 'vite:preloadError' and only rethrows when nobody cancelled it.
async function vitePreload<T>(base: () => Promise<T>, listener: (e: Event) => void): Promise<T | undefined> {
  const target = new EventTarget()
  target.addEventListener('vite:preloadError', listener)
  const handle = (err: unknown) => {
    const e = new Event('vite:preloadError', { cancelable: true }) as Event & { payload?: unknown }
    e.payload = err
    target.dispatchEvent(e)
    if (!e.defaultPrevented) throw err
  }
  return base().catch(handle) as Promise<T | undefined>
}

describe('stale build: a file of an older version fails to load', () => {
  const missingChunk = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/PasscodeSetup-OLD.js'))

  it("the app's preload listener lets the import throw (it used to resolve undefined)", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = await vitePreload(missingChunk, onVitePreloadError).then(() => null, e => e)
    expect(err).toBeInstanceOf(TypeError)
    // ...and as a stale-build error, so lazyRetry reloads instead of the error screen.
    expect(isChunkLoadError(err)).toBe(true)
  })

  it('a cancelling listener is what produced "reading \'PasscodeLockPage\'"', async () => {
    const m = await vitePreload(missingChunk, e => e.preventDefault())
    expect(m).toBeUndefined()
    expect(() => (m as any).PasscodeLockPage).toThrow(/Cannot read properties of undefined/)
  })
})
