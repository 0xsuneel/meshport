// components/multichain/TrackedMove.tsx
//
// A move that is no longer driven by this screen - opened from Hub Activity,
// or reopened after a refresh - shown as the same MoveProgress page the live
// flow uses, and its success receipt once it lands. Progress comes from the
// sources of truth that keep running without the app:
//   - CCTP (Transfer and Bring): Circle's attestation service, by burn hash
//   - Bring over CCTP without a burn hash yet: the claims row
//   - Bring over Unified Balance: its server intent (ub-claim-worker)
//   - Transfer over Unified Balance: no server record - only its finished row

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MoveProgress } from './MoveProgress'
import { SuccessReceipt } from '@/components/ui/SuccessReceipt'
import { SuccessFlash } from '@/components/ui/SuccessFlash'
import { TravelingCheckmark } from '@/components/ui/TravelingCheckmark'
import { isDesktopNow } from '@/lib/motion'
import { useCctpProgress } from '@/lib/cctpTracker'
import { subscribeToClaim, type Claim } from '@/lib/claimService'
import {
  moveSteps, indexFromCctpStage, indexFromClaimStatus, indexFromUbIntent, safeFromIndex,
  type MoveKind, type MoveRoute,
} from '@/lib/moveSteps'
import { formatAmount } from '@/lib/utils'
import { explorerTxUrl, arcExplorerTxUrl, ARC_CHAIN_KEY } from '@/lib/chainExplorers'
import { circleForwarderMintsTo } from '@/lib/chainRpcs'

export interface TrackedMoveInfo {
  kind: MoveKind
  route: MoveRoute
  /** App chain id of the other side (destination for a transfer, source for a bring). */
  chain: string
  chainLabel: string
  amount: number
  /** Transfer: where the USDC goes. */
  recipient?: string
  /** CCTP burn (transfer: on Arc; bring: on `chain`), or the UB deposit. */
  sourceTxHash?: string
  /** Mint on the destination, when already known. */
  destinationTxHash?: string
  claimId?: string
  ubIntentId?: string
  /** The move is already recorded as finished. */
  completed?: boolean
  /** Arrived amount, when known (brings). */
  arrivedAmount?: number
  timestamp?: number
}

const shortAddr = (a?: string) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

export function TrackedMove({ info, onClose, onViewHub, onArrived, backIcon = 'back' }: {
  info: TrackedMoveInfo
  onClose: () => void
  onViewHub?: () => void
  /** Called once when the move is seen to land. */
  onArrived?: (mintTxHash?: string) => void
  backIcon?: 'back' | 'close'
}) {
  const { kind, route } = info
  const from = kind === 'transfer' ? 'Arc' : info.chainLabel
  const to = kind === 'transfer' ? info.chainLabel : 'Arc'
  const forwarder = kind === 'transfer' && route === 'cctp' ? circleForwarderMintsTo(info.chain) : undefined
  const steps = moveSteps({ kind, route, from, to, amount: formatAmount(info.amount), recipient: shortAddr(info.recipient), forwarder })

  // Circle (CCTP with a burn hash)
  const burnChain = kind === 'transfer' ? ARC_CHAIN_KEY : info.chain
  const cctpHash = route === 'cctp' && !info.completed ? info.sourceTxHash : undefined
  const cctp = useCctpProgress(cctpHash ? burnChain : undefined, cctpHash, info.destinationTxHash)

  // Claims row (Bring over CCTP before the burn hash is known)
  const [claim, setClaim] = useState<Claim | null>(null)
  useEffect(() => {
    if (!info.claimId || info.completed) return
    return subscribeToClaim(info.claimId, setClaim)
  }, [info.claimId, info.completed])

  // Unified Balance intent (Bring over UB)
  const [ubStatus, setUbStatus] = useState<string | undefined>()
  useEffect(() => {
    if (!info.ubIntentId || info.completed) return
    let stop = false
    const load = async () => {
      try {
        const r = await fetch(`/api/bridge-relay?ub_intent_status=${encodeURIComponent(info.ubIntentId!)}`, { credentials: 'include' })
        const json = r.ok ? await r.json().catch(() => null) : null
        if (!stop && json?.status) setUbStatus(json.status as string)
      } catch { /* keep the last status */ }
    }
    void load()
    const iv = setInterval(load, 10_000)
    return () => { stop = true; clearInterval(iv) }
  }, [info.ubIntentId, info.completed])

  let current: number
  let failed: string | null = null
  let loading = false
  let mintTx = info.destinationTxHash
  if (info.completed) current = steps.length
  else if (cctpHash) {
    if (!cctp) { loading = true; current = 1 }
    else if (cctp.stage === 'error') { current = 3; failed = cctp.msg ?? 'Circle couldn’t finish this move. Your USDC is safe – finish it from Multichain Hub → Recover.' }
    else { current = indexFromCctpStage(cctp.stage); mintTx = cctp.mintTxHash || mintTx }
  } else if (info.claimId) {
    if (!claim) { loading = true; current = 1 }
    else if (claim.status === 'failed') { current = Math.max(1, indexFromClaimStatus('submitted')); failed = claim.error ?? 'This bring needs attention – finish it from Multichain Hub → Recover.' }
    else current = indexFromClaimStatus(claim.status)
  } else if (info.ubIntentId) {
    if (!ubStatus) { loading = true; current = 2 }
    else if (ubStatus === 'failed' || ubStatus === 'expired') { current = 2; failed = 'Your USDC is safe in your Unified Balance. It’s sent to Arc automatically, or finish it from Multichain Hub → Recover.' }
    else current = indexFromUbIntent(ubStatus)
  } else {
    // Nothing to follow (e.g. a Unified Balance transfer that never finished here).
    current = 1
    failed = 'Live progress isn’t available for this one. If it doesn’t arrive, finish it from Multichain Hub → Recover.'
  }

  const done = current >= steps.length
  useEffect(() => { if (done && !info.completed) onArrived?.(mintTx) }, [done]) // eslint-disable-line react-hooks/exhaustive-deps

  // Landing while this page is open gets the same moment as the live flow:
  // the success flash, then its check travels into the receipt and the
  // receipt rises in. A move opened already finished just shows its receipt.
  const live = !info.completed
  const [phase, setPhase] = useState<'flash' | 'collapsed'>('flash')
  useEffect(() => {
    if (!done || !live) return
    const t = setTimeout(() => setPhase('collapsed'), 1500)
    return () => clearTimeout(t)
  }, [done, live])
  const rootRef = useRef<HTMLDivElement>(null)
  const flashCheckRef = useRef<HTMLDivElement>(null)
  const lastFlashRect = useRef<DOMRect | null>(null)
  const [flashRect, setFlashRect] = useState<DOMRect | null>(null)
  const [heroCheck, setHeroCheck] = useState<HTMLDivElement | null>(null)
  const [travel, setTravel] = useState<{ from: DOMRect; to: DOMRect } | null>(null)
  const [travelDone, setTravelDone] = useState(false)
  useLayoutEffect(() => {
    if (phase === 'flash' && flashCheckRef.current) lastFlashRect.current = flashCheckRef.current.getBoundingClientRect()
  })
  // Desktop: the flash covers this page's panel (or column), not the window.
  useLayoutEffect(() => {
    if (!done || !live || !isDesktopNow()) return
    const target = rootRef.current?.closest('[data-hub-page], [data-flow-scroller]') as HTMLElement | null
    setFlashRect((target ?? rootRef.current)?.getBoundingClientRect() ?? null)
  }, [done, live])
  useLayoutEffect(() => {
    if (phase !== 'collapsed' || !heroCheck) return
    const from = lastFlashRect.current
    if (!from) { setTravelDone(true); return }
    setTravel({ from, to: heroCheck.getBoundingClientRect() })
    const t = setTimeout(() => setTravelDone(true), 520)
    return () => clearTimeout(t)
  }, [phase, heroCheck])

  if (done && live && phase === 'flash') {
    return (
      <div ref={rootRef} style={{ minHeight: '100%' }}>
        <SuccessFlash title={kind === 'transfer' ? 'Transfer Complete' : 'Funds Arrived'} checkRef={flashCheckRef} rect={flashRect} radius={20} />
      </div>
    )
  }

  if (done) {
    const srcHref = info.sourceTxHash ? (kind === 'transfer' ? arcExplorerTxUrl(info.sourceTxHash) : explorerTxUrl(info.chain, info.sourceTxHash)) : null
    const mintHref = mintTx ? (kind === 'transfer' ? explorerTxUrl(info.chain, mintTx) : arcExplorerTxUrl(mintTx)) : null
    const amountLabel = `${formatAmount(info.amount)} USDC`
    return (
      <div ref={rootRef} style={{ margin: '0 -12px', minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
        {live && travel && !travelDone && <TravelingCheckmark from={travel.from} to={travel.to} toStroke="var(--success)" />}
        <SuccessReceipt
          style={{ height: 'auto', flex: 1, minHeight: 0 }}
          checkRef={live ? setHeroCheck : undefined}
          revealed={live ? travelDone : true} celebrate={live}
          title={kind === 'transfer' ? 'Transfer Complete' : 'Funds Arrived'}
          subtitle={kind === 'transfer' ? <>Moved from Arc to {to}</> : <>From {from}, now in your Arc wallet</>}
          rows={[
            { label: kind === 'transfer' ? 'You Sent' : 'Brought', value: amountLabel },
            ...(info.arrivedAmount != null ? [{ label: 'Received', value: `${formatAmount(info.arrivedAmount)} USDC`, positive: true }] : []),
            ...(info.recipient ? [{ label: 'Recipient', value: shortAddr(info.recipient)! }] : []),
            { label: 'Route', value: route === 'ub' ? 'Unified Balance' : 'CCTP' },
          ]}
          steps={steps.map(s => s.done)}
          links={[
            ...(info.sourceTxHash && srcHref ? [{ title: `View on ${from} explorer`, explorer: from, hash: info.sourceTxHash, href: srcHref }] : []),
            ...(mintTx && mintHref ? [{ title: `View mint on ${to} explorer`, explorer: to, hash: mintTx, href: mintHref }] : []),
          ]}
          onPrimary={onClose}
          actions={[
            ...(onViewHub ? [{ label: 'View in Hub', onClick: onViewHub }] : []),
            { label: 'Done', onClick: onClose, primary: true },
          ]}
        />
      </div>
    )
  }

  // Whatever drives it now runs without this page: the server for a bring,
  // Circle's forwarder for a CCTP transfer. A transfer MeshPort's relayer
  // mints is finished by the transfer screen - from here, only Recover can.
  const safe = kind === 'bring' || current >= safeFromIndex(kind, route, { forwarder })
    || (route === 'cctp' && forwarder !== false && !!info.sourceTxHash)
  const srcTx = info.sourceTxHash
    ? { hash: info.sourceTxHash, href: kind === 'transfer' ? arcExplorerTxUrl(info.sourceTxHash) : explorerTxUrl(info.chain, info.sourceTxHash) }
    : undefined
  const txs = route === 'ub'
    ? [srcTx, undefined, undefined, mintTx ? { hash: mintTx } : undefined]
    : [undefined, srcTx, undefined, mintTx ? { hash: mintTx } : undefined]
  return (
    <MoveProgress
      kind={kind} route={route} fromLabel={from} toLabel={to} amount={info.amount}
      steps={steps} current={current} failed={failed} loading={loading}
      safe={safe} txs={txs}
      holdText={`MeshPort mints on ${to} while the transfer screen is open. If it doesn't arrive, finish it from Multichain Hub → Recover.`}
      onBack={onClose} backIcon={backIcon} onViewHub={onViewHub ?? onClose} trackButton={false}
    />
  )
}
