import { describe, it, expect } from 'vitest'

import { createSingleFlight as makeOnce } from './useSingleFlight'

describe('useSingleFlight logic', () => {
  it('ignores a second call while the first is still running', async () => {
    const once = makeOnce()
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const a = once(async () => { calls++; await gate; return 'first' })
    const b = once(async () => { calls++; return 'second' })
    expect(await b).toBeUndefined()
    release()
    expect(await a).toBe('first')
    expect(calls).toBe(1)
  })

  it('allows a new run after the previous one settles, also after an error', async () => {
    const once = makeOnce()
    await expect(once(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await once(async () => 2)).toBe(2)
  })

  it('releases the lock when the action throws synchronously', async () => {
    const once = makeOnce()
    await expect(once((() => { throw new Error('sync') }) as () => Promise<never>)).rejects.toThrow('sync')
    expect(await once(async () => 'ok')).toBe('ok')
  })
})
