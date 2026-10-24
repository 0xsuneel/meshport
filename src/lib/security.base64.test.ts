import { describe, it, expect } from 'vitest'
import { fromBase64, toBase64 } from './security'

describe('device-seal base64 helpers', () => {
  it('handle an MPC key share sized buffer (spreading one into fromCharCode throws past ~65 KB)', () => {
    for (const n of [0, 1, 32, 65_535, 65_536, 300_000, 1_000_000]) {
      const bytes = crypto.getRandomValues(new Uint8Array(Math.min(n, 65_536)))
      const big = new Uint8Array(n)
      for (let i = 0; i < n; i += bytes.length || 1) big.set(bytes.subarray(0, Math.min(bytes.length, n - i)), i)
      const b64 = toBase64(big)
      expect(b64).toBe(Buffer.from(big).toString('base64')) // standard base64, same as before
      expect(fromBase64(b64)).toEqual(big)
    }
  })
})
