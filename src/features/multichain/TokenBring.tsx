// ── Bring EURC / cirBTC to Arc: the Hub's chain list ────────────────────────
// The Hub's Bring tab, personal accounts only, with EURC or cirBTC picked:
// the chains Circle's registry has the token on (and on Arc) where
// MeshPortRouter is deployed, with the wallet's balance of it on each - the
// same rows as USDC's. Tapping one opens the regular Bring screens
// (MultichainClaimPage with `token`): the user signs once, MeshPort's relayer
// pays the gas and Circle's CCTPx fee, MeshPort's fee comes out of the token,
// and Circle's forwarder delivers on Arc (lib/gaslessToken).
//
// Also the balance helpers that Bring uses for these tokens.

import { useEffect, useState } from 'react'
import { useAuthStore } from '@/store'
import { EXTERNAL_CHAINS } from '@/blockchain/chains'
import { formatAmount, trimTrailingZeros } from '@/lib/utils'
import { bridgeTokenDecimals, useTokenRouteChains, type CctpxToken } from '@/lib/tokenBridge'
import { hasTokenRouter } from '@/lib/gaslessToken'
import { useTokenSnapshot } from '@/lib/tokenSnapshot'

/** A CCTPx chain (kit id) → MeshPort's chain id and name. */
const CHAIN_INFO: Record<string, { id: string; label: string }> = {
  Ethereum_Sepolia:     { id: 'Ethereum_Sepolia', label: 'Ethereum' },
  Base_Sepolia:         { id: 'Base_Sepolia',     label: 'Base' },
  Arbitrum_Sepolia:     { id: 'Arbitrum_Sepolia', label: 'Arbitrum' },
  Optimism_Sepolia:     { id: 'Optimism_Sepolia', label: 'OP Sepolia' },
  Avalanche_Fuji:       { id: 'Avalanche_Fuji',   label: 'Avalanche' },
  Polygon_Amoy_Testnet: { id: 'Polygon_Sepolia',  label: 'Polygon' },
  World_Chain_Sepolia:  { id: 'World_Chain_Sepolia', label: 'World Chain' },
}
const chainInfo = (sdk: string) => CHAIN_INFO[sdk] ?? { id: sdk, label: sdk.replace(/_/g, ' ') }
/** A MeshPort chain id's name (the scan's snapshot is keyed by these). */
const labelOf = (id: string) => Object.values(CHAIN_INFO).find(c => c.id === id)?.label
  ?? id.replace(/_(Sepolia|Testnet|Fuji|Apothem)$/, '').replace(/_/g, ' ')
/** Snapshot rows in the usual chain order, then any others. */
const ORDER = Object.values(CHAIN_INFO).map(c => c.id)
const byOrder = (a: string, b: string) => ((ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b)

/** A chain picked in the list: MeshPort's chain id, its token balance and the token's contract there. */
export type TokenBringChain = { chainId: string; label: string; balance: number; tokenAddress: string }

const fmtToken = (token: CctpxToken, n: number) => token === 'cirBTC' ? trimTrailingZeros(n.toFixed(8)) || '0' : formatAmount(n)

// Each RPC in turn; the first that answers.
async function withRpc<T>(rpcs: string[], fn: (p: any) => Promise<T>): Promise<T> {
  const { JsonRpcProvider } = await import('ethers')
  let last: unknown
  for (const url of rpcs) {
    const p = new JsonRpcProvider(url, undefined, { staticNetwork: true })
    try { return await fn(p) } catch (e) { last = e } finally { p.destroy() }
  }
  throw last ?? new Error('No RPC')
}

/** `owner`'s balance of the token at `tokenAddress` on MeshPort chain `chainId`. Throws when no RPC answers. */
export async function readTokenBalance(chainId: string, tokenAddress: string, owner: string, decimals: number): Promise<number> {
  const { Contract, formatUnits } = await import('ethers')
  return withRpc(EXTERNAL_CHAINS[chainId]?.rpcs ?? [], async p => {
    const raw: bigint = await new Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], p).balanceOf(owner)
    return Number(formatUnits(raw, decimals))
  })
}

/** The token's balance in the wallet on Arc. */
export async function readArcToken(token: CctpxToken, owner: string): Promise<number> {
  const m = await import('@/lib/arcService')
  return token === 'EURC' ? m.readEURCBalanceOrThrow(owner) : m.readCirBtcBalanceOrThrow(owner)
}

/** Waits (up to 20 min) until `amount` more of the token is on Arc than `before`. */
export async function waitForArc(token: CctpxToken, owner: string, before: number | null, amount: number, keepGoing: () => boolean): Promise<boolean> {
  if (before === null) return false
  const until = Date.now() + 20 * 60_000
  while (Date.now() < until && keepGoing()) {
    await new Promise(r => setTimeout(r, 5_000))
    const now = await readArcToken(token, owner).catch(() => null)
    if (now !== null && now >= before + amount * 0.999) return true
  }
  return false
}

// ── The chain list ──────────────────────────────────────────────────────────
export function TokenBringList({ token, onPick }: { token: CctpxToken; onPick: (c: TokenBringChain) => void }) {
  const walletAddress = useAuthStore(s => s.walletAddress)
  // The Hub's USDC scan already brought EURC / cirBTC on every chain (one
  // /api/portfolio call - lib/tokenSnapshot): show those at once.
  const snapshot = useTokenSnapshot(walletAddress)?.tokens?.[token] ?? null
  if (snapshot) return <SnapshotRows token={token} rows={snapshot} onPick={onPick} />
  return <LookupRows token={token} walletAddress={walletAddress} onPick={onPick} />
}

function TokenRow({ token, label, balance, onPick }: { token: CctpxToken; label: string; balance: number | null | undefined; onPick?: () => void }) {
  const has = (balance ?? 0) > 0
  return (
    <button disabled={!has} onClick={onPick}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 16, textAlign: 'left',
        cursor: has ? 'pointer' : 'default', opacity: has ? 1 : 0.55,
        background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
        border: has ? '1px solid color-mix(in srgb, var(--brand) 35%, transparent)' : '1px solid var(--border)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'min(15px, 4.1vw)', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.25, overflowWrap: 'normal' }}>{label}</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
            color: 'var(--success-text)', background: 'color-mix(in srgb, var(--success) 14%, transparent)' }}>CCTPx</span>
        </div>
      </div>
      {/* Same as a USDC row: the number never breaks; the coin drops under it when needed. */}
      <span style={{ fontSize: 'min(16px, 4.2vw)', fontWeight: 800, color: has ? 'var(--text-primary)' : 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', flexShrink: 1, minWidth: 0, maxWidth: '58%', textAlign: 'right' }}>
        <span style={{ whiteSpace: 'nowrap' }}>{balance === undefined ? '…' : balance === null ? '-' : has ? fmtToken(token, balance) : '0'}</span> <span style={{ whiteSpace: 'nowrap' }}>{token}</span>
      </span>
    </button>
  )
}

const listNote = (text: string) => <div style={{ padding: 18, textAlign: 'center', fontSize: 13, color: 'var(--text-secondary)' }}>{text}</div>

/** From the scan's snapshot: chains, balances and addresses already known. */
function SnapshotRows({ token, rows, onPick }: { token: CctpxToken; rows: Record<string, { balance: number | null; address: string }>; onPick: (c: TokenBringChain) => void }) {
  const ids = Object.keys(rows).filter(hasTokenRouter).sort(byOrder)
  if (!ids.length) return listNote(`${token} can't be brought to Arc from any chain right now.`)
  return (
    <>
      {ids.map(id => (
        <TokenRow key={id} token={token} label={labelOf(id)} balance={rows[id].balance}
          onPick={() => onPick({ chainId: id, label: labelOf(id), balance: rows[id].balance ?? 0, tokenAddress: rows[id].address })} />
      ))}
    </>
  )
}

/** No scan yet (or an older server): Circle's registry, then each chain read here. */
function LookupRows({ token, walletAddress, onPick }: { token: CctpxToken; walletAddress: string | null; onPick: (c: TokenBringChain) => void }) {
  const routes = useTokenRouteChains(token)
  const [balances, setBalances] = useState<Record<string, number | null>>({})
  const decimals = bridgeTokenDecimals(token)
  // Circle has the route and MeshPortRouter is on the chain (gasless).
  const chains = routes.chains?.filter(sdk => hasTokenRouter(chainInfo(sdk).id)) ?? null

  useEffect(() => {
    setBalances({})
    if (!walletAddress || !routes.chains || !routes.deployments) return
    let cancelled = false
    for (const sdk of routes.chains) {
      const addr = routes.deployments.get(sdk)
      if (!addr || !hasTokenRouter(chainInfo(sdk).id)) continue
      readTokenBalance(chainInfo(sdk).id, addr, walletAddress, decimals)
        .then(b => { if (!cancelled) setBalances(prev => ({ ...prev, [sdk]: b })) })
        .catch(() => { if (!cancelled) setBalances(prev => ({ ...prev, [sdk]: null })) })
    }
    return () => { cancelled = true }
  }, [walletAddress, routes.chains, routes.deployments, decimals])

  if (routes.loading) return listNote(`Finding chains that carry ${token}…`)
  if (routes.error) return listNote(`Couldn't load ${token} routes from Circle. Try again in a moment.`)
  if (!chains?.length) return listNote(`${token} can't be brought to Arc from any chain right now.`)

  return (
    <>
      {chains.map(sdk => {
        const info = chainInfo(sdk)
        const bal = balances[sdk]
        return (
          <TokenRow key={sdk} token={token} label={info.label} balance={bal}
            onPick={() => onPick({ chainId: info.id, label: info.label, balance: bal ?? 0, tokenAddress: routes.deployments!.get(sdk)! })} />
        )
      })}
    </>
  )
}
