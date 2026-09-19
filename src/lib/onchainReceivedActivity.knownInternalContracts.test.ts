// src/lib/onchainReceivedActivity.knownInternalContracts.test.ts
//
// Regression guard for reported bug: a BulkPay recipient got a correct
// "Received $X via bulk payout" notification AND a second, bogus
// "$X Received from 0xca11...76ca11" notification (with a matching
// duplicate/misclassified 'receive' row in Activity History) for the exact
// same transfer.
//
// Root cause: BulkPayoutPage.tsx routes every payout through the Multicall3
// contract (0xcA11bde05977b3631167028862be2A173976CA11) — each recipient's
// individual transfer is forwarded BY Multicall3, so its Transfer/native
// value-transfer log legitimately shows `from = Multicall3`, not the real
// sender. Every server-side copy of the "known internal contract senders"
// exclusion list (deposit-scan-all/index.ts, activity-consumer/decide.ts,
// ledger-interpret/classifiers.ts, server/ledger/classifiers.ts,
// blockchain-indexer/compare.ts, and the canonical
// supabase/functions/_shared/knownInternalContracts.ts) already excludes
// Multicall3. This file's client-side copy — used by both itself and, via
// re-export, lib/arcDepositWatcher.ts's real-time on-chain log watcher — was
// the one copy still missing it, so the live, in-browser watcher kept
// treating every BulkPay leg as a genuine, unrecognized external deposit.

import { describe, it, expect, vi } from 'vitest'
import { KNOWN_INTERNAL_CONTRACTS } from './onchainReceivedActivity'

const MULTICALL3 = '0xcA11bde05977b3631167028862be2A173976CA11'

describe('onchainReceivedActivity KNOWN_INTERNAL_CONTRACTS', () => {
  it('excludes Multicall3 (BulkPay routing contract), case-insensitively', () => {
    expect(KNOWN_INTERNAL_CONTRACTS.has(MULTICALL3.toLowerCase())).toBe(true)
  })

  it('still excludes every pre-existing swap/bridge/CCTP infra contract (no regression)', () => {
    const expected = [
      '0x0077777d7eba4688bdef3e311b846f25870a19b9',
      '0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5',
      '0x7865fafc2db2093669d92c0f33aeef291086befd',
      '0xacf1ceef35caac005e15888ddb8a3515c41b4872',
      '0xc5567a5e3370d4dbfb0540025078e283e36a363d',
      '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b',
      '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
      '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
    ]
    for (const addr of expected) expect(KNOWN_INTERNAL_CONTRACTS.has(addr)).toBe(true)
  })

  it('does NOT exclude an arbitrary real external wallet (sanity check the set isn\u2019t overly broad)', () => {
    expect(KNOWN_INTERNAL_CONTRACTS.has('0x000000000000000000000000000000000000ff')).toBe(false)
  })
})

// Regression guard for a related bug: cancelling a P2P offer and
// withdrawing escrow back to the seller's own wallet produced a normal
// "USDC received from 0x2a31...7976" notification, indistinguishable from
// a genuine external payment — because the P2P escrow contract's address
// was never in this exclusion list at all (unlike Multicall3 above, this
// wasn't a missing entry in an otherwise-complete list; the address is
// only known at runtime, from VITE_P2P_ESCROW_CONTRACT, so it has to be
// added dynamically rather than hardcoded). Uses vi.stubEnv + a fresh
// module import specifically because CONTRACT_ADDRESS is read once at
// module-load time in p2pEscrowContract.ts — stubbing the env var after
// this file's top-level import already ran would have no effect.
describe('onchainReceivedActivity KNOWN_INTERNAL_CONTRACTS — P2P escrow address', () => {
  it('includes the configured P2P escrow contract address, lowercased', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_P2P_ESCROW_CONTRACT', '0x2A316Db06E4C481a5986BF2608277DdD3B787976')
    const fresh = await import('./onchainReceivedActivity')
    expect(fresh.KNOWN_INTERNAL_CONTRACTS.has('0x2a316db06e4c481a5986bf2608277ddd3b787976')).toBe(true)
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('adds nothing extra when no contract is configured (no false-positive suppression)', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_P2P_ESCROW_CONTRACT', '')
    const fresh = await import('./onchainReceivedActivity')
    // Every pre-existing entry is still there, and nothing empty/bogus got added.
    expect(fresh.KNOWN_INTERNAL_CONTRACTS.has('0xca11bde05977b3631167028862be2a173976ca11')).toBe(true)
    expect(fresh.KNOWN_INTERNAL_CONTRACTS.has('')).toBe(false)
    vi.unstubAllEnvs()
    vi.resetModules()
  })
})
