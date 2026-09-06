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

import { describe, it, expect } from 'vitest'
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
