// supabase/functions/blockchain-indexer/depositActivityConsumerLive.test.ts
import { parseEscrowAddresses } from './escrowConfig.ts'
import { isKnownInternalContract } from '../_shared/knownInternalContracts.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

const CURRENT_ESCROW = '0xEscrowCurrent0000000000000000000000001'.toLowerCase()
const LEGACY_ESCROW_1 = '0xEscrowLegacy10000000000000000000000002'.toLowerCase()
const LEGACY_ESCROW_2 = '0xEscrowLegacy20000000000000000000000003'.toLowerCase()
const EXTERNAL_SENDER = '0x1111111111111111111111111111111111111111'

// ── parseEscrowAddresses: pure config parsing ───────────────────────────
Deno.test('parseEscrowAddresses: reads the current + legacy (comma-separated) server-side secrets, matching p2p-release-reconcile\'s own parsing exactly', () => {
  const result = parseEscrowAddresses(CURRENT_ESCROW, `${LEGACY_ESCROW_1}, ${LEGACY_ESCROW_2}`)
  assertEquals(result, [CURRENT_ESCROW, LEGACY_ESCROW_1, LEGACY_ESCROW_2])
})

Deno.test('parseEscrowAddresses: unset env vars produce an empty list, never a fabricated address', () => {
  assertEquals(parseEscrowAddresses(undefined, undefined), [])
  assertEquals(parseEscrowAddresses('', ''), [])
})

Deno.test('parseEscrowAddresses: blank/whitespace-only legacy entries are dropped', () => {
  assertEquals(parseEscrowAddresses(CURRENT_ESCROW, ' , ,'), [CURRENT_ESCROW])
})

// ── Bug 3: escrow -> wallet refund must be excluded from external deposit ──
Deno.test('a P2P escrow refund (sender == configured escrow contract) is recognized as internal via isKnownInternalContract + extra', () => {
  const extra = parseEscrowAddresses(CURRENT_ESCROW, LEGACY_ESCROW_1)
  assertEquals(isKnownInternalContract(CURRENT_ESCROW, extra), true)
  assertEquals(isKnownInternalContract(LEGACY_ESCROW_1, extra), true, 'a legacy (rotated) escrow contract must also be excluded, not just the current one')
})

Deno.test('a P2P escrow refund is excluded even though it is NOT in the static KNOWN_INTERNAL_CONTRACTS list (it is deployment-specific, correctly supplied only via extra)', () => {
  assertEquals(isKnownInternalContract(CURRENT_ESCROW), false, 'without extra, the escrow address is correctly unrecognized -- proving this genuinely depends on the env-supplied extra, not a hardcoded guess')
  assertEquals(isKnownInternalContract(CURRENT_ESCROW, [CURRENT_ESCROW]), true)
})

// ── Normal external sender must still work ──────────────────────────────
Deno.test('a normal external sender (not the escrow, not any known internal contract) is still correctly treated as external', () => {
  const extra = parseEscrowAddresses(CURRENT_ESCROW, LEGACY_ESCROW_1)
  assertEquals(isKnownInternalContract(EXTERNAL_SENDER, extra), false)
})

Deno.test('when no escrow is configured at all (parseEscrowAddresses returns []), a normal external sender is unaffected', () => {
  assertEquals(isKnownInternalContract(EXTERNAL_SENDER, parseEscrowAddresses(undefined, undefined)), false)
})
