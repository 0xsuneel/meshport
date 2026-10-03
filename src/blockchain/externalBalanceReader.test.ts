import { describe, it, expect, vi, afterEach } from 'vitest'
import { readChainUSDCBalance } from './externalBalanceReader'
import { EXTERNAL_CHAINS } from './chains'

const WALLET = '0x' + '11'.repeat(20)
const ok = (units: bigint) => ({ ok: true, json: async () => ({ result: '0x' + units.toString(16) }) })

describe('readChainUSDCBalance', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
  const chain = Object.keys(EXTERNAL_CHAINS).find(id => EXTERNAL_CHAINS[id].rpcs.length >= 2)!
  const dec = EXTERNAL_CHAINS[chain].decimals

  it('falls back right away when the first endpoint fails', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(ok(5n * 10n ** BigInt(dec)))
    vi.stubGlobal('fetch', fetchMock)
    expect(await readChainUSDCBalance(chain, WALLET)).toBe(5)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('asks the next endpoint when the first is slow, first answer wins', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(ok(7n * 10n ** BigInt(dec)))
    vi.stubGlobal('fetch', fetchMock)
    const p = readChainUSDCBalance(chain, WALLET)
    await vi.advanceTimersByTimeAsync(1_300)
    expect(await p).toBe(7)
  })

  it('keeps the last good balance when every endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(3n * 10n ** BigInt(dec))))
    expect(await readChainUSDCBalance(chain, WALLET)).toBe(3)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    expect(await readChainUSDCBalance(chain, WALLET)).toBe(3)
  })
})
