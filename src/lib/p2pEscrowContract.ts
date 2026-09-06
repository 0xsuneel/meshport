// lib/p2pEscrowContract.ts
//
// Low-level interaction with the deployed P2PEscrow contract (see
// contracts/P2PEscrow.sol). This file only knows how to construct and send
// real transactions against that specific contract — the higher-level
// decision of "is a real contract even deployed, or should we fall back"
// lives in p2pProviders.ts, not here.
//
// USDC on Arc is native currency (see arcService.ts's own comment on this —
// plain value transfers, not ERC-20), so every call here that moves value
// uses `value:` on the transaction itself, not an approve/transferFrom
// pattern.

import {
  createPublicClient, createWalletClient, encodeFunctionData, keccak256, toHex,
  parseGwei, type Hash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTransport } from './arc'
import { ARC_CHAIN_INLINE } from './arcService'

const CONTRACT_ADDRESS = (import.meta.env.VITE_P2P_ESCROW_CONTRACT as string || '').trim() as `0x${string}` | ''

export function isEscrowContractDeployed(): boolean {
  return !!CONTRACT_ADDRESS
}

// Minimal ABI — only the functions/events this app actually calls or reads.
const ESCROW_ABI = [
  {
    type: 'function', name: 'deposit', stateMutability: 'payable',
    inputs: [{ name: 'offerKey', type: 'bytes32' }], outputs: [],
  },
  {
    type: 'function', name: 'release', stateMutability: 'nonpayable',
    inputs: [
      { name: 'offerKey', type: 'bytes32' }, { name: 'tradeKey', type: 'bytes32' },
      { name: 'buyer', type: 'address' }, { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'withdrawRemaining', stateMutability: 'nonpayable',
    inputs: [{ name: 'offerKey', type: 'bytes32' }], outputs: [],
  },
  {
    type: 'function', name: 'getRemaining', stateMutability: 'view',
    inputs: [{ name: 'offerKey', type: 'bytes32' }], outputs: [{ type: 'uint256' }],
  },
  {
    // Solidity auto-generates this getter for `mapping(bytes32 => bool) public
    // tradeReleased` (P2PEscrow.sol:60). It is the authoritative answer to "did
    // this trade's release actually happen on-chain?" — which is what lets the
    // stuck-release reconciler below decide what to do WITHOUT guessing about
    // money. Free: view call, no transaction, no gas.
    type: 'function', name: 'tradeReleased', stateMutability: 'view',
    inputs: [{ name: 'tradeKey', type: 'bytes32' }], outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'freezeTrade', stateMutability: 'nonpayable',
    inputs: [{ name: 'tradeKey', type: 'bytes32' }], outputs: [],
  },
  {
    type: 'function', name: 'unfreezeTrade', stateMutability: 'nonpayable',
    inputs: [{ name: 'tradeKey', type: 'bytes32' }], outputs: [],
  },
  {
    type: 'function', name: 'pause', stateMutability: 'nonpayable', inputs: [], outputs: [],
  },
  {
    type: 'function', name: 'unpause', stateMutability: 'nonpayable', inputs: [], outputs: [],
  },
  {
    type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'transferAdmin', stateMutability: 'nonpayable',
    inputs: [{ name: 'newAdmin', type: 'address' }], outputs: [],
  },
  {
    type: 'function', name: 'acceptAdmin', stateMutability: 'nonpayable',
    inputs: [], outputs: [],
  },
  // ── P2PMeshportEscrow-only (role-based) functions — no-op / unused
  // against the old single-admin P2PEscrow, harmless to include in one
  // shared ABI since encodeFunctionData only touches the entries actually
  // referenced by name.
  {
    type: 'function', name: 'addPauser', stateMutability: 'nonpayable',
    inputs: [{ name: 'account', type: 'address' }], outputs: [],
  },
  {
    type: 'function', name: 'removePauser', stateMutability: 'nonpayable',
    inputs: [{ name: 'account', type: 'address' }], outputs: [],
  },
  {
    type: 'function', name: 'isPauser', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bool' }],
  },
  {
    // Solidity auto-generates this getter for `address public admin` —
    // used by adminFetchEscrowAdminAddress() below to let the admin panel
    // show a clear "your wallet doesn't match the contract's admin" warning
    // instead of a confusing dead-end failure on release/pause.
    type: 'function', name: 'admin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }],
  },
] as const

/** Deterministic on-chain key for an offer — same offerId always produces the same key, nothing extra needs to be stored to reconstruct it. */
export function offerKeyFor(offerId: string): `0x${string}` {
  return keccak256(toHex(offerId))
}
export function tradeKeyFor(tradeId: string): `0x${string}` {
  return keccak256(toHex(tradeId))
}

const USDC_DECIMALS = 18 // native on Arc — see arcService.ts's own amount18dec conversion

function toNativeUnits(amountUsdc: number): bigint {
  const amount6dec = BigInt(Math.round(amountUsdc * 1_000_000))
  return amount6dec * (10n ** BigInt(USDC_DECIMALS - 6))
}

function sleepMs(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// Transient, worth retrying: our own /api/arc-rpc proxy returning 502/503
// (every upstream RPC momentarily failed at once, e.g. a shared public
// endpoint hitting its rate limit — see api/arc-rpc.js's own comments),
// or a network-level timeout/fetch failure reaching it. NOT worth
// retrying: an actual contract revert (wrong signer, paused already,
// insufficient funds, etc.) — retrying that just wastes gas and time on
// something that will fail the same way every time.
function isTransientRpcError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e ?? '').toLowerCase()
  return (
    msg.includes('502') || msg.includes('503') || msg.includes('bad gateway') ||
    msg.includes('gateway timeout') || msg.includes('fetch failed') ||
    msg.includes('timeout') || msg.includes('network')
  )
}

async function sendContractTx(privateKey: string, functionName: string, args: readonly unknown[], value: bigint = 0n): Promise<Hash> {
  if (!CONTRACT_ADDRESS) throw new Error('P2P escrow contract is not configured (VITE_P2P_ESCROW_CONTRACT unset)')

  const MAX_ATTEMPTS = 3 // 1 initial + 2 retries
  let lastErr: unknown = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleepMs(1000 * attempt) // 1s, then 2s
    try {
      return await sendContractTxOnce(privateKey, functionName, args, value)
    } catch (e) {
      lastErr = e
      if (!isTransientRpcError(e)) throw e // real revert/logic error — fail immediately, don't retry
      // else: transient — loop and try again (nonce/gas are re-fetched fresh each attempt)
    }
  }
  throw lastErr ?? new Error(`${functionName}: failed after ${MAX_ATTEMPTS} attempts`)
}

async function sendContractTxOnce(privateKey: string, functionName: string, args: readonly unknown[], value: bigint): Promise<Hash> {
  if (!CONTRACT_ADDRESS) throw new Error('P2P escrow contract is not configured (VITE_P2P_ESCROW_CONTRACT unset)')
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 30000 }) })
  const walletClient = createWalletClient({ account, transport: arcTransport() })

  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: functionName as any, args: args as any })
  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
  const gasEstimate = await publicClient.estimateGas({ account: account.address, to: CONTRACT_ADDRESS, data, value })

  // Cast: see the identical comment in arcService.ts/rewards.ts — viem's
  // sendTransaction overload resolution spuriously demands an EIP-4844
  // `kzg` field here too. Runtime behavior is unaffected.
  return walletClient.sendTransaction({
    to: CONTRACT_ADDRESS,
    data,
    value,
    gas: (gasEstimate * 130n) / 100n, // contract calls need more margin than a plain value transfer
    maxFeePerGas: parseGwei('25'),
    maxPriorityFeePerGas: parseGwei('1'),
    chain: ARC_CHAIN_INLINE,
    nonce,
  } as unknown as Parameters<typeof walletClient.sendTransaction>[0])
}

/** Seller deposits USDC for their offer. Real on-chain transaction — the deposit IS the value sent with this call. */
export async function depositToEscrow(privateKey: string, offerId: string, amountUsdc: number): Promise<Hash> {
  return sendContractTx(privateKey, 'deposit', [offerKeyFor(offerId)], toNativeUnits(amountUsdc))
}

/**
 * Deposits escrow keyed by a TRADE's own id rather than an offer's — used
 * for buy-offer trades, where escrow is genuinely per-trade (a different
 * seller accepts the same buy offer each time, each depositing their own
 * funds for their own trade) rather than accumulated per-offer the way
 * sell-offer escrow is. Same contract, same deposit() function — the
 * "offerKey" the contract stores against is just whichever bytes32 key is
 * passed in; using a trade's key here instead of an offer's is a valid,
 * intentional reuse, not a workaround.
 */
export async function depositForTrade(privateKey: string, tradeId: string, amountUsdc: number): Promise<Hash> {
  return sendContractTx(privateKey, 'deposit', [tradeKeyFor(tradeId)], toNativeUnits(amountUsdc))
}

/**
 * Releases a buy-offer trade's escrowed funds (deposited under the trade's
 * own key via depositForTrade above) to the buyer. Both the bucket key and
 * the freeze-check key are the trade's own key here — there's no separate
 * "offer" bucket this trade's funds were ever accumulated into.
 */
export async function releaseTradeKeyedEscrow(privateKey: string, tradeId: string, buyerAddress: string, amountUsdc: number): Promise<Hash> {
  const key = tradeKeyFor(tradeId)
  return sendContractTx(privateKey, 'release', [key, key, buyerAddress as `0x${string}`, toNativeUnits(amountUsdc)])
}

/** Refunds a buy-offer trade's escrowed deposit back to the seller who deposited it (e.g. the trade was cancelled or expired). */
export async function refundTradeKeyedEscrow(privateKey: string, tradeId: string): Promise<Hash> {
  return sendContractTx(privateKey, 'withdrawRemaining', [tradeKeyFor(tradeId)])
}

/** Releases a specific trade's amount from the offer's escrow directly to the buyer. */
export async function releaseFromEscrow(privateKey: string, offerId: string, tradeId: string, buyerAddress: string, amountUsdc: number): Promise<Hash> {
  return sendContractTx(privateKey, 'release', [offerKeyFor(offerId), tradeKeyFor(tradeId), buyerAddress as `0x${string}`, toNativeUnits(amountUsdc)])
}

/** Seller reclaims whatever's left in escrow for an offer (used when the offer itself is cancelled/paused). */
export async function withdrawRemainingFromEscrow(privateKey: string, offerId: string): Promise<Hash> {
  return sendContractTx(privateKey, 'withdrawRemaining', [offerKeyFor(offerId)])
}

/**
 * On-chain trade freeze/unfreeze — the contract-level backstop for a
 * dispute lock. `privateKey` here is always whoever is actually calling
 * this (the admin operating /admin, signing with THEIR OWN on-device
 * wallet key via useAuthStore) — never a backend-held key. The contract
 * itself enforces msg.sender == admin, so this call simply reverts if the
 * signer isn't the deployed contract's configured admin address.
 */
export async function freezeTradeOnChain(privateKey: string, tradeId: string): Promise<Hash> {
  return sendContractTx(privateKey, 'freezeTrade', [tradeKeyFor(tradeId)])
}

export async function unfreezeTradeOnChain(privateKey: string, tradeId: string): Promise<Hash> {
  return sendContractTx(privateKey, 'unfreezeTrade', [tradeKeyFor(tradeId)])
}

/** Emergency stop — blocks deposit/release/withdrawRemaining contract-wide until unpaused. Admin-only on-chain; reverts otherwise. */
export async function pauseEscrow(privateKey: string): Promise<Hash> {
  return sendContractTx(privateKey, 'pause', [])
}

export async function unpauseEscrow(privateKey: string): Promise<Hash> {
  return sendContractTx(privateKey, 'unpause', [])
}

/**
 * Step 1 of the two-step admin handover — must be signed by the CURRENT
 * on-chain admin (`onlyAdmin` in P2PEscrow.sol). Nominates newAdmin but
 * does not grant them anything yet; they must separately call
 * acceptAdmin() themselves. See contracts/P2PEscrow.sol for why this is
 * two steps (protects against a typo'd/unreachable address bricking
 * admin-only functions forever).
 */
export async function transferAdmin(privateKey: string, newAdmin: `0x${string}`): Promise<Hash> {
  return sendContractTx(privateKey, 'transferAdmin', [newAdmin])
}

/**
 * Step 2 of the two-step admin handover — must be signed by the address
 * that was nominated via transferAdmin(). Completes the handover; after
 * this confirms, getEscrowAdminAddress() returns this wallet.
 */
export async function acceptAdmin(privateKey: string): Promise<Hash> {
  return sendContractTx(privateKey, 'acceptAdmin', [])
}

/**
 * P2PMeshportEscrow only — grants PAUSER role (pause/unpause,
 * freeze/unfreeze trades, NO fund-moving power) to `account`. Must be
 * signed by the current ADMIN. Calling this against the old single-admin
 * P2PEscrow contract will simply revert (no such function there).
 */
export async function addPauser(privateKey: string, account: `0x${string}`): Promise<Hash> {
  return sendContractTx(privateKey, 'addPauser', [account])
}

export async function removePauser(privateKey: string, account: `0x${string}`): Promise<Hash> {
  return sendContractTx(privateKey, 'removePauser', [account])
}

/**
 * P2PMeshportEscrow only — read-only check of whether `account` currently
 * has pause/freeze power (either because it IS admin, or was explicitly
 * granted via addPauser()). Used by the admin panel to decide whether to
 * show the full "wallet mismatch" warning or a lighter "you can pause but
 * not resolve disputes" note.
 */
export async function checkIsPauser(account: string): Promise<boolean> {
  if (!CONTRACT_ADDRESS || !account) return false
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'isPauser', args: [account as `0x${string}`] })
  try {
    const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
    if (!result.data) return false
    return BigInt(result.data) === 1n
  } catch {
    return false // old P2PEscrow contract has no isPauser() — fails closed, matches pre-upgrade behavior
  }
}

/** Read-only check of whether the contract is currently paused — no transaction, no gas, no signing. */
export async function isEscrowPaused(): Promise<boolean> {
  if (!CONTRACT_ADDRESS) return false
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'paused', args: [] })
  const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
  if (!result.data) return false
  return BigInt(result.data) === 1n
}

/** Read-only check of how much is still locked for an offer — no transaction, no gas, no signing. */
export async function getEscrowRemaining(offerId: string): Promise<number> {
  if (!CONTRACT_ADDRESS) return 0
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'getRemaining', args: [offerKeyFor(offerId)] })
  const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
  if (!result.data) return 0
  const raw = BigInt(result.data)
  return Number(raw) / (10 ** USDC_DECIMALS)
}

// ── Reconciler-grade probes ──────────────────────────────────────────────────
//
// Deliberately different contract from getEscrowRemaining/isEscrowPaused above:
// these return NULL when the answer cannot be established, instead of a
// convenient default. Code that decides what to do with somebody's money must
// never confuse "unknown" with "zero" — a probe that silently returns 0 on an
// RPC blip would make an unfunded escrow and an unreachable node look identical,
// and the reconciler would cancel a trade whose funds are actually intact.

/**
 * Did this trade's release actually happen on-chain? Reads the contract's own
 * `tradeReleased` mapping (P2PMeshportEscrow.sol:48) — the authoritative record,
 * set inside release() itself. Returns null if it cannot be determined.
 */
export async function probeTradeReleasedOnChain(tradeId: string): Promise<boolean | null> {
  if (!CONTRACT_ADDRESS) return null
  try {
    const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'tradeReleased', args: [tradeKeyFor(tradeId)] })
    const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
    if (!result.data) return null
    return BigInt(result.data) === 1n
  } catch {
    return null
  }
}

/**
 * How much is still escrowed under `escrowKeyId` — an OFFER id for sell-offer
 * trades, a TRADE id for buy-offer trades (those deposit into a trade-keyed
 * bucket; see depositForTrade). Returns null if it cannot be determined.
 */
export async function probeEscrowRemaining(escrowKeyId: string): Promise<number | null> {
  if (!CONTRACT_ADDRESS) return null
  try {
    const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'getRemaining', args: [offerKeyFor(escrowKeyId)] })
    const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
    if (!result.data) return null
    return Number(BigInt(result.data)) / (10 ** USDC_DECIMALS)
  } catch {
    return null
  }
}

/**
 * Read-only check of the contract's actual authorized admin wallet — no
 * transaction, no gas, no signing. release()/pause()/unpause() all require
 * `msg.sender == admin` on-chain (see contracts/P2PEscrow.sol), so whoever
 * is logged into the admin panel must be signing with THIS EXACT wallet or
 * every one of those actions will revert/fail regardless of anything else
 * being correct. Lets the admin panel surface that mismatch directly
 * instead of a confusing "couldn't access your wallet" dead end.
 */
export async function getEscrowAdminAddress(): Promise<string | null> {
  if (!CONTRACT_ADDRESS) return null
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'admin', args: [] })
  const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
  if (!result.data || result.data.length < 42) return null
  // address return data is left-padded to 32 bytes — take the last 20.
  return `0x${result.data.slice(-40)}`.toLowerCase()
}
