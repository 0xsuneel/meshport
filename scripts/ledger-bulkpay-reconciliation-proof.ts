// Read-only proof: the exact ReconciledChainEvent shape bulkpayReconcile.ts
// would produce for recipient B flows correctly through the UNMODIFIED
// server/ledger Interpreter — zero Ledger code touched, zero writes.
import { interpretConfirmedChainEvent } from '../server/ledger/interpreter'
import type { LedgerRepository } from '../server/ledger/repository'
import type { ChainEventInput, InsertOutcome, LedgerEventDraft } from '../server/ledger/types'

// Exactly what decodeBulkPayReceipt() would emit for recipient B (0x9171d4f0...)
const reconciledEventForRecipientB: ChainEventInput = {
  id: 'reconciled-1',
  chain_id: 'arc',
  tx_hash: '0xb179c4f0691199d5a1fdfc49d5086cf587f5440b13c768629a2913f7f783714c',
  wallet_address: '0x9171d4f0d376019297d9598c33cdc6e92413f730', // NOT in users table — proven in the forensic audit
  event_type: 'deposit_detected',
  status: 'confirmed',
  log_index: 7,
  block_number: 58592562,
  token_address: null,
  token_symbol: 'USDC',
  decimals: 18,
  metadata: { recipient: '0x9171d4f0d376019297d9598c33cdc6e92413f730', sender: '0xca11bde05977b3631167028862be2a173976ca11', amount: 14, via: 'native-transfer-log', reconciled: true, reconciledFrom: 'bulkpay' },
}

const inserted: (LedgerEventDraft & { id: string })[] = []
const repo: LedgerRepository = {
  async getChainEvent(id) { return id === 'reconciled-1' ? reconciledEventForRecipientB : null },
  async findAttemptByTxHash() { return null },
  async getIntent() { return null },
  async findLedgerEventByRawMovement() { return null },
  async insertLedgerEvent(draft): Promise<InsertOutcome> {
    inserted.push({ ...draft, id: `ledger-${inserted.length + 1}` })
    return { outcome: 'inserted', id: `ledger-${inserted.length}` }
  },
}

// Second check: does the "no users-table dependency" principle hold when
// the sender is NOT a known-internal address? Isolates the variable —
// proves registration status truly never enters the classifier's decision,
// separate from the Multicall3-specific deferral found above.
const ordinarySenderEvent: ChainEventInput = {
  ...reconciledEventForRecipientB,
  id: 'reconciled-2',
  metadata: { ...reconciledEventForRecipientB.metadata, sender: '0xSomeOrdinaryUnrelatedSender' },
}
const repo2: LedgerRepository = {
  ...repo,
  async getChainEvent(id) { return id === 'reconciled-2' ? ordinarySenderEvent : null },
}

async function main() {
  const result = await interpretConfirmedChainEvent(repo, 'reconciled-1')
  console.log('=== Multicall3-sourced reconciled event (recipient B, real sender) ===')
  console.log(JSON.stringify({ classification: result.classification, reason: result.reason, inserts: result.inserts }, null, 2))

  const result2 = await interpretConfirmedChainEvent(repo2, 'reconciled-2')
  console.log('\n=== SAME event, hypothetical non-Multicall3 sender (isolating the registration-status variable) ===')
  console.log(JSON.stringify({ classification: result2.classification, inserts: result2.inserts }, null, 2))

  console.log('\n=== predicted ledger events (never written) ===')
  console.log(JSON.stringify(inserted, null, 2))
}
main()
