import { describe, it, expect, beforeEach, vi } from 'vitest'

// Minimal browser pieces this module touches (the test env is node).
const store = new Map<string, string>()
const writes: string[] = []
let writeFails = false
const listeners = new Map<string, Set<() => void>>()
const on = (t: string, f: () => void) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(f) }
const off = (t: string, f: () => void) => listeners.get(t)?.delete(f)
const fire = (t: string) => [...(listeners.get(t) ?? [])].forEach(f => f())
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) })
vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => { if (writeFails) throw new Error('NotAllowedError'); writes.push(t) } } })
vi.stubGlobal('window', { addEventListener: on, removeEventListener: off })
vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: on, removeEventListener: off })

const mod = await import('./secretClipboard')

describe('secretClipboard', () => {
  beforeEach(() => { store.clear(); writes.length = 0; writeFails = false; listeners.clear(); mod.noteOtherClipboardWrite(); vi.useRealTimers() })

  it('clears the clipboard once the delay has passed - never before', async () => {
    const t0 = 1_000_000
    mod.scheduleSecretClipboardClear(t0)
    expect(await mod.clearSecretClipboardIfDue(t0 + mod.SECRET_CLEAR_MS - 1)).toBe(false)
    expect(writes).toEqual([])
    expect(await mod.clearSecretClipboardIfDue(t0 + mod.SECRET_CLEAR_MS)).toBe(true)
    expect(writes).toEqual([''])
  })

  it('without focus at the due time, clears on the next return to the app', async () => {
    mod.scheduleSecretClipboardClear(Date.now() - mod.SECRET_CLEAR_MS)
    writeFails = true
    expect(await mod.clearSecretClipboardIfDue()).toBe(false)
    writeFails = false
    fire('visibilitychange')
    await new Promise(r => setTimeout(r, 0))
    expect(writes).toEqual([''])
    expect(store.size).toBe(0)
  })

  it('a pending clear survives a restart (kept in storage) and runs on init', async () => {
    store.set('mp_secret_clipboard_clear_at', String(Date.now() - 1))
    mod.initSecretClipboard()
    await new Promise(r => setTimeout(r, 5))
    expect(writes).toEqual([''])
  })

  it('a newer copy in the app cancels the clear, so it is never wiped', async () => {
    mod.scheduleSecretClipboardClear(Date.now() - mod.SECRET_CLEAR_MS)
    mod.noteOtherClipboardWrite()
    expect(await mod.clearSecretClipboardIfDue()).toBe(true)
    expect(writes).toEqual([])
  })
})
