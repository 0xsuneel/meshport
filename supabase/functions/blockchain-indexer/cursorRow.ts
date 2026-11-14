// supabase/functions/blockchain-indexer/cursorRow.ts
// One chain_cursors row (re-exported by cursors.ts).
export interface CursorRow {
  chain_id:             string
  last_indexed_block:   number
  last_indexed_hash:    string | null
  latest_observed_block: number | null
  confirmation_depth:   number
  sync_state:           string
  consecutive_failures: number
  reorg_count:          number
  last_reorg_at:        string | null
  last_success_at:      string | null
  last_error:           string | null
}
