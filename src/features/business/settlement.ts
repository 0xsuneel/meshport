// Business → settlement: moves the store's USDC from other chains to its Arc
// balance. Built only on the CCTP service and the claim service:
//
//   readExternalBalances   what is sitting on each CCTP chain
//   merchantClaimAll       Settle all: burns on each chain over CCTP
//                          (MeshPort's relayer pays the gas), one claim per chain
//   bringFundsGasless      Settle one chain, any time (like Bring Funds)
//   claimService           live claim rows: each chain's stage until the
//                          USDC is minted on Arc, plus the settlement history
//
// The Business tab owns the rules here: a minimum per chain, an optional
// wait between settlements (Admin → Features), the passcode check and
// unlocking the wallet key on this device (the key never leaves it).
import { getReadySigner } from '@/lib/paymentReadiness'
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { useAuthStore } from '@/store'
import type { WalletAccount } from '@/wallet'
import { useSettingsStore } from '@/store/settingsStore'
import { readExternalBalances, readExternalChainBalance, notifyExternalBalanceChanged, EXTERNAL_BALANCE_EVENT } from '@/blockchain/BlockchainManager'
import { canBringOverCctp } from '@/lib/gaslessBridge'
import { isChainEnabledForSettle } from '@/lib/featureFilters'
import { chainLogoSrc } from '@/lib/chainLogos'
import { subscribeToClaim, subscribeToWalletClaims, type Claim, type ClaimStatus } from '@/lib/claimService'
import { lastClaimAllAt, CLAIM_ALL_COOLDOWN_MS, CLAIM_ALL_MIN_CHAIN } from '@/lib/ubClaim'
import { useLeaveGuard } from '@/lib/leaveGuard'

const NAMES: Record<string, string> = {
  Arc_Testnet: 'Arc', Ethereum_Sepolia: 'Ethereum', Base_Sepolia: 'Base', Arbitrum_Sepolia: 'Arbitrum', Optimism_Sepolia: 'Optimism',
  Polygon_Sepolia: 'Polygon', Avalanche_Fuji: 'Avalanche', HyperEVM_Testnet: 'HyperEVM', Sei_Testnet: 'Sei', Unichain_Sepolia: 'Unichain',
  Linea_Sepolia: 'Linea', World_Chain_Sepolia: 'World Chain', Sonic_Testnet: 'Sonic', Codex_Testnet: 'Codex', Ink_Testnet: 'Ink', Plume_Testnet: 'Plume',
  Solana_Devnet: 'Solana',
}
export const chainLabel = (id: string) => NAMES[id] ?? id.replace(/_(Sepolia|Testnet|Fuji)$/, '').replace(/_/g, ' ')

/** Smallest amount worth settling from one chain (the CCTP fee comes out of it). */
const SINGLE_MIN = 0.5

export type ChainFunds = { id: string; label: string; logo: string; balance: number }
export type Stage = 'waiting' | 'sending' | 'bridging' | 'verifying' | 'arrived' | 'failed'
export type RunRow = ChainFunds & { stage: Stage; message?: string; claimId?: string }

/** Where a filed claim is, as a settlement stage. */
export function claimStage(s: ClaimStatus): Stage {
  if (s === 'completed') return 'arrived'
  if (s === 'failed') return 'failed'
  if (s === 'verifying' || s === 'settling') return 'verifying'
  return 'bridging'
}

// ── Funds on other chains ────────────────────────────────────────────────

function useChainFunds() {
  const wallet = useAuthStore(s => s.walletAddress)
  const flags = useSettingsStore(s => s.settings)
  const flagsLoaded = useSettingsStore(s => s.loaded)
  const [balances, setBalances] = useState<Record<string, number> | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!wallet) { setBalances({}); return }
    let live = true
    const put = (id: string, b: number) => { if (live) setBalances(m => ({ ...(m ?? {}), [id]: b })) }
    readExternalBalances(wallet, flags, flagsLoaded)
      .then(r => { if (live) setBalances(Object.fromEntries(r.chains.map(c => [c.chainId, c.balance]))) })
      .catch(() => { if (live) setBalances(m => m ?? {}) })
    const onBalance = (e: Event) => { const d = (e as CustomEvent).detail; if (d?.chainId) put(d.chainId, d.balance) }
    window.addEventListener(EXTERNAL_BALANCE_EVENT, onBalance)
    // A claim that just moved re-reads its source chain.
    const stop = subscribeToWalletClaims(wallet, claims => {
      const fresh = claims.filter(c => c.status !== 'completed' || Date.now() - Date.parse(c.updatedAt) < 120_000)
      for (const id of new Set(fresh.map(c => c.sourceChain))) readExternalChainBalance(id as never, wallet).then(b => put(id, b)).catch(() => {})
    })
    const every = setInterval(() => setTick(t => t + 1), 5 * 60_000)
    return () => { live = false; window.removeEventListener(EXTERNAL_BALANCE_EVENT, onBalance); stop(); clearInterval(every) }
  }, [wallet, flags, flagsLoaded, tick])

  // Every CCTP chain that was checked and Admin Panel → Chains → Business →
  // Settle has on, $0 ones included (shown dimmed).
  const allChains = useMemo<ChainFunds[] | undefined>(() => balances === null ? undefined
    : Object.entries(balances).filter(([id]) => canBringOverCctp(id) && isChainEnabledForSettle(flags, id))
      .map(([id, balance]) => ({ id, label: chainLabel(id), logo: chainLogoSrc(id), balance }))
      .sort((a, b) => b.balance - a.balance || a.label.localeCompare(b.label)), [balances, flags])
  const chains = useMemo(() => allChains?.filter(c => c.balance > 0), [allChains])

  return { chains, allChains, rescan: useCallback(() => setTick(t => t + 1), []) }
}

// ── One settlement run ───────────────────────────────────────────────────

type RunState = { rows: RunRow[]; running: boolean }
type RunAction =
  | { type: 'start'; rows: ChainFunds[]; only?: string[] }
  | { type: 'row'; id: string; patch: Partial<RunRow> }
  | { type: 'fail'; ids: string[]; message: string }
  | { type: 'end' }

function runReducer(s: RunState, a: RunAction): RunState {
  switch (a.type) {
    case 'start':
      return { running: true, rows: a.only
        ? s.rows.map(r => a.only!.includes(r.id) ? { ...r, stage: 'waiting', message: undefined, claimId: undefined } : r)
        : a.rows.map(c => ({ ...c, stage: 'waiting' })) }
    case 'row':
      return { ...s, rows: s.rows.map(r => r.id === a.id ? { ...r, ...a.patch } : r) }
    case 'fail':
      return { ...s, rows: s.rows.map(r => a.ids.includes(r.id) && (r.stage === 'waiting' || r.stage === 'sending') ? { ...r, stage: 'failed', message: a.message } : r) }
    case 'end':
      return { ...s, running: false }
  }
}

export async function unlockSigner(passcode?: string): Promise<WalletAccount> {
  const signer = await getReadySigner(passcode, { silent: true })
  if (!signer) throw new Error('Wallet is locked - unlock MeshPort and try again')
  return signer
}

export function useSettlement() {
  const wallet = useAuthStore(s => s.walletAddress)
  const passcodeHash = useAuthStore(s => s.passcode)
  const { chains, allChains, rescan } = useChainFunds()
  const [run, dispatch] = useReducer(runReducer, { rows: [], running: false })
  useLeaveGuard(run.running, 'Settle')

  // Wait between settlements (Admin → Features "merchant_claim_all_cooldown").
  // Both read on every render (a hook can't sit behind the condition).
  const waitOn = useSettingsStore(s => s.isEnabled('merchant_claim_all_cooldown', true))
  const waitSetting = useSettingsStore(s => s.getValue('merchant_claim_all_cooldown'))
  const waitHours = waitOn ? (Number(waitSetting) || CLAIM_ALL_COOLDOWN_MS / 3_600_000) : 0
  const [lastAt, setLastAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (wallet) lastClaimAllAt(wallet).then(setLastAt, () => setLastAt(0)) }, [wallet])
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])
  const nextAt = lastAt && waitHours ? lastAt + waitHours * 3_600_000 : 0

  const due = (chains ?? []).filter(c => c.balance >= CLAIM_ALL_MIN_CHAIN)
  const total = due.reduce((s, c) => s + c.balance, 0)

  // Follow each filed claim to Arc.
  const claimKey = run.rows.map(r => r.claimId ?? '').join(',')
  useEffect(() => {
    const stops = run.rows.filter(r => r.claimId).map(r =>
      subscribeToClaim(r.claimId!, c => dispatch({ type: 'row', id: r.id, patch: { stage: claimStage(c.status), message: c.status === 'failed' ? c.error ?? undefined : undefined } })))
    return () => stops.forEach(s => s())
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately re-runs only on the listed values
  }, [claimKey])

  const settle = async (passcode?: string, only?: string[]) => {
    if (!wallet || run.running) return
    const list = only ? run.rows.filter(r => only.includes(r.id)) : due
    if (!list.length) return
    dispatch({ type: 'start', rows: list, only })
    try {
      const signer = await unlockSigner(passcode)
      const { merchantClaimAll } = await import('@/lib/ubClaim')
      const r = await merchantClaimAll({
        walletAddress: wallet, signer,
        chains: list.map(c => ({ chainId: c.id, balance: c.balance })),
        onStep: s => dispatch({ type: 'row', id: s.chainId, patch:
          s.state === 'error' ? { stage: 'failed', message: s.msg }
          : s.state === 'done' ? { stage: 'bridging', claimId: s.claimId }
          : { stage: 'sending', message: s.msg } }),
      })
      if (r.cctp > 0 && !only) setLastAt(Date.now())
      rescan()
    } catch (e) {
      dispatch({ type: 'fail', ids: list.map(c => c.id), message: e instanceof Error ? e.message : 'Settle failed' })
    }
    dispatch({ type: 'end' })
  }

  /** Settle one chain now (no wait between settlements, like Bring Funds). */
  const settleOne = async (chainId: string, passcode?: string) => {
    const c = (chains ?? []).find(x => x.id === chainId)
    if (!wallet || run.running || !c) return
    dispatch({ type: 'start', rows: [c] })
    try {
      if (c.balance < SINGLE_MIN) throw new Error(`Needs at least $${SINGLE_MIN.toFixed(2)} on ${c.label}`)
      const signer = await unlockSigner(passcode)
      const [{ bringFundsGasless }, { submitClaim }] = await Promise.all([import('@/lib/gaslessBridge'), import('@/lib/claimService')])
      const amount = Math.floor(c.balance * 1e6) / 1e6
      dispatch({ type: 'row', id: c.id, patch: { stage: 'sending', message: 'Signing…' } })
      const r = await bringFundsGasless({ chainId: c.id, amountUsdc: amount, signer, walletAddress: wallet,
        onStatus: msg => dispatch({ type: 'row', id: c.id, patch: { stage: 'sending', message: msg } }) })
      notifyExternalBalanceChanged(c.id, wallet, { spent: amount })
      // The claim is the burned amount: MeshPort's fee was taken before the burn.
      const claim = await submitClaim({ walletAddress: wallet, sourceChain: c.id, amount: Math.max(0, amount - r.fee), txHash: r.txHash, meshportFee: r.fee })
      dispatch({ type: 'row', id: c.id, patch: claim.success
        ? { stage: 'bridging', message: undefined, claimId: claim.claimId ?? undefined }
        : { stage: 'bridging', message: 'Sent - it will show in history shortly' } })
      rescan()
    } catch (e) {
      dispatch({ type: 'fail', ids: [c.id], message: e instanceof Error ? e.message.slice(0, 120) : 'Settle failed' })
    }
    dispatch({ type: 'end' })
  }

  const checkPasscode = async (code: string) => {
    if (!passcodeHash) return true
    const { verifyPasscode } = await import('@/lib/security')
    return verifyPasscode(code, passcodeHash)
  }

  return {
    chains, allChains, rescan, due, total, settleOne, singleMin: SINGLE_MIN,
    checked: lastAt !== null, ready: lastAt !== null && now >= nextAt, nextAt, waitHours,
    run: run.rows, running: run.running, needsPasscode: !!passcodeHash,
    checkPasscode, settle,
  }
}

/** This wallet's settlements (claims), live. */
export function useSettlementHistory(): Claim[] | undefined {
  const wallet = useAuthStore(s => s.walletAddress)
  const [claims, setClaims] = useState<Claim[] | undefined>(undefined)
  useEffect(() => {
    if (!wallet) { setClaims([]); return }
    return subscribeToWalletClaims(wallet, setClaims)
  }, [wallet])
  return claims
}
