// Business → Settlements data. Same money movement as the Ledger's Claim All,
// without its UI:
//   useLedgerChains  USDC waiting on CCTP chains (readExternalBalances - the
//                    Hub's own scan), refreshed when a claim changes.
//   useSettle        merchantClaimAll (CCTP; MeshPort's relayer pays gas),
//                    with the same Claim All wait, passcode check and key
//                    restore as MerchantLedger's ClaimAllCard, plus each
//                    chain's live stage from its claims row.
//   useSettleHistory recent claims for this wallet.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuthStore } from '@/store'
import { useSettingsStore } from '@/store/settingsStore'
import { readExternalBalances, readExternalChainBalance, EXTERNAL_BALANCE_EVENT } from '@/blockchain/BlockchainManager'
import { isGaslessBridgeAvailable } from '@/lib/gaslessBridge'
import { chainLogoSrc } from '@/lib/chainLogos'
import { subscribeToClaim, subscribeToWalletClaims, type Claim, type ClaimStatus } from '@/lib/claimService'
import { lastClaimAllAt, CLAIM_ALL_COOLDOWN_MS, CLAIM_ALL_MIN_CHAIN, type ClaimAllStep } from '@/lib/ubClaim'
import { useLeaveGuard } from '@/lib/leaveGuard'

const LABEL: Record<string, string> = {
  Arc_Testnet: 'Arc', Ethereum_Sepolia: 'Ethereum', Base_Sepolia: 'Base', Arbitrum_Sepolia: 'Arbitrum', Optimism_Sepolia: 'Optimism',
  Polygon_Sepolia: 'Polygon', Avalanche_Fuji: 'Avalanche', HyperEVM_Testnet: 'HyperEVM', Sei_Testnet: 'Sei', Unichain_Sepolia: 'Unichain',
  Linea_Sepolia: 'Linea', World_Chain_Sepolia: 'World Chain', Sonic_Testnet: 'Sonic', Codex_Testnet: 'Codex', Ink_Testnet: 'Ink', Plume_Testnet: 'Plume',
}
export const chainLabel = (id: string) => LABEL[id] ?? id.replace(/_(Sepolia|Testnet|Fuji)$/, '').replace(/_/g, ' ')

export type LedgerChain = { id: string; label: string; logo: string; balance: number }

/** USDC on the merchant's CCTP chains; undefined while the first scan runs. */
export function useLedgerChains(): { chains: LedgerChain[] | undefined; refresh: () => void } {
  const walletAddress = useAuthStore(s => s.walletAddress)
  const settingsMap = useSettingsStore(s => s.settings)
  const settingsLoaded = useSettingsStore(s => s.loaded)
  const [map, setMap] = useState<Record<string, number> | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const mapRef = useRef<Record<string, number>>({})

  useEffect(() => {
    if (!walletAddress) { setMap({}); return }
    let cancelled = false
    readExternalBalances(walletAddress, settingsMap, settingsLoaded).then(({ chains }) => {
      if (cancelled) return
      const m: Record<string, number> = {}
      for (const c of chains) m[c.chainId] = c.balance
      mapRef.current = m; setMap(m)
    }).catch(() => { if (!cancelled) setMap(mapRef.current) })
    // A bridge this app just sent moved funds on one chain.
    const onExternal = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      if (d.chainId) { mapRef.current = { ...mapRef.current, [d.chainId]: d.balance }; setMap(mapRef.current) }
    }
    window.addEventListener(EXTERNAL_BALANCE_EVENT, onExternal)
    // A claim moving forward changes its source chain's balance.
    const unsub = subscribeToWalletClaims(walletAddress, claims => {
      const touched = [...new Set(claims.filter(c => c.status !== 'completed' || Date.now() - new Date(c.updatedAt).getTime() < 120_000).map(c => c.sourceChain))]
      touched.forEach(id => readExternalChainBalance(id as never, walletAddress).then(b => {
        if (cancelled) return
        mapRef.current = { ...mapRef.current, [id]: b }; setMap(mapRef.current)
      }).catch(() => {}))
    })
    const iv = setInterval(() => setNonce(n => n + 1), 5 * 60_000)
    return () => { cancelled = true; window.removeEventListener(EXTERNAL_BALANCE_EVENT, onExternal); unsub(); clearInterval(iv) }
  }, [walletAddress, settingsMap, settingsLoaded, nonce])

  const chains = useMemo(() => map === undefined ? undefined : Object.entries(map)
    .filter(([id, b]) => isGaslessBridgeAvailable(id) && b > 0)
    .map(([id, balance]) => ({ id, label: chainLabel(id), logo: chainLogoSrc(id), balance }))
    .sort((a, b) => b.balance - a.balance), [map])

  return { chains, refresh: useCallback(() => setNonce(n => n + 1), []) }
}

export type SettleStage = 'waiting' | 'sending' | 'bridging' | 'verifying' | 'arrived' | 'failed'
export type SettleRow = { id: string; label: string; logo: string; amount: number; stage: SettleStage; message?: string; claimId?: string }

export const STAGE_OF: Record<ClaimStatus, SettleStage> = {
  submitted: 'bridging', bridging: 'bridging', verifying: 'verifying', settling: 'verifying', completed: 'arrived', failed: 'failed',
}

/** Settle (Claim All) with the Ledger's rules. */
export function useSettle(chains: LedgerChain[] | undefined, onSettled?: () => void) {
  const walletAddress = useAuthStore(s => s.walletAddress)
  const storedPasscode = useAuthStore(s => s.passcode)
  const [last, setLast] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<Record<string, ClaimAllStep>>({})
  const [claimStage, setClaimStage] = useState<Record<string, ClaimStatus>>({})
  const [runChains, setRunChains] = useState<LedgerChain[]>([])
  useLeaveGuard(running, 'Settle')

  useEffect(() => { if (walletAddress) lastClaimAllAt(walletAddress).then(setLast).catch(() => setLast(0)) }, [walletAddress])
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])

  // Admin → Features: "Claim All wait" (off = any time; value = hours).
  const cooldownOn = useSettingsStore(st => st.isEnabled('merchant_claim_all_cooldown', true))
  const cooldownHours = Number(useSettingsStore(st => st.getValue('merchant_claim_all_cooldown'))) || CLAIM_ALL_COOLDOWN_MS / 3_600_000
  const nextAt = last && cooldownOn ? last + cooldownHours * 3_600_000 : 0
  const ready = last !== null && now >= nextAt

  const due = (chains ?? []).filter(c => c.balance >= CLAIM_ALL_MIN_CHAIN)
  const total = due.reduce((s, c) => s + c.balance, 0)

  // Live stage of every chain sent in this run.
  const claimIds = Object.values(steps).map(s => s.claimId).filter(Boolean) as string[]
  useEffect(() => {
    const unsubs = Object.values(steps).filter(s => s.claimId).map(s =>
      subscribeToClaim(s.claimId!, c => setClaimStage(prev => ({ ...prev, [s.chainId]: c.status }))))
    return () => unsubs.forEach(u => u())
  }, [claimIds.join(',')])

  const run = async (passcode?: string, only?: string[]) => {
    if (!walletAddress) return
    const list = only ? runChains.filter(c => only.includes(c.id)) : due
    if (list.length === 0) return
    if (only) {
      setSteps(prev => { const n = { ...prev }; only.forEach(id => delete n[id]); return n })
      setClaimStage(prev => { const n = { ...prev }; only.forEach(id => delete n[id]); return n })
    } else { setRunChains(list); setSteps({}); setClaimStage({}) }
    setRunning(true)
    try {
      let key = useAuthStore.getState().privateKey
      if (!key) {
        const { restorePrivateKey } = await import('@/lib/restoreWallet')
        await restorePrivateKey(passcode, { silent: true }).catch(() => false)
        key = useAuthStore.getState().privateKey
      }
      if (!key) throw new Error('Wallet unavailable - unlock MeshPort and try again')
      const { merchantClaimAll } = await import('@/lib/ubClaim')
      const r = await merchantClaimAll({
        walletAddress, privateKey: key,
        chains: list.map(c => ({ chainId: c.id, balance: c.balance })),
        onStep: s => setSteps(prev => ({ ...prev, [s.chainId]: s })),
      })
      if (r.cctp > 0 && !only) setLast(Date.now())
      onSettled?.()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Settle failed'
      setSteps(prev => {
        const n = { ...prev }
        list.forEach(c => { if (!n[c.id] || n[c.id].state === 'working') n[c.id] = { chainId: c.id, state: 'error', msg } })
        return n
      })
    }
    setRunning(false)
  }

  /** Checks the passcode (when the wallet has one) before settling. */
  const verify = async (code: string) => {
    if (!storedPasscode) return true
    const { verifyPasscode } = await import('@/lib/security')
    return verifyPasscode(code, storedPasscode)
  }

  const rows: SettleRow[] = runChains.map(c => {
    const s = steps[c.id], cs = claimStage[c.id]
    const stage: SettleStage = s?.state === 'error' ? 'failed'
      : cs ? STAGE_OF[cs]
      : s?.state === 'done' ? 'bridging'
      : s?.state === 'working' ? 'sending' : 'waiting'
    return { id: c.id, label: c.label, logo: c.logo, amount: c.balance, stage, message: stage === 'failed' ? s?.msg : undefined, claimId: s?.claimId }
  })

  return {
    due, total, ready, nextAt, running, rows, needsPasscode: !!storedPasscode,
    cooldownHours: cooldownOn ? cooldownHours : 0, checked: last !== null,
    verify, start: (passcode?: string) => run(passcode), retry: (ids: string[], passcode?: string) => run(passcode, ids),
  }
}

/** Recent claims (settlements) of this wallet, live. */
export function useSettleHistory(): Claim[] | undefined {
  const walletAddress = useAuthStore(s => s.walletAddress)
  const [claims, setClaims] = useState<Claim[] | undefined>(undefined)
  useEffect(() => {
    if (!walletAddress) { setClaims([]); return }
    return subscribeToWalletClaims(walletAddress, setClaims)
  }, [walletAddress])
  return claims
}
