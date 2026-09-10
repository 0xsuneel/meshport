// Read-only proof: with a REAL (synthetic, since Phase 1 is unapplied)
// transaction_intent + transaction_attempt correlated to the real
// 0xb179c4f0... transaction, BOTH real chain_events (recipient A, live
// production row id 125; recipient B, reconciled) now correctly flow to
// CREDIT via classifyBulkPayCredit -- zero writes, in-memory only.
import { interpretConfirmedChainEvent } from '../server/ledger/interpreter'
import type { LedgerRepository } from '../server/ledger/repository'
import type { ChainEventInput, AttemptContext, IntentContext, InsertOutcome, LedgerEventDraft } from '../server/ledger/types'

const PAYER = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const RECIPIENT_A = '0xebe52519a38e857a744e65d01f23137e22fb784b' // real, registered, live chain_events id 125
const RECIPIENT_B = '0x9171d4f0d376019297d9598c33cdc6e92413f730' // real, unregistered
const TX = '0xb179c4f0691199d5a1fdfc49d5086cf587f5440b13c768629a2913f7f783714c'
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'

const intent: IntentContext = {
  id: 'intent-real-bulkpay', wallet_address: PAYER, feature: 'bulkpay',
  amount_atomic: '24000000000000000000', decimals: 18, token_address: null, token_symbol: 'USDC', is_native: true,
}
const attempt: AttemptContext = { id: 'attempt-real-bulkpay', intent_id: intent.id, chain_id: 'arc', tx_hash: TX, status: 'CONFIRMED', block_number: 58592562 }

const chainEventA: ChainEventInput = {
  id: 'ce-real-a', chain_id: 'arc', tx_hash: TX, wallet_address: RECIPIENT_A,
  event_type: 'deposit_detected', status: 'confirmed', log_index: 6, block_number: 58592562,
  token_address: null, token_symbol: 'USDC', decimals: 18,
  metadata: { recipient: RECIPIENT_A, sender: MULTICALL3, amount: 10, via: 'native-transfer-log' },
}
const chainEventB: ChainEventInput = {
  id: 'ce-real-b', chain_id: 'arc', tx_hash: TX, wallet_address: RECIPIENT_B,
  event_type: 'deposit_detected', status: 'confirmed', log_index: 7, block_number: 58592562,
  token_address: null, token_symbol: 'USDC', decimals: 18,
  metadata: { recipient: RECIPIENT_B, sender: MULTICALL3, amount: 14, via: 'native-transfer-log' },
}

const inserted: (LedgerEventDraft & { id: string })[] = []
const repo: LedgerRepository = {
  async getChainEvent(id) { return id === 'ce-real-a' ? chainEventA : id === 'ce-real-b' ? chainEventB : null },
  async findAttemptByTxHash(chainId, txHash) { return (chainId === 'arc' && txHash === TX) ? attempt : null },
  async getIntent(id) { return id === intent.id ? intent : null },
  async findLedgerEventByRawMovement() { return null },
  async insertLedgerEvent(draft): Promise<InsertOutcome> {
    const id = `ledger-${inserted.length + 1}`
    inserted.push({ ...draft, id })
    return { outcome: 'inserted', id }
  },
}

async function main() {
  const resultA = await interpretConfirmedChainEvent(repo, 'ce-real-a')
  const resultB = await interpretConfirmedChainEvent(repo, 'ce-real-b')
  console.log('recipient A (registered, real chain_events id 125):', JSON.stringify({ classification: resultA.classification, inserts: resultA.inserts }))
  console.log('recipient B (unregistered, reconciled):', JSON.stringify({ classification: resultB.classification, inserts: resultB.inserts }))
  console.log('\n=== all predicted ledger events ===')
  console.log(JSON.stringify(inserted, null, 2))
  console.log(`\nTotal rows: ${inserted.length} (expect 4: 2 DEBIT to payer + 2 CREDIT to recipients)`)
  console.log(`All DEBITs to real payer (not Multicall3): ${inserted.filter(r => r.event_type === 'DEBIT').every(r => r.wallet_address === PAYER)}`)
  console.log(`Zero rows attributed to Multicall3: ${!inserted.some(r => r.wallet_address === MULTICALL3)}`)
}
main()
