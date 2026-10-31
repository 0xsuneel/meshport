// lib/moveSteps.ts
//
// The one checklist a Multichain move shows, from the moment it's confirmed
// until it lands: Transfer (Arc → another chain) and Bring (another chain →
// Arc), over CCTP or Unified Balance (Circle Gateway). Four real steps each,
// named after Circle's own process:
//
//   CCTP (provider-cctp-v2 "Bridge Process"): Approval → Burn → Attestation → Mint
//   Gateway (provider-gateway-v1): Deposit, then Sign → Fetch Attestation → Mint
//   CCTPx (EURC / cirBTC, provider-cctpx): Approve → Send → Attestation → Deliver
//     (route 'cctp' with a `token`: the same four positions, so the same mappers)
//
// Bring over CCTP is MeshPort's gasless route: you sign, MeshPort's relayer
// sends the burn (paying the gas), Circle's forwarder mints on Arc. Bring over
// Unified Balance waits for the source chain to make the deposit final -
// Gateway only credits a final deposit - so that wait is a step of its own.
// Arc itself is final in under a second.
//
// Each step has three texts: what comes next, what's happening now, and what
// happened. The mappers below turn every source of truth the app has (SDK
// step events, Circle's attestation service, the claims row, the Unified
// Balance intent) into "index of the step in progress" - 0..3, or 4 when all
// are done.

export type MoveKind = 'transfer' | 'bring'
export type MoveRoute = 'cctp' | 'ub'

export interface MoveStepText {
  label: string
  upcoming: string
  active: string
  done: string
  /** How long this step usually takes, shown while it runs. */
  eta: string
}

export const MOVE_STEP_COUNT = 4

export function moveSteps(p: {
  kind: MoveKind; route: MoveRoute
  /** Display names, e.g. 'Arc', 'Base'. */
  from: string; to: string
  /** Formatted amount without the unit, e.g. '250.00'. */
  amount: string
  /** Short recipient for transfers, e.g. '0x7a3F…91cE'. */
  recipient?: string
  /** Transfer CCTP: Circle's forwarder mints (else MeshPort's relayer). */
  forwarder?: boolean
  /** Bring UB: the source chain finalizes in under a minute. */
  fastFinality?: boolean
  /** The coin: USDC (default), or EURC / cirBTC over Circle CCTPx. */
  token?: string
}): MoveStepText[] {
  const { kind, route, from, to, amount } = p
  const usdc = `${amount} USDC`
  const toWho = p.recipient ? ` to ${p.recipient}` : ''
  // EURC / cirBTC (Circle CCTPx): sent and delivered - not burned and minted.
  const tok = p.token && p.token !== 'USDC' ? p.token : null
  if (tok) {
    const coin = `${amount} ${tok}`
    if (kind === 'transfer') return [
      { label: `Approve ${tok}`, upcoming: `Let Circle's bridge use ${coin} on Arc`, active: 'Approving on Arc…', done: `Circle's bridge can use the ${tok}`, eta: 'under a second' },
      { label: 'Send from Arc', upcoming: `Sends the ${tok} out of Arc`, active: `Sending ${coin} from Arc…`, done: `${tok} left your Arc wallet`, eta: 'under a second' },
      { label: 'Circle attestation', upcoming: 'Circle confirms the transfer', active: 'Circle is signing the transfer…', done: 'Circle signed the transfer', eta: '20–90 seconds' },
      { label: `Deliver on ${to}`, upcoming: `${tok} delivered${toWho}`, active: `Circle's forwarder is delivering on ${to}…`, done: `${tok} arrived${toWho}`, eta: 'under a minute' },
    ]
    return [
      { label: `Sign on ${from}`, upcoming: `Approve ${coin} – no gas needed`, active: 'Signing – no gas needed…', done: 'Authorized – no gas needed', eta: 'a second' },
      { label: `Send from ${from}`, upcoming: "MeshPort sends it and pays the gas and Circle's fee", active: `MeshPort is sending ${coin} from ${from}…`, done: "MeshPort paid the gas and Circle's fee", eta: 'a few seconds' },
      { label: 'Circle attestation', upcoming: 'Circle confirms the transfer', active: 'Circle is signing the transfer…', done: 'Circle signed the transfer', eta: '20–90 seconds' },
      { label: 'Deliver on Arc', upcoming: `${tok} lands in your Arc wallet`, active: "Circle's forwarder is delivering on Arc…", done: `${tok} is in your Arc wallet`, eta: 'under a minute' },
    ]
  }
  // Texts never restate the step's own name: "upcoming" says what the step
  // is for, "done" says what it achieved. "You can close the app" lives in
  // the page's Safe to leave note, not here.
  if (kind === 'transfer' && route === 'cctp') return [
    { label: 'Approve USDC', upcoming: `Let Circle's bridge use ${usdc} on Arc`, active: 'Approving on Arc…', done: "Circle's bridge can use the USDC", eta: 'under a second' },
    { label: 'Burn on Arc', upcoming: 'Sends the USDC out of Arc', active: `Burning ${usdc} on Arc…`, done: 'USDC left your Arc wallet', eta: 'under a second' },
    { label: 'Circle attestation', upcoming: 'Circle confirms the burn', active: 'Circle is signing the burn…', done: 'Circle signed the burn', eta: '20–90 seconds' },
    { label: `Mint on ${to}`, upcoming: `USDC minted${toWho}`, active: p.forwarder === false ? `MeshPort is minting on ${to}…` : `Circle's forwarder is minting on ${to}…`, done: `USDC arrived${toWho}`, eta: 'under a minute' },
  ]
  if (kind === 'transfer') return [
    { label: 'Deposit on Arc', upcoming: `Move ${usdc} into Unified Balance`, active: `Moving ${usdc} into Unified Balance on Arc…`, done: 'USDC is in your Unified Balance', eta: 'under a second' },
    { label: 'Sign transfer', upcoming: `Authorize the move to ${to}`, active: 'Signing the transfer…', done: `Move to ${to} authorized`, eta: 'a second or two' },
    { label: 'Circle Gateway approval', upcoming: 'Circle checks your Unified Balance', active: 'Circle Gateway is approving the transfer…', done: 'Approved by Circle Gateway', eta: 'a few seconds' },
    { label: `Mint on ${to}`, upcoming: `USDC minted${toWho}`, active: `Minting on ${to}…`, done: `USDC arrived${toWho}`, eta: 'under a minute' },
  ]
  if (route === 'cctp') return [
    { label: `Sign on ${from}`, upcoming: `Approve ${usdc} – no gas needed`, active: 'Signing – no gas needed…', done: 'Authorized – no gas needed', eta: 'a second' },
    { label: `Burn on ${from}`, upcoming: 'MeshPort sends it and pays the gas', active: `MeshPort is burning ${usdc} on ${from}…`, done: 'MeshPort paid the gas', eta: 'a few seconds' },
    { label: 'Circle attestation', upcoming: 'Circle confirms the burn', active: 'Circle is signing the burn…', done: 'Circle signed the burn', eta: '20–90 seconds' },
    { label: 'Mint on Arc', upcoming: 'USDC lands in your Arc wallet', active: "Circle's forwarder is minting on Arc…", done: 'USDC is in your Arc wallet', eta: 'a few seconds' },
  ]
  return [
    { label: `Deposit on ${from}`, upcoming: `Move ${usdc} into Unified Balance`, active: `Moving ${usdc} into Unified Balance on ${from}…`, done: 'USDC is in your Unified Balance', eta: 'under a minute' },
    { label: 'Sign transfer', upcoming: 'Authorize the move to Arc', active: 'Signing and handing it to MeshPort…', done: 'MeshPort finishes the rest', eta: 'a second or two' },
    { label: `${from} finality`, upcoming: 'Needed before Circle Gateway can send it', active: `Waiting for ${from} to make the deposit final…`, done: `${from} confirmed the deposit`, eta: p.fastFinality ? 'under a minute' : 'up to 15 minutes' },
    { label: 'Mint on Arc', upcoming: 'USDC lands in your Arc wallet', active: 'Circle Gateway is sending to your Arc wallet…', done: 'USDC is in your Arc wallet', eta: 'a few seconds' },
  ]
}

/** First step not yet done, from SDK step states in order (all done → length). */
export function indexFromStepStates(states: Array<'pending' | 'active' | 'done' | 'error'>): number {
  const i = states.findIndex(s => s !== 'done')
  return i === -1 ? states.length : i
}

/**
 * A CCTP burn followed through Circle's attestation service (lib/cctpTracker).
 * The burn hash exists, so Approve (transfers) / Sign (brings) is done.
 */
export function indexFromCctpStage(stage: 'burning' | 'attesting' | 'minting' | 'done' | 'error'): number {
  return stage === 'done' ? 4 : stage === 'minting' ? 3 : stage === 'attesting' ? 2 : 1
}

/** A Bring over CCTP followed through its claims row. */
export function indexFromClaimStatus(status: string | undefined): number {
  switch (status) {
    case 'completed': return 4
    case 'verifying':
    case 'settling': return 3
    case 'bridging': return 2
    default: return 1 // submitted: the burn isn't confirmed yet
  }
}

/** A Bring over Unified Balance followed through its server intent. */
export function indexFromUbIntent(status: string | undefined): number {
  return status === 'completed' ? 4 : status === 'submitted' ? 3 : 2
}

/** A Bring running on this device, from runUbClaim / the gasless route's stages. */
export function indexFromBringStage(route: MoveRoute, stage: string, handedOff?: boolean): number {
  switch (stage) {
    case 'done': return 4
    case 'minting': return 3
    case 'attesting': return route === 'ub' && !handedOff ? 1 : 2
    case 'burning': return 1
    default: return 0 // waiting / gas / approving
  }
}

/**
 * From which step on the move no longer needs this screen: the server (or
 * Circle) finishes it. A Transfer over Unified Balance, or over CCTP to a
 * chain MeshPort's relayer mints on, is driven by this device to the end.
 */
export function safeFromIndex(kind: MoveKind, route: MoveRoute, opts: { forwarder?: boolean } = {}): number {
  if (kind === 'transfer' && (route === 'ub' || opts.forwarder === false)) return MOVE_STEP_COUNT
  return 2
}
