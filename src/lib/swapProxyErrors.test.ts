import { describe, it, expect } from 'vitest'
import { classifyProxyConnectionFailure } from './swapProxyErrors'

// Regression guard for "swap shows failed even though the transaction
// completed": a dropped connection to /api/swap-proxy (client AbortController
// firing, or fetch() itself throwing — e.g. Vercel's function execution
// limit killing the request mid-swap) can happen AFTER kit.swap() already
// broadcast on-chain. The thrown error's message text already said "it may
// still complete... to avoid a double spend", but the `.isUncertain` flag
// SwapPage's executeSwap catch actually reads was never set — so every
// connection failure during a swap landed on the hard "Swap Failed" screen
// (and wrote a false 'failed' Activity row) regardless of what the message
// said.
describe('classifyProxyConnectionFailure', () => {
  it('marks a swap-action timeout as uncertain (double-spend risk)', () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const { message, isUncertain } = classifyProxyConnectionFailure('swap', abortErr)
    expect(isUncertain).toBe(true)
    expect(message).toMatch(/may still complete/i)
    expect(message).toMatch(/double spend/i)
  })

  it('marks a swap-action raw network failure as uncertain too', () => {
    const networkErr = new TypeError('Failed to fetch')
    const { isUncertain } = classifyProxyConnectionFailure('swap', networkErr)
    expect(isUncertain).toBe(true)
  })

  it('does NOT mark an estimate-action failure as uncertain — nothing broadcasts during a quote', () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const networkErr = new TypeError('Failed to fetch')
    expect(classifyProxyConnectionFailure('estimate', abortErr).isUncertain).toBe(false)
    expect(classifyProxyConnectionFailure('estimate', networkErr).isUncertain).toBe(false)
  })

  it('preserves the underlying error message for a raw network failure', () => {
    const networkErr = new TypeError('Failed to fetch')
    const { message } = classifyProxyConnectionFailure('swap', networkErr)
    expect(message).toBe('Failed to fetch')
  })

  it('falls back to a generic message when the raw error has none', () => {
    const { message } = classifyProxyConnectionFailure('swap', {})
    expect(message).toMatch(/network error/i)
  })
})
