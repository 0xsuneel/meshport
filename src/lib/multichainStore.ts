/**
 * multichainStore.ts — IndexedDB-backed cross-device multichain tx registry.
 *
 * REPLACES the Supabase `multichain_transactions` table.
 *
 * Why IndexedDB instead of Supabase here:
 *  • Multichain tx hashes are already on-chain — they don't need a server DB.
 *    The only reason they were in Supabase was cross-device sync, but the
 *    functions were never actually called outside supabase.ts.
 *  • IDB survives pause/resume and is synchronous-fast for Set lookups used
 *    by ActivityService's classification pass.
 *  • Removes one class of write from the Supabase Realtime quota.
 *  • If cross-device sync is needed in the future, a single /api/sync endpoint
 *    can push/pull the IDB store in one batch call; no Supabase tables needed.
 *
 * Schema (IDB db: 'meshport_multichain', version 1):
 *   store 'txs'  — keyPath: 'txHash'
 *     txHash:      string  (lowercase)
 *     walletAddress: string (lowercase)
 *     type:        'claim' | 'deposit' | 'bridge' | 'swap'
 *     amount:      number | null
 *     sourceChain: string | null   (or tokenIn for swaps)
 *     destChain:   string | null   (or tokenOut for swaps)
 *     note:        string | null   (JSON for swap amountOut/status)
 *     createdAt:   number          (Date.now())
 *
 *   index 'by_wallet' on walletAddress — allows per-wallet range queries
 *   index 'by_wallet_type' on [walletAddress, type] — swap filter
 *
 * All functions are silent-fail: IDB errors are logged but never thrown to
 * the caller (the classification pass must never break activity rendering).
 */

const DB_NAME    = 'meshport_multichain'
const DB_VERSION = 1
const STORE      = 'txs'

// ─── DB open (cached per tab) ─────────────────────────────────────────────────

let _db: IDBDatabase | null = null
let _dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db)
  if (_dbPromise) return _dbPromise
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'txHash' })
        store.createIndex('by_wallet',      'walletAddress',           { unique: false })
        store.createIndex('by_wallet_type', ['walletAddress', 'type'], { unique: false })
      }
    }
    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result
      _db.onclose = () => { _db = null; _dbPromise = null }
      resolve(_db)
    }
    req.onerror = () => reject(req.error)
  })
  return _dbPromise
}

function idbGet(db: IDBDatabase, key: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

function idbPut(db: IDBDatabase, record: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).put(record)
    tx.oncomplete = () => resolve()
    req.onerror   = () => reject(req.error)
  })
}

function idbGetAllByIndex(db: IDBDatabase, indexName: string, query: IDBValidKey | IDBKeyRange): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE, 'readonly')
    const index = tx.objectStore(STORE).index(indexName)
    const req   = index.getAll(query)
    req.onsuccess = () => resolve(req.result ?? [])
    req.onerror   = () => reject(req.error)
  })
}

// ─── Public API (same signatures as the removed Supabase helpers) ─────────────

export interface MultichainTxRecord {
  txHash:      string
  type:        'claim' | 'deposit' | 'bridge' | 'swap'
  amount:      number | null
  sourceChain: string | null
  destChain:   string | null
  createdAt:   string
}

export interface SwapTxRecord {
  txHash:    string
  tokenIn:   string
  tokenOut:  string
  amountIn:  string
  amountOut: string
  status:    'success' | 'failed'
  timestamp: number
}

/** Persist a bridge/claim/deposit tx hash locally. */
export async function saveMultichainTx(params: {
  txHash:        string
  walletAddress: string
  type:          'claim' | 'deposit' | 'bridge'
  amount?:       number
  sourceChain?:  string
  destChain?:    string
}): Promise<void> {
  try {
    const db = await openDb()
    // Merge with existing record so a re-save doesn't lose data.
    const existing = await idbGet(db, params.txHash.toLowerCase())
    await idbPut(db, {
      ...(existing ?? {}),
      txHash:        params.txHash.toLowerCase(),
      walletAddress: params.walletAddress.toLowerCase(),
      type:          params.type,
      amount:        params.amount ?? existing?.amount ?? null,
      sourceChain:   params.sourceChain ?? existing?.sourceChain ?? null,
      destChain:     params.destChain   ?? existing?.destChain   ?? null,
      note:          existing?.note ?? null,
      createdAt:     existing?.createdAt ?? Date.now(),
    })
  } catch (err) {
    console.error('[multichainStore] saveMultichainTx error:', err)
  }
}

/** Return a Set of all known multichain tx hashes for fast ActivityService lookup. */
export async function fetchMultichainTxHashes(walletAddress: string): Promise<Set<string>> {
  try {
    const db   = await openDb()
    const rows = await idbGetAllByIndex(db, 'by_wallet', walletAddress.toLowerCase())
    return new Set(rows.map((r: any) => r.txHash as string))
  } catch (err) {
    console.error('[multichainStore] fetchMultichainTxHashes error:', err)
    return new Set()
  }
}

/** Return full multichain tx records for history display. */
export async function fetchMultichainTxRecords(walletAddress: string): Promise<MultichainTxRecord[]> {
  try {
    const db   = await openDb()
    const rows = await idbGetAllByIndex(db, 'by_wallet', walletAddress.toLowerCase())
    return rows
      .filter((r: any) => r.type !== 'swap')
      .sort((a: any, b: any) => b.createdAt - a.createdAt)
      .slice(0, 200)
      .map((r: any) => ({
        txHash:      r.txHash,
        type:        r.type,
        amount:      r.amount ?? null,
        sourceChain: r.sourceChain ?? null,
        destChain:   r.destChain   ?? null,
        createdAt:   new Date(r.createdAt).toISOString(),
      }))
  } catch (err) {
    console.error('[multichainStore] fetchMultichainTxRecords error:', err)
    return []
  }
}

/** Persist a swap tx locally. */
export async function saveSwapTx(params: {
  txHash:        string
  walletAddress: string
  tokenIn:       string
  tokenOut:      string
  amountIn:      string
  amountOut:     string
  status:        'success' | 'failed'
}): Promise<void> {
  try {
    const db = await openDb()
    await idbPut(db, {
      txHash:        params.txHash.toLowerCase(),
      walletAddress: params.walletAddress.toLowerCase(),
      type:          'swap',
      amount:        parseFloat(params.amountIn) || null,
      sourceChain:   params.tokenIn,   // reuse field for tokenIn (matches Supabase convention)
      destChain:     params.tokenOut,  // reuse field for tokenOut
      note:          JSON.stringify({ amountOut: params.amountOut, status: params.status }),
      createdAt:     Date.now(),
    })
  } catch (err) {
    console.error('[multichainStore] saveSwapTx error:', err)
  }
}

/** Return swap history for display. */
export async function fetchSwapRecords(walletAddress: string): Promise<SwapTxRecord[]> {
  try {
    const db   = await openDb()
    const rows = await idbGetAllByIndex(
      db,
      'by_wallet_type',
      IDBKeyRange.only([walletAddress.toLowerCase(), 'swap']),
    )
    return rows
      .sort((a: any, b: any) => b.createdAt - a.createdAt)
      .slice(0, 100)
      .map((r: any) => {
        let amountOut = '0'
        let status: 'success' | 'failed' = 'success'
        try { const n = JSON.parse(r.note || '{}'); amountOut = n.amountOut || '0'; status = n.status || 'success' } catch {}
        return {
          txHash:    r.txHash,
          tokenIn:   r.sourceChain ?? '',
          tokenOut:  r.destChain   ?? '',
          amountIn:  String(r.amount ?? '0'),
          amountOut,
          status,
          timestamp: r.createdAt,
        }
      })
  } catch (err) {
    console.error('[multichainStore] fetchSwapRecords error:', err)
    return []
  }
}
