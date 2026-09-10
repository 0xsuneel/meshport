// supabase/functions/_shared/knownInternalContracts.test.ts
//
// Tests for the sender-based classification primitive added by
// docs/CLAIM_RECOVERY_SENDER_CLASSIFICATION_FIX.md. Run with:
//   deno test supabase/functions/_shared/knownInternalContracts.test.ts
//
// Zero external imports — matches the convention already established in
// blockchain-indexer's test files (see cursorMath.test.ts's header for why).
import { KNOWN_INTERNAL_CONTRACTS, isKnownInternalContract } from './knownInternalContracts.ts'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

// Real addresses, taken directly from the static list — not fabricated.
const KIT_ADAPTER = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b'   // swap router
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'    // BulkPay
const CCTP_TOKEN_MESSENGER = '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa'
const UNKNOWN_EOA = '0x1234567890123456789012345678901234567890'
const UNKNOWN_CONTRACT = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

Deno.test('1. known swap router (Kit Adapter) is excluded', () => {
  assert(isKnownInternalContract(KIT_ADAPTER), 'Kit Adapter must be classified as internal')
})

Deno.test('2. known Multicall3 (BulkPay) is excluded', () => {
  assert(isKnownInternalContract(MULTICALL3), 'Multicall3 must be classified as internal')
})

Deno.test('3. known P2P escrow (via the `extra` runtime parameter) is excluded', () => {
  // No real P2P escrow address is hardcoded (see the module's own doc comment
  // for why) — a configured caller supplies it via `extra`, mirroring
  // p2p-release-reconcile/index.ts's own P2P_ESCROW_CONTRACT pattern.
  const configuredEscrow = '0xfeedfacefeedfacefeedfacefeedfacefeedface'
  assert(!isKnownInternalContract(configuredEscrow), 'sanity check: not internal without `extra` supplied')
  assert(isKnownInternalContract(configuredEscrow, [configuredEscrow]), 'must be excluded once supplied via `extra`')
})

Deno.test('4. known internal contract (generic, CCTP TokenMessenger) is excluded', () => {
  assert(isKnownInternalContract(CCTP_TOKEN_MESSENGER), 'CCTP TokenMessenger must be classified as internal')
})

Deno.test('5. unknown EOA remains RECEIVE-eligible (not excluded)', () => {
  assert(!isKnownInternalContract(UNKNOWN_EOA), 'an ordinary wallet address must never be excluded')
})

Deno.test('6. unknown contract remains RECEIVE-eligible (not excluded)', () => {
  assert(!isKnownInternalContract(UNKNOWN_CONTRACT), 'an unrecognized contract must never be excluded — only explicitly known ones are')
})

Deno.test('9. EURC regression — the exact traced sender (Kit Adapter) is now excluded', () => {
  // docs/ACTIVITY_WRITER_AUDIT.md §2 / docs/CLAIM_RECOVERY_AUDIT.md §5: the
  // traced duplicate's swap output leg came from the Kit Adapter Contract.
  // This is the direct regression check for that exact case.
  assert(isKnownInternalContract(KIT_ADAPTER), 'the exact EURC-case sender must be excluded')
})

Deno.test('11. case-insensitive address matching', () => {
  const upper = KIT_ADAPTER.toUpperCase().replace('0X', '0x')
  const mixed = '0xBbD70b01A1cABC96d5b7B129aE1aAAbdF50Dd40b'
  assert(isKnownInternalContract(upper), 'uppercase-hex address must still match')
  assert(isKnownInternalContract(mixed), 'mixed-case address must still match')
  assert(isKnownInternalContract(`  ${KIT_ADAPTER}  `), 'whitespace must be trimmed')
})

Deno.test('12. no duplicate address-list implementation — this module is the only place these entries live outside compare.ts', () => {
  // Not a runtime behavior test — a structural documentation check that the
  // list has the exact expected size (catches an accidental second/partial
  // list being pasted in alongside this one during a future edit).
  assert(KNOWN_INTERNAL_CONTRACTS.size === 9, `expected exactly 9 entries (8 mirrored from compare.ts + Multicall3), got ${KNOWN_INTERNAL_CONTRACTS.size}`)
})

Deno.test('null/undefined/empty address never throws, never matches', () => {
  assert(!isKnownInternalContract(null), 'null must not match')
  assert(!isKnownInternalContract(undefined), 'undefined must not match')
  assert(!isKnownInternalContract(''), 'empty string must not match')
})
