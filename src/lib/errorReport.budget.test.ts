import { describe, it, expect, vi, beforeEach } from 'vitest'

const inserts: any[] = []
vi.mock('./supabase', () => ({ supabase: { from: () => ({ insert: (row: any) => { inserts.push(row); return Promise.resolve({ error: null }) } }) } }))
vi.mock('./lazyRetry', () => ({ isChunkLoadError: () => false }))

describe('client_errors: a failure report is never crowded out or dropped offline', () => {
  beforeEach(() => {
    vi.resetModules(); inserts.length = 0
    vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/multichain' } }))
    vi.stubGlobal('document', { querySelector: () => null })
  })

  it('routine timing lines do not use the failure budget', async () => {
    vi.stubGlobal('navigator', { onLine: true, userAgent: 'test' })
    const { reportClientError } = await import('./errorReport')
    for (let i = 0; i < 12; i++) reportClientError('rejection', new Error(`[privy timeline] since page load: ${i}`))
    reportClientError('rejection', new Error('[privy warm-up] slow: 3.6 s'))
    reportClientError('rejection', new Error('[transfer stage] ub Base: still on "deposit" after 8 s'))
    reportClientError('rejection', new Error('[transfer no signer] source=privy'))
    expect(inserts.some(r => r.message.startsWith('[transfer no signer]'))).toBe(true)
  })

  it('written while offline: held, then sent when the connection is back', async () => {
    const nav = { onLine: false, userAgent: 'test' }
    vi.stubGlobal('navigator', nav)
    const { reportClientError } = await import('./errorReport')
    reportClientError('rejection', new Error('[transfer no signer] source=privy'))
    expect(inserts).toHaveLength(0)
    nav.onLine = true
    window.dispatchEvent(new Event('online'))
    expect(inserts.map(r => r.message)).toEqual(['[transfer no signer] source=privy'])
  })
})
