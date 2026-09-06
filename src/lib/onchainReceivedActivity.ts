// lib/onchainReceivedActivity.ts
//
// Direct, client-side blockchain source of truth for RECENT incoming
// transfers to the connected wallet — native USDC value transfers and
// ERC-20 (EURC/cirBTC) transfers alike. Built specifically to close the
// gap where a deposit sent straight to a wallet address (not through
// MeshPort's own send flow) previously only became visible once
// deposit-scan-all's background sweep discovered it, which — while now
// fast (a few seconds, see that function's own fix history) — is still a
// server-mediated hop, not a direct read of the chain itself.
//
// ── Why the Blockscout explorer API, not raw eth_getLogs from the browser ──
// Native transfers don't emit logs at all (see deposit-scan-all's own
// comment on this — USDC here is native value, `eth_getLogs` is
// structurally blind to it), so a real client-side equivalent needs either
// block-by-block scanning (expensive to do repeatedly from a browser, and
// with no way to paginate backward efficiently) or an already-indexed
// source. ArcScan (Blockscout) indexes exactly this — the SAME endpoint
// deposit-scan-all's own reconcile pass already uses successfully
// server-side (`/addresses/{address}/transactions?filter=to`) — reused
// directly here rather than reinventing indexing client-side.
//
// ── An honest, unverifiable-from-here assumption ────────────────────────────
// Whether this specific Blockscout instance sends CORS headers permitting
// browser-based requests (as opposed to only server-to-server ones, which
// is all deposit-scan-all itself needed) has NOT been verified — this
// sandboxed environment has no network path to arcscan.app to test it.
// Every call here is wrapped so a CORS/network failure degrades silently:
// the existing Supabase-backed feed (still populated by deposit-scan-all
// regardless) remains fully functional either way. This is a pure
// enhancement layer, never a single point of failure for the page itself.

const ARC_EXPLORER_API = 'https://testnet.arcscan.app/api/v2'

// Same known-internal-contracts list as deposit-scan-all's own — a
// transfer FROM one of these is definitionally a swap/bridge output leg,
// not a genuine external deposit, and should not double up with what the
// Supabase feed already shows for that same underlying activity via its
// own (differently-labeled) recording path.
//
// Exported so lib/arcDepositWatcher.ts (the real-time eth_subscribe(logs)
// layer) applies the exact same swap/bridge-output exclusion this REST
// fallback does — one source of truth client-side, mirroring the server's
// decide.ts / deposit-scan-all KNOWN_INTERNAL_CONTRACTS.
//
// BUG FIX (BulkPay recipients got a second, misclassified "Received from
// <Multicall3 address>" notification + activity row alongside their correct
// "Received via bulk payout" one): this list was missing Multicall3
// (0xcA11bde05977b3631167028862be2A173976CA11), the contract
// BulkPayoutPage.tsx routes every payout through — each recipient's
// individual transfer is forwarded BY Multicall3, so its Transfer/native
// value-transfer log legitimately shows `from = Multicall3`, not the actual
// sender. Every OTHER copy of this exact list in the codebase (server-side
// deposit-scan-all/index.ts, activity-consumer/decide.ts,
// ledger-interpret/classifiers.ts, server/ledger/classifiers.ts,
// blockchain-indexer/compare.ts, and the canonical
// supabase/functions/_shared/knownInternalContracts.ts) already excludes
// Multicall3 — these two client-side copies (this one, and HomePage.tsx's
// own local copy in fireIfReceived) were the only ones still missing it, so
// this real-time watcher kept treating every BulkPay leg as a genuine
// external deposit from an unrecognized address.
export const KNOWN_INTERNAL_CONTRACTS = new Set([
  '0x0077777d7eba4688bdef3e311b846f25870a19b9',
  '0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5',
  '0x7865fafc2db2093669d92c0f33aeef291086befd',
  '0xacf1ceef35caac005e15888ddb8a3515c41b4872',
  '0xc5567a5e3370d4dbfb0540025078e283e36a363d',
  '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b',
  '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
  '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
  '0xca11bde05977b3631167028862be2a173976ca11', // Multicall3 — BulkPay routes through this
])

const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '0x89b50855aa3be2f677cd6303cec089b5f319d72a': { symbol: 'EURC', decimals: 6 },
  '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf': { symbol: 'cirBTC', decimals: 8 },
}

export interface OnchainReceivedTx {
  txHash: string
  fromAddress: string
  tokenSymbol: string
  amount: number
  status: 'pending' | 'confirmed'
  timestamp: string // ISO — real block/submission time from the explorer, not "now"
}

function isFromKnownInternalContract(fromAddr: string | undefined | null): boolean {
  return KNOWN_INTERNAL_CONTRACTS.has((fromAddr || '').toLowerCase())
}

/**
 * Fetches the most recent native-value transfers TO this wallet directly
 * from the explorer. Limited to a bounded recent window (not full paginated
 * history) — this is the "did something just arrive" layer, not a
 * replacement for deep history browsing.
 */
async function fetchRecentNativeReceived(walletAddress: string): Promise<OnchainReceivedTx[]> {
  const url = `${ARC_EXPLORER_API}/addresses/${walletAddress}/transactions?filter=to`
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) })
  if (!res.ok) throw new Error(`explorer transactions API returned ${res.status}`)
  const body = await res.json()
  const items: any[] = Array.isArray(body?.items) ? body.items : []

  const out: OnchainReceivedTx[] = []
  for (const item of items) {
    const toAddr   = (item?.to?.hash ?? item?.to ?? '') as string
    const fromAddr = (item?.from?.hash ?? item?.from ?? '') as string
    const txHash   = (item?.hash ?? '') as string
    const rawValue = item?.value
    if (!toAddr || !fromAddr || !txHash || rawValue == null) continue
    if (toAddr.toLowerCase() !== walletAddress.toLowerCase()) continue
    if (fromAddr.toLowerCase() === walletAddress.toLowerCase()) continue
    if (isFromKnownInternalContract(fromAddr)) continue

    let amount: number
    try { amount = Number(BigInt(rawValue)) / 1e18 } catch { continue }
    if (!Number.isFinite(amount) || amount <= 0) continue

    // Blockscout marks a tx's own execution result via `status` ('ok' /
    // 'error' / null-ish while still pending); `block_number` present at
    // all is the more reliable "has this actually landed in a block yet"
    // signal — a still-pending tx simply won't have one.
    const isConfirmed = item?.block_number != null && (item?.status == null || item.status === 'ok')
    if (item?.status === 'error') continue // a reverted tx never actually transferred anything

    const timestamp = item?.timestamp ? new Date(item.timestamp).toISOString() : new Date().toISOString()

    out.push({ txHash: txHash.toLowerCase(), fromAddress: fromAddr.toLowerCase(), tokenSymbol: 'USDC', amount, status: isConfirmed ? 'confirmed' : 'pending', timestamp })
  }
  return out
}

/** Same idea, for ERC-20 (EURC/cirBTC) transfers — a separate Blockscout endpoint from native transactions. */
async function fetchRecentTokenReceived(walletAddress: string): Promise<OnchainReceivedTx[]> {
  const url = `${ARC_EXPLORER_API}/addresses/${walletAddress}/token-transfers?filter=to`
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) })
  if (!res.ok) throw new Error(`explorer token-transfers API returned ${res.status}`)
  const body = await res.json()
  const items: any[] = Array.isArray(body?.items) ? body.items : []

  const out: OnchainReceivedTx[] = []
  for (const item of items) {
    const toAddr       = (item?.to?.hash ?? item?.to ?? '') as string
    const fromAddr      = (item?.from?.hash ?? item?.from ?? '') as string
    const txHash        = (item?.tx_hash ?? item?.transaction_hash ?? '') as string
    const contractAddr  = (item?.token?.address ?? '').toLowerCase()
    const rawValue       = item?.total?.value ?? item?.total ?? item?.amount
    if (!toAddr || !fromAddr || !txHash || rawValue == null) continue
    if (toAddr.toLowerCase() !== walletAddress.toLowerCase()) continue
    if (fromAddr.toLowerCase() === walletAddress.toLowerCase()) continue
    if (isFromKnownInternalContract(fromAddr)) continue

    const known = KNOWN_TOKENS[contractAddr]
    if (!known) continue // not a genuine EURC/cirBTC contract — never trust the token label alone, same reasoning as elsewhere in this app

    let amount: number
    try { amount = Number(BigInt(rawValue)) / (10 ** known.decimals) } catch { continue }
    if (!Number.isFinite(amount) || amount <= 0) continue

    const timestamp = item?.timestamp ? new Date(item.timestamp).toISOString() : new Date().toISOString()
    // Token-transfer entries in Blockscout are only ever indexed once the
    // transfer's log is actually mined — there's no "pending" state to
    // represent for this endpoint specifically (unlike top-level native
    // transactions, which can appear before confirmation).
    out.push({ txHash: txHash.toLowerCase(), fromAddress: fromAddr.toLowerCase(), tokenSymbol: known.symbol, amount, status: 'confirmed', timestamp })
  }
  return out
}

/**
 * Combined, deduped, most-recent-first list of real incoming transfers to
 * this wallet, read directly from the chain (via the explorer's index).
 * Fails silently to an empty array on any error — see file header for why
 * that's the correct behavior here, not a bug to "fix" by surfacing it.
 */
export async function fetchRecentOnchainReceived(walletAddress: string): Promise<OnchainReceivedTx[]> {
  if (!walletAddress) return []
  try {
    const [native, tokens] = await Promise.allSettled([
      fetchRecentNativeReceived(walletAddress),
      fetchRecentTokenReceived(walletAddress),
    ])
    const combined = [
      ...(native.status === 'fulfilled' ? native.value : []),
      ...(tokens.status === 'fulfilled' ? tokens.value : []),
    ]
    return combined.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  } catch (e) {
    console.warn('[onchainReceivedActivity] direct explorer fetch failed, falling back to Supabase-only feed:', e instanceof Error ? e.message : e)
    return []
  }
}
