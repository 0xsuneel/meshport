import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Regression guard for the "Polygon Amoy / Monad / Sei claim fails even
// though the relay funded gas" bug: bridgeWithPreapprovalAndHook (selector
// 0x513e1175) is the call every claim's burn actually goes through on
// chains where kitContracts.bridge is configured (broadly, per the
// installed @circle-fin SDK — see this constant's own doc comment in both
// files below), and THAT call path uses the adapter's real
// contractFunction.estimateGas(...) — meaning this proxy's hardcoded
// eth_estimateGas response becomes the signed transaction's actual
// gasLimit. 700,000 was enough for 18 of 21 chains but not Polygon Amoy,
// Monad, or Sei; api/relay-rpc.js's own eth_sendRawTransaction funds
// gasLimit × gasPrice DECODED FROM THE SIGNED TX, so "gas was funded" and
// "the burn still reverted out of gas" are simultaneously true — the
// funding step has no way to know the signed limit itself was too low.
//
// This test doesn't execute the RPC handler (no live relay key/RPC in CI)
// — it asserts the source itself still carries the raised ceiling in every
// spot that needs to move together, so a future edit can't quietly
// reintroduce the mismatch, or silently lower ONE copy without the other,
// which is exactly the "fell out of sync" bug this exact pair of files
// already hit once before (see MultichainClaimPage.tsx's own doc comment
// above buildGasSponsoredProvider).
describe('CCTP burn gas-limit ceiling stays raised and in sync', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const relayRpcSrc = readFileSync(resolve(here, '../../api/relay-rpc.js'), 'utf8')
  const claimPageSrc = readFileSync(resolve(here, '../features/multichain/MultichainClaimPage.tsx'), 'utf8')

  it('api/relay-rpc.js: bridgeWithPreapprovalAndHook selector and its to-fallback are both 1,500,000 gas (0x16e360)', () => {
    expect((relayRpcSrc.match(/'0x513e1175': '0x16e360'/) ?? []).length).toBe(1)
    expect((relayRpcSrc.match(/'0x35093510': '0x16e360'/) ?? []).length).toBe(1)
    expect(relayRpcSrc).toMatch(/CIRCLE_CONTRACTS\.has\(to\) \? '0x16e360'/)
    // The stale 700,000 (0xaae60) ceiling must be gone from these exact spots
    expect(relayRpcSrc).not.toMatch(/'0x513e1175': '0xaae60'/)
    expect(relayRpcSrc).not.toMatch(/CIRCLE_CONTRACTS\.has\(to\) \? '0xaae60'/)
  })

  it('api/relay-rpc.js: pre-flight funding buffers cover the raised ceiling (0.004 ETH-equivalent)', () => {
    expect(relayRpcSrc).toMatch(/ENSURE_FUNDED_BUFFER_WEI = 4000000000000000n/)
    expect(relayRpcSrc).toMatch(/SIMULATE_BUFFER_WEI = 4000000000000000n/)
  })

  it('MultichainClaimPage.tsx: client-side copy matches the server-side ceiling exactly', () => {
    expect((claimPageSrc.match(/'0x513e1175': '0x' \+ \(1500000\)\.toString\(16\)/) ?? []).length).toBe(1)
    expect((claimPageSrc.match(/'0x35093510': '0x' \+ \(1500000\)\.toString\(16\)/) ?? []).length).toBe(1)
    expect(claimPageSrc).toMatch(/CIRCLE_CONTRACTS\.has\(toAddr\) \? '0x' \+ \(1500000\)\.toString\(16\)/)
    // The stale 700,000 ceiling must be gone from these exact spots
    expect(claimPageSrc).not.toMatch(/'0x513e1175': '0x' \+ \(700000\)\.toString\(16\)/)
    expect(claimPageSrc).not.toMatch(/CIRCLE_CONTRACTS\.has\(toAddr\) \? '0x' \+ \(700000\)\.toString\(16\)/)
  })
})
