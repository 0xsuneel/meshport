/**
 * blockchain/events.ts — the typed event model for BlockchainIndexer
 *
 * Phase 3. Shared vocabulary between the indexer (which publishes) and the
 * Phase 4 consumer (which subscribes). Declared here in the frontend so that
 * when the edge function's TypeScript is compiled with the same types, both
 * sides cannot drift — the event_type CHECK constraint in the migration is
 * the server-side backstop to that same agreement.
 *
 * ── Design rule: the indexer has no business logic ─────────────────────────
 * These types describe WHAT happened on the chain, not what the app should do
 * about it. A 'deposit_detected' event does not say "refresh Home"; it says
 * "funds arrived at address X on chain Y". Deciding which cache keys to
 * invalidate is the Phase 4 consumer's job.
 *
 * TESTNET ONLY — same chain ids, tokens and semantics as the rest of the app.
 */

/** The fixed event vocabulary — must match the migration's CHECK constraint. */
export type ChainEventType =
  | 'deposit_detected'
  | 'transfer_detected'
  | 'transaction_confirmed'
  | 'transaction_failed'
  | 'balance_changed'
  | 'claim_completed'
  | 'bridge_completed'

/** Reorg lifecycle. 'pending' is a progress state; the rest are terminal. */
export type ChainEventStatus = 'pending' | 'confirmed' | 'reorged'

/**
 * One row of chain_events. The indexer inserts these; the Phase 4 consumer
 * subscribes to them. `assets` is denormalized so a consumer that only cares
 * about USDC can ignore EURC events without parsing metadata.
 */
export interface ChainEvent {
  id?:            number
  chain_id:       string
  block_number?:  number | null
  tx_hash?:       string | null
  event_type:     ChainEventType
  wallet_address: string | null
  assets:         string[]
  metadata:       Record<string, unknown>
  status:         ChainEventStatus
  created_at?:    string
  confirmed_at?:  string | null
  reorged_at?:    string | null
}

// ── Per-type payload shapes ─────────────────────────────────────────────────
// Kept as plain metadata keys rather than separate tables: consumers that
// need rich data can read the blockchain directly (a tx_hash is all they
// need to fetch a receipt). This table is a signal, not a data warehouse.

export interface DepositDetectedMeta {
  /** The address that received the funds. */
  recipient: string
  /** The address that sent them, when known ('' for a mint). */
  sender: string
  /** Human units. */
  amount: number
}

export interface TransferDetectedMeta {
  from: string
  to: string
  amount: number
}

export interface TransactionConfirmedMeta {
  /** 0x1 success, 0x0 revert. Consumers that care about failures check this. */
  status: '0x1' | '0x0'
}

export interface ClaimCompletedMeta {
  claimId: string
  amount: number
}

export interface BridgeCompletedMeta {
  sourceChain: string
  destinationChain: string
  amount: number
}

/** Convenience constructors — keep the indexer code free of object literals. */
export const makeDepositEvent = (
  chain: string, wallet: string, tx: string | null, block: number | null,
  recipient: string, sender: string, amount: number, asset = 'USDC',
): ChainEvent => ({
  chain_id: chain,
  block_number: block,
  tx_hash: tx,
  event_type: 'deposit_detected',
  wallet_address: wallet,
  assets: [asset],
  metadata: { recipient, sender, amount },
  status: 'pending',
})

export const makeTransferEvent = (
  chain: string, wallet: string, tx: string, block: number,
  from: string, to: string, amount: number, asset = 'USDC',
): ChainEvent => ({
  chain_id: chain,
  block_number: block,
  tx_hash: tx,
  event_type: 'transfer_detected',
  wallet_address: wallet,
  assets: [asset],
  metadata: { from, to, amount },
  status: 'pending',
})

export const makeConfirmedEvent = (
  chain: string, wallet: string, tx: string, block: number, status: '0x1' | '0x0',
): ChainEvent => ({
  chain_id: chain,
  block_number: block,
  tx_hash: tx,
  event_type: status === '0x1' ? 'transaction_confirmed' : 'transaction_failed',
  wallet_address: wallet,
  assets: [],
  metadata: { status },
  status: 'pending',
})

export const makeBalanceChangedEvent = (
  chain: string, wallet: string, asset: string, delta: number,
): ChainEvent => ({
  chain_id: chain,
  block_number: null,
  tx_hash: null,
  event_type: 'balance_changed',
  wallet_address: wallet,
  assets: [asset],
  metadata: { delta },
  status: 'pending',
})
