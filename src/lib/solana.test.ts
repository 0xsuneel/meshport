import { describe, it, expect } from 'vitest'
import { getSolanaUsdcBalance, isSolanaAddress, SOLANA_USDC_MINT, solanaExplorerUrl } from './solana'

const OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'

describe('solana helpers', () => {
  it('recognises Solana addresses (base58, 32-44 chars) and rejects others', () => {
    expect(isSolanaAddress(OWNER)).toBe(true)
    expect(isSolanaAddress(SOLANA_USDC_MINT)).toBe(true)
    expect(isSolanaAddress('0x5d00ab75bcbe15450143f810cd5e5164ee126e0')).toBe(false)
    expect(isSolanaAddress('0OIl' + 'a'.repeat(40))).toBe(false) // 0, O, I, l are not base58
  })

  it('explorer links point at devnet', () => {
    expect(solanaExplorerUrl('tx', 'abc')).toBe('https://explorer.solana.com/tx/abc?cluster=devnet')
  })

  it('USDC balance: asks for this mint, sums token accounts exactly, formats 6 decimals', async () => {
    let body: any
    const fake = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      const acct = (amount: string) => ({ account: { data: { parsed: { info: { tokenAmount: { amount, decimals: 6 } } } } } })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [acct('1500000'), acct('250001')] } }))
    }) as unknown as typeof fetch
    expect(await getSolanaUsdcBalance(OWNER, fake)).toBe('1.750001')
    expect(body.method).toBe('getTokenAccountsByOwner')
    expect(body.params[1]).toEqual({ mint: SOLANA_USDC_MINT })

    const empty = (async () => new Response(JSON.stringify({ result: { value: [] } }))) as unknown as typeof fetch
    expect(await getSolanaUsdcBalance(OWNER, empty)).toBe('0')
    await expect(getSolanaUsdcBalance('0xnot-solana')).rejects.toThrow(/Solana address/)
  })
})
