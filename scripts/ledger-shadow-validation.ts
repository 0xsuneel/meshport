// scripts/ledger-shadow-validation.ts
//
// READ-ONLY. Runs the real server/ledger interpreter/classifier code
// against real chain_events rows captured from production. Never writes
// anywhere — the "repository" here is a pure in-memory object seeded from
// real query results, exactly the same fake-repo pattern already proven in
// server/ledger/interpreter.test.ts, just seeded with real data instead of
// synthetic fixtures.
import { interpretConfirmedChainEvent } from '../server/ledger/interpreter'
import type { LedgerRepository } from '../server/ledger/repository'
import type { ChainEventInput, AttemptContext, IntentContext, LedgerEventDraft, InsertOutcome } from '../server/ledger/types'

function makeReadOnlyRepo(chainEvents: ChainEventInput[]) {
  const chainEventMap = new Map(chainEvents.map(e => [e.id, e]))
  const inserted: Array<LedgerEventDraft & { id: string }> = []
  const rawKey = (chainId: string, txHash: string, logIndex: number | null, wallet: string) =>
    `${chainId}:${txHash.toLowerCase()}:${logIndex ?? -1}:${wallet.toLowerCase()}`
  let n = 1
  const repo: LedgerRepository = {
    async getChainEvent(id) { return chainEventMap.get(id) ?? null },
    async findAttemptByTxHash(_chainId, _txHash) { return null }, // confirmed empty in production — see report
    async getIntent(_id) { return null },
    async findLedgerEventByRawMovement(chainId, txHash, logIndex, wallet) {
      const k = rawKey(chainId, txHash, logIndex, wallet)
      const row = inserted.find(r => rawKey(r.chain_id, r.tx_hash ?? '', r.log_index, r.wallet_address) === k)
      return row ? { id: row.id, event_type: row.event_type } : null
    },
    async insertLedgerEvent(draft): Promise<InsertOutcome> {
      // "Insert" only into this in-memory array — never touches any database.
      const k = rawKey(draft.chain_id, draft.tx_hash ?? '', draft.log_index, draft.wallet_address)
      const existing = inserted.find(r => rawKey(r.chain_id, r.tx_hash ?? '', r.log_index, r.wallet_address) === k)
      if (existing) {
        if (existing.event_type === draft.event_type) return { outcome: 'already_posted', id: existing.id }
        return { outcome: 'conflict', existingEventType: existing.event_type }
      }
      const id = `shadow-${n++}`
      inserted.push({ ...draft, id })
      return { outcome: 'inserted', id }
    },
  }
  return { repo, inserted }
}

// ── Real chain_events rows, captured verbatim from production (see
//    docs/LEDGER_REAL_TRANSACTION_SHADOW_VALIDATION.md for the exact
//    queries used to obtain these) ──────────────────────────────────────
const realChainEvents: ChainEventInput[] = [
  // 1. Native Pay A->B (5 USDC, sunil.arc -> suvarna.arc)
  {
    id: '109', chain_id: 'arc', tx_hash: '0x1da14d88ad1d4a7e674221a1ba1cdea1fbf84ab3067446b471021348f9e5435d',
    wallet_address: '0xebe52519a38e857a744e65d01f23137e22fb784b', event_type: 'deposit_detected',
    status: 'confirmed', log_index: null, block_number: 58470814,
    token_address: null, token_symbol: 'USDC', decimals: 18,
    metadata: { amount: 5, sender: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', recipient: '0xebe52519a38e857a744e65d01f23137e22fb784b' },
  },
  // 2. Native Pay A->B again (10 USDC, same pair, different tx)
  {
    id: '111', chain_id: 'arc', tx_hash: '0xafadc14ea253272fde469aa3f6460bf266d2088fab12ce3f015504a2b82d439b',
    wallet_address: '0xebe52519a38e857a744e65d01f23137e22fb784b', event_type: 'deposit_detected',
    status: 'confirmed', log_index: null, block_number: 58578534,
    token_address: null, token_symbol: 'USDC', decimals: 18,
    metadata: { amount: 10, sender: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', recipient: '0xebe52519a38e857a744e65d01f23137e22fb784b' },
  },
  // 3. ERC20 "Pay"-shaped (EURC, external sender, activity-consumer-credited), historical, no log_index
  {
    id: '103', chain_id: 'arc', tx_hash: '0xef6d341036fedf9f9b4e1eaf6d4cf3fd289bc7e50b35995199aa9bfb21c9c778',
    wallet_address: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', event_type: 'transfer_detected',
    status: 'confirmed', log_index: null, block_number: null,
    token_address: null, token_symbol: 'EURC', decimals: 6,
    metadata: { to: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', from: '0xd4c0b787aa2ff9eb751bb515c877ebbf2daddaae', amount: 20 },
  },
  // 4. Swap output leg (USDC -> EURC), the traced case from prior audits
  {
    id: '110', chain_id: 'arc', tx_hash: '0xed2868e6d034e65d2a0063816906dd2d69604102ce9a7a71a08fbf78c7492312',
    wallet_address: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', event_type: 'transfer_detected',
    status: 'confirmed', log_index: 59, block_number: 58471119,
    token_address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', token_symbol: 'EURC', decimals: 6,
    metadata: { to: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', from: '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b', amount: 0.881746 },
  },

  // ── NEW real transactions, freshly queried live (2026-08-24 session) ──

  // 5. GENUINE internal ERC20 Pay — EURC, sunil.arc -> rib.arc (real send_/recv_ pair confirmed)
  {
    id: '123', chain_id: 'arc', tx_hash: '0x8faba4f3866e8f7d4df12aa4ead8ad982e8dbb08f251438e7c55fe49bd8cdf09',
    wallet_address: '0x0634f842340bac0049b29db9955258252f2f406e', event_type: 'transfer_detected',
    status: 'confirmed', log_index: 25, block_number: 58590615,
    token_address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', token_symbol: 'EURC', decimals: 6,
    metadata: { to: '0x0634f842340bac0049b29db9955258252f2f406e', from: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', amount: 10 },
  },
  // 6. GENUINE internal native Pay — sunil.arc -> bordsa.arc (real send_/recv_ pair confirmed)
  {
    id: '119', chain_id: 'arc', tx_hash: '0x9f52959ac20c87c6fbbd0628de99a17beb55731a781163905083ce623e9b2392',
    wallet_address: '0xec883a938ed4b973d6df4bd947bf9a0f7f93b795', event_type: 'deposit_detected',
    status: 'confirmed', log_index: null, block_number: 58590542,
    token_address: null, token_symbol: 'USDC', decimals: 18,
    metadata: { amount: 1, sender: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', recipient: '0xec883a938ed4b973d6df4bd947bf9a0f7f93b795' },
  },
  // 7. GENUINE internal native Pay — sunil.arc -> rib.arc (real send_/recv_ pair confirmed)
  {
    id: '120', chain_id: 'arc', tx_hash: '0x4909f00d3b1e87536546699727636fbc8ed90fa75d328491db59cd769cd86ab0',
    wallet_address: '0x0634f842340bac0049b29db9955258252f2f406e', event_type: 'deposit_detected',
    status: 'confirmed', log_index: null, block_number: 58590582,
    token_address: null, token_symbol: 'USDC', decimals: 18,
    metadata: { amount: 1, sender: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', recipient: '0x0634f842340bac0049b29db9955258252f2f406e' },
  },
  // 8. Fresh EURC external deposit, now WITH real log_index/contract_address (post-fix data, not the historical-gap path)
  {
    id: '118', chain_id: 'arc', tx_hash: '0x134ef96e5a1b32c6ca2cbe61555dff4a9b88b5def44afa23c0eb531cb45538b5',
    wallet_address: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', event_type: 'transfer_detected',
    status: 'confirmed', log_index: 4, block_number: 58590375,
    token_address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', token_symbol: 'EURC', decimals: 6,
    metadata: { to: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', from: '0xd4c0b787aa2ff9eb751bb515c877ebbf2daddaae', amount: 20 },
  },
  // 9. Fresh cirBTC external deposit, real log_index/contract_address
  {
    id: '122', chain_id: 'arc', tx_hash: '0x48beda4d120f4a44b24015e4f9e59729d28acaf944c96ee2431c5795fed05765',
    wallet_address: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', event_type: 'transfer_detected',
    status: 'confirmed', log_index: 14, block_number: 58590394,
    token_address: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF', token_symbol: 'cirBTC', decimals: 8,
    metadata: { to: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', from: '0xd844ba11f64d23a7481e24474d2f184e350b9b3d', amount: 0.0001 },
  },
  // 10. Fresh native external deposit (native-transfer-log path), from the SAME 0xd4c0b787 "faucet-like" sender as #8, different tx
  {
    id: '121', chain_id: 'arc', tx_hash: '0x21b3dbf92ff1901d2edcf9149eee55d865a11f5b191491adf404b6ffc2a1dcb7',
    wallet_address: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', event_type: 'deposit_detected',
    status: 'confirmed', log_index: 6, block_number: 58590410,
    token_address: null, token_symbol: 'USDC', decimals: 18,
    metadata: { via: 'native-transfer-log', amount: 20, sender: '0xd4c0b787aa2ff9eb751bb515c877ebbf2daddaae', recipient: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0' },
  },
  // 11. Fresh swap output (USDC -> EURC, 8.4511), confirmed via real Activity swap row
  {
    id: '113', chain_id: 'arc', tx_hash: '0x91d9bd190fdc7c2e79c51333b3cd0197c9334b159bf6a34e90adb79f7ef2d6ac',
    wallet_address: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', event_type: 'transfer_detected',
    status: 'confirmed', log_index: 60, block_number: 58578464,
    token_address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', token_symbol: 'EURC', decimals: 6,
    metadata: { to: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', from: '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b', amount: 8.4511 },
  },
  // 12. REAL BulkPay — Multicall3 sender confirmed (0xca11bde0...), via native-transfer-log.
  //     IMPORTANT: Activity shows 2 recipients (10 + 14 = 24 USDC) for this tx_hash, but
  //     chain_events only has ONE row for it (this one) — see report §8/§13 for the discovered gap.
  {
    id: '125', chain_id: 'arc', tx_hash: '0xb179c4f0691199d5a1fdfc49d5086cf587f5440b13c768629a2913f7f783714c',
    wallet_address: '0xebe52519a38e857a744e65d01f23137e22fb784b', event_type: 'deposit_detected',
    status: 'confirmed', log_index: 6, block_number: 58592562,
    token_address: null, token_symbol: 'USDC', decimals: 18,
    metadata: { via: 'native-transfer-log', amount: 10, sender: '0xca11bde05977b3631167028862be2a173976ca11', recipient: '0xebe52519a38e857a744e65d01f23137e22fb784b' },
  },
]

async function main() {
  const { repo, inserted } = makeReadOnlyRepo(realChainEvents)
  for (const e of realChainEvents) {
    const result = await interpretConfirmedChainEvent(repo, e.id)
    console.log(JSON.stringify({ chainEventId: e.id, tx_hash: e.tx_hash, classification: result.classification, reason: result.reason, inserts: result.inserts }, null, 2))
  }
  console.log('\n=== FINAL IN-MEMORY LEDGER STATE (never written to any database) ===')
  console.log(JSON.stringify(inserted, null, 2))

  console.log('\n=== IDEMPOTENCY RE-RUN (same chain_events, second pass) ===')
  for (const e of realChainEvents) {
    const result = await interpretConfirmedChainEvent(repo, e.id)
    console.log(JSON.stringify({ chainEventId: e.id, inserts: result.inserts }))
  }
  console.log('row count after second pass (must be unchanged):', inserted.length)

  console.log('\n=== CONFLICT SIMULATION: same raw movement, first SWAP_CREDIT then plain CREDIT ===')
  const conflictKey = { chain_id: 'arc', tx_hash: '0xconflicttest', log_index: 1, wallet_address: '0xwallet' }
  const draftA: LedgerEventDraft = { ...conflictKey, transaction_intent_id: null, transaction_attempt_id: null, event_type: 'SWAP_CREDIT', direction: 'credit', token_address: null, token_symbol: 'EURC', decimals: 6, amount_atomic: '1000000', is_native: false, block_number: 1, event_key: 'k1', metadata: {} }
  const draftB: LedgerEventDraft = { ...draftA, event_type: 'CREDIT', event_key: 'k2' }
  const r1 = await repo.insertLedgerEvent(draftA)
  const r2 = await repo.insertLedgerEvent(draftB)
  console.log('first insert (SWAP_CREDIT):', JSON.stringify(r1))
  console.log('second insert (CREDIT, same raw movement):', JSON.stringify(r2))
}

main()
