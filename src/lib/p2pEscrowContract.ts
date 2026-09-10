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
  createPublicClient, createWalletClient, encodeFunctionData, encodeAbiParameters, keccak256, toHex,
  parseGwei, custom, type Hash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTransport } from './arc'
import { ARC_CHAIN_INLINE } from './arcService'

const CONTRACT_ADDRESS = (import.meta.env.VITE_P2P_ESCROW_CONTRACT as string || '').trim() as `0x${string}` | ''

/**
 * Exported for the client-side "is this transfer FROM one of our own
 * contracts" allowlists (onchainReceivedActivity.ts, HomePage.tsx,
 * MultichainClaimPage.tsx) — a seller withdrawing their own escrow (after
 * a release, refund, or offer cancellation) sends USDC from THIS address
 * back to their own wallet, and without it in those allowlists that
 * legitimate internal movement gets misclassified as a generic external
 * "USDC received" deposit/notification instead of being recognized (or
 * suppressed) as what it actually is. Reading it from the same env var
 * this file itself uses means it can never drift out of sync with the
 * actual configured contract on a future redeploy, the way a second
 * hardcoded copy of the literal address would.
 */
export const P2P_ESCROW_CONTRACT_ADDRESS = CONTRACT_ADDRESS ? CONTRACT_ADDRESS.toLowerCase() : ''


// ── Injected-wallet signing (role manager actions) ────────────────────────
// SECURITY FIX: role manager actions used to ask an operator to paste their
// private key directly into the browser. Every OTHER signing path in this
// app already avoids that by holding a key only briefly in memory for a
// user's OWN already-imported MeshPort wallet — but role manager signers
// are a genuinely separate authority, often not MeshPort accounts at all,
// so there was no existing in-app key to reuse. The fix isn't a workaround
// inside this app; it's not asking for the key at all. This uses the
// browser's injected wallet (MetaMask or any EIP-1193 provider) instead —
// the signer approves the transaction inside their OWN wallet extension,
// which builds and signs it internally. The private key never enters this
// page's JavaScript, is never held in React state, and is never
// transmitted anywhere by this app — there is nothing here TO leak to
// localStorage/sessionStorage/Supabase/an API request/a log line, because
// this code never possesses the key in the first place.
export function hasInjectedWallet(): boolean {
  return typeof window !== 'undefined' && !!(window as any).ethereum
}

/** Prompts the browser's injected wallet (MetaMask etc.) to connect and returns the connected address, or null if unavailable/rejected. */
export async function connectInjectedWallet(): Promise<string | null> {
  if (!hasInjectedWallet()) return null
  try {
    const accounts: string[] = await (window as any).ethereum.request({ method: 'eth_requestAccounts' })
    return accounts?.[0]?.toLowerCase() ?? null
  } catch {
    return null
  }
}

/** Reads the currently-connected injected-wallet address without prompting (returns null if not already connected). */
export async function getConnectedInjectedWalletAddress(): Promise<string | null> {
  if (!hasInjectedWallet()) return null
  try {
    const accounts: string[] = await (window as any).ethereum.request({ method: 'eth_accounts' })
    return accounts?.[0]?.toLowerCase() ?? null
  } catch {
    return null
  }
}

/**
 * "Disconnects" the browser wallet from this app's point of view. Most
 * injected wallets (MetaMask et al.) don't let a website silently drop a
 * connection the user granted — that permission lives in the extension
 * itself, not on this page, and the only way to fully revoke it is from
 * inside the wallet's own UI. Where a wallet DOES support the newer
 * EIP-2255 `wallet_revokePermissions` call, this tries it as a best-effort
 * so the extension's own permission list clears too. Either way this
 * function always resolves normally (never throws) — the part of
 * "disconnect" this app can actually guarantee is the caller forgetting
 * the connected address from its own React state, which it should do
 * regardless of whether the extension itself also revoked anything.
 */
export async function disconnectInjectedWallet(): Promise<void> {
  if (!hasInjectedWallet()) return
  try {
    const ethereum = (window as any).ethereum
    if (typeof ethereum?.request === 'function') {
      await ethereum.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })
    }
  } catch {
    // Not every wallet supports wallet_revokePermissions (e.g. older
    // MetaMask versions) — that's fine, the caller clears its own state
    // regardless, which is what actually drives this app's UI.
  }
}

/**
 * Sends a contract call through the browser's injected wallet — the
 * signer reviews and approves inside their own extension; this function
 * only ever sees the resulting transaction hash, never a key. Also makes
 * sure the wallet is on Arc before sending, prompting a network switch/add
 * if it isn't (mirrors the pattern already used for the in-app wallet's
 * own network handling elsewhere in this file).
 */
async function sendContractTxViaInjectedWallet(functionName: string, args: readonly unknown[], value: bigint = 0n): Promise<Hash> {
  if (!CONTRACT_ADDRESS) throw new Error('P2P escrow contract is not configured (VITE_P2P_ESCROW_CONTRACT unset)')
  if (!hasInjectedWallet()) throw new Error('No browser wallet extension detected (e.g. MetaMask). Install one to sign as a role manager.')

  const ethereum = (window as any).ethereum
  const accounts: string[] = await ethereum.request({ method: 'eth_requestAccounts' })
  const account = accounts?.[0]
  if (!account) throw new Error('No wallet account connected.')

  const walletClient = createWalletClient({ transport: custom(ethereum) })
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 30000 }) })

  // Make sure the connected wallet is actually on Arc before sending —
  // otherwise the signature would be for the wrong chain entirely.
  const currentChainIdHex: string = await ethereum.request({ method: 'eth_chainId' })
  if (parseInt(currentChainIdHex, 16) !== ARC_CHAIN_INLINE.id) {
    try {
      await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${ARC_CHAIN_INLINE.id.toString(16)}` }] })
    } catch (switchErr: any) {
      if (switchErr?.code === 4902) {
        await ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: `0x${ARC_CHAIN_INLINE.id.toString(16)}`,
            chainName: ARC_CHAIN_INLINE.name,
            nativeCurrency: ARC_CHAIN_INLINE.nativeCurrency,
            rpcUrls: ARC_CHAIN_INLINE.rpcUrls.default.http,
          }],
        })
      } else {
        throw new Error('Please switch your wallet to the Arc network to sign this transaction.')
      }
    }
  }

  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: functionName as any, args: args as any })
  const gasEstimate = await publicClient.estimateGas({ account: account as `0x${string}`, to: CONTRACT_ADDRESS, data, value }).catch(() => undefined)

  const hash = await walletClient.sendTransaction({
    account: account as `0x${string}`,
    to: CONTRACT_ADDRESS,
    data,
    value,
    gas: gasEstimate ? (gasEstimate * 120n) / 100n : undefined,
    chain: ARC_CHAIN_INLINE,
  } as any)

  // CRITICAL FIX — same issue and same fix as sendContractTxOnce's own
  // comment above: a returned hash only means the wallet extension
  // broadcast the transaction, not that it was mined or that it
  // succeeded. This function backs every role-manager and dispute-flow
  // action (propose/confirm/execute role changes, freeze, investigate,
  // adminResolve) — without this wait, e.g. a Role Manager's confirm
  // could appear to succeed in the UI while the actual on-chain
  // confirmation silently reverted, leaving the proposal exactly where
  // it started with no indication anything went wrong.
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30000 })
  if (receipt.status !== 'success') {
    throw new Error(`${functionName}: transaction ${hash} was mined but reverted on-chain (status: ${receipt.status})`)
  }
  return hash
}

export function isEscrowContractDeployed(): boolean {
  return !!CONTRACT_ADDRESS
}

// Minimal ABI — only the functions/events this app actually calls or reads.
// V2 (P2PMeshportEscrowV2.sol) functions included alongside the legacy ones
// so this file can talk to either a legacy or a V2 deployment depending on
// VITE_P2P_ESCROW_CONTRACT — encodeFunctionData only touches whichever
// entry is referenced by name, so having both in one ABI is harmless.
const ESCROW_ABI = [
  {
    type: 'function', name: 'deposit', stateMutability: 'payable',
    inputs: [{ name: 'offerKey', type: 'bytes32' }], outputs: [],
  },
  {
    // release(tradeKey) — buyer/amount come from the trade registered
    // on-chain via registerTrade below, never from caller-supplied
    // arguments. See P2PMeshportEscrowV2.sol's own header for why.
    type: 'function', name: 'release', stateMutability: 'nonpayable',
    inputs: [{ name: 'tradeKey', type: 'bytes32' }], outputs: [],
  },
  {
    type: 'function', name: 'registerTrade', stateMutability: 'nonpayable',
    inputs: [
      { name: 'tradeKey', type: 'bytes32' }, { name: 'offerKey', type: 'bytes32' },
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
    // SECURITY-REVIEW FINDING (fixed): these two view functions exist on
    // the contract but had NO ABI entry at all here — genuinely
    // unreachable from the client despite compiling/typechecking fine
    // (TypeScript has no way to know an ABI array is incomplete against
    // the real deployed contract). getAvailable() specifically is the
    // number that matters for "how much can this seller actually
    // withdraw" post the reserved-accounting fix — getRemaining() alone
    // answers that incorrectly once any trade is registered.
    type: 'function', name: 'getReserved', stateMutability: 'view',
    inputs: [{ name: 'offerKey', type: 'bytes32' }], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'getAvailable', stateMutability: 'view',
    inputs: [{ name: 'offerKey', type: 'bytes32' }], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'getSeller', stateMutability: 'view',
    inputs: [{ name: 'offerKey', type: 'bytes32' }], outputs: [{ type: 'address' }],
  },
  // The legacy `tradeReleased(bytes32)` ABI entry that used to live here
  // was removed — nothing calls it anymore (probeTradeReleasedOnChain now
  // uses getTrade()'s state field instead, see its own comment on why),
  // and leaving an unused legacy selector sitting in the ABI array is
  // exactly the kind of stale entry that caused it to get called against
  // a V2 contract that doesn't have that function at all.
  {
    // V2 getter — full stored trade record. See getTrade() below.
    type: 'function', name: 'getTrade', stateMutability: 'view',
    inputs: [{ name: 'tradeKey', type: 'bytes32' }],
    outputs: [
      { name: 'offerKey', type: 'bytes32' }, { name: 'seller', type: 'address' },
      { name: 'buyer', type: 'address' }, { name: 'amount', type: 'uint256' },
      { name: 'state', type: 'uint8' }, { name: 'investigatedApproveRelease', type: 'bool' },
      { name: 'frozenBy', type: 'address' }, { name: 'investigatedBy', type: 'address' }, { name: 'resolvedBy', type: 'address' },
    ],
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
    type: 'function', name: 'freezeOffer', stateMutability: 'nonpayable',
    inputs: [{ name: 'offerKey', type: 'bytes32' }], outputs: [],
  },
  {
    type: 'function', name: 'unfreezeOffer', stateMutability: 'nonpayable',
    inputs: [{ name: 'offerKey', type: 'bytes32' }], outputs: [],
  },
  {
    type: 'function', name: 'investigate', stateMutability: 'nonpayable',
    inputs: [{ name: 'tradeKey', type: 'bytes32' }, { name: 'approveRelease', type: 'bool' }], outputs: [],
  },
  {
    type: 'function', name: 'adminResolve', stateMutability: 'nonpayable',
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
    type: 'function', name: 'acceptAdmin', stateMutability: 'nonpayable',
    inputs: [], outputs: [],
  },
  // ── Role manager multisig (2-of-3) — replaces the old onlyAdmin-gated
  // addPauser/removePauser/addInvestigator/removeInvestigator/
  // transferAdmin/cancelAdminTransfer, none of which exist as direct
  // external functions anymore. See P2PMeshportEscrowV2.sol's own comment
  // on why: admin alone used to be able to unilaterally reshape every role
  // over time, which no amount of per-dispute independence checking could
  // fix on its own.
  {
    type: 'function', name: 'proposeRoleChange', stateMutability: 'nonpayable',
    inputs: [{ name: 'action', type: 'uint8' }, { name: 'target', type: 'address' }],
    outputs: [{ name: 'proposalId', type: 'uint256' }],
  },
  {
    type: 'function', name: 'proposeSignerRotation', stateMutability: 'nonpayable',
    inputs: [{ name: 'signerIndex', type: 'uint256' }, { name: 'newSigner', type: 'address' }],
    outputs: [{ name: 'proposalId', type: 'uint256' }],
  },
  {
    type: 'function', name: 'confirmRoleChange', stateMutability: 'nonpayable',
    inputs: [{ name: 'proposalId', type: 'uint256' }], outputs: [],
  },
  {
    // SECURITY ADDITION: 2-hour timelock. confirmRoleChange (above) no
    // longer executes a role change the instant 2-of-3 is reached — it
    // only starts a 2-hour clock (see the contract's own TIMELOCK_DELAY
    // comment). This is the separate step that actually applies the
    // change, and can only succeed once that clock has elapsed.
    type: 'function', name: 'executeRoleProposal', stateMutability: 'nonpayable',
    inputs: [{ name: 'proposalId', type: 'uint256' }], outputs: [],
  },
  {
    type: 'function', name: 'cancelRoleProposal', stateMutability: 'nonpayable',
    inputs: [{ name: 'proposalId', type: 'uint256' }], outputs: [],
  },
  {
    type: 'function', name: 'getRoleProposal', stateMutability: 'view',
    inputs: [{ name: 'proposalId', type: 'uint256' }],
    outputs: [
      { name: 'action', type: 'uint8' }, { name: 'target', type: 'address' }, { name: 'signerIndex', type: 'uint256' },
      { name: 'confirmations', type: 'uint256' }, { name: 'executed', type: 'bool' }, { name: 'cancelled', type: 'bool' },
      { name: 'executableAfter', type: 'uint256' },
    ],
  },
  {
    // True only once 2-of-3 is reached AND the 2-hour timelock has
    // elapsed AND it hasn't already been executed/cancelled — exactly
    // when executeRoleProposal() would succeed. The UI's countdown is
    // display-only; this view call (or getRoleProposal's own
    // executableAfter field) is the actual source of truth.
    type: 'function', name: 'isRoleProposalExecutable', stateMutability: 'view',
    inputs: [{ name: 'proposalId', type: 'uint256' }], outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'TIMELOCK_DELAY', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'roleProposalCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'isRoleManagerSigner', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'roleManagerSigners', stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }], outputs: [{ type: 'address' }],
  },
  {
    type: 'function', name: 'isPauser', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'isInvestigator', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'admin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }],
  },
  {
    type: 'function', name: 'pendingAdmin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }],
  },
  // ── Events (for the on-chain-derived security notification feed) ────────
  // These are the source of truth for "did a role/governance change really
  // happen" — see getRecentGovernanceEvents() below and its own comment on
  // why a database row is never trusted as proof of a role change.
  {
    type: 'event', name: 'PauserAdded', inputs: [
      { name: 'account', type: 'address', indexed: true }, { name: 'by', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event', name: 'PauserRemoved', inputs: [
      { name: 'account', type: 'address', indexed: true }, { name: 'by', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event', name: 'InvestigatorAdded', inputs: [
      { name: 'account', type: 'address', indexed: true }, { name: 'by', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event', name: 'InvestigatorRemoved', inputs: [
      { name: 'account', type: 'address', indexed: true }, { name: 'by', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event', name: 'AdminTransferInitiated', inputs: [
      { name: 'currentAdmin', type: 'address', indexed: true }, { name: 'pendingAdmin_', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event', name: 'AdminTransferred', inputs: [
      { name: 'previousAdmin', type: 'address', indexed: true }, { name: 'newAdmin', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event', name: 'SignerRotated', inputs: [
      { name: 'signerIndex', type: 'uint256', indexed: true }, { name: 'oldSigner', type: 'address', indexed: true }, { name: 'newSigner', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event', name: 'RoleProposalCreated', inputs: [
      { name: 'proposalId', type: 'uint256', indexed: true }, { name: 'action', type: 'uint8', indexed: false },
      { name: 'target', type: 'address', indexed: false }, { name: 'proposer', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event', name: 'RoleProposalConfirmed', inputs: [
      { name: 'proposalId', type: 'uint256', indexed: true }, { name: 'signer', type: 'address', indexed: true }, { name: 'confirmations', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'RoleProposalApproved', inputs: [
      { name: 'proposalId', type: 'uint256', indexed: true }, { name: 'executableAfter', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'RoleProposalCancelled', inputs: [
      { name: 'proposalId', type: 'uint256', indexed: true }, { name: 'by', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event', name: 'RoleProposalExecuted', inputs: [
      { name: 'proposalId', type: 'uint256', indexed: true },
    ],
  },
] as const

/**
 * Deterministic on-chain key for an offer.
 *
 * BUG FIX (front-run hijack): this used to be just keccak256(offerId),
 * with no seller binding — an attacker watching the mempool for a pending
 * deposit could front-run it and claim the offer's seller slot for
 * themselves (see P2PMeshportEscrowV2.sol's own header for the full
 * writeup). Now includes the intended seller's address in the hash input,
 * so nobody but that specific address can ever construct a matching key —
 * doing otherwise would require a hash second-preimage, not just being
 * fast in the mempool.
 */
export function offerKeyFor(offerId: string, sellerAddress: string): `0x${string}` {
  return keccak256(encodeAbiParameters(
    [{ type: 'string' }, { type: 'address' }],
    [offerId, sellerAddress.toLowerCase() as `0x${string}`],
  ))
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
  // DEFENSE IN DEPTH: a genuine on-chain revert is never transient, no
  // matter what transport-level wording happens to also be present in the
  // thrown error's message/cause chain (e.g. viem sometimes nests a 502
  // from an earlier failed-over attempt alongside the final revert message
  // it actually got). See api/arc-rpc.js's isDeterministicRevertError for
  // the server-side half of this fix — with that in place this check
  // should rarely matter, but checking it first here means a revert reason
  // can never be misread as "worth retrying" even if the server-side
  // proxy is old/uncached or some other wrapper reintroduces the mix-up.
  if (msg.includes('execution reverted') || msg.includes('always failing transaction')) return false
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
  const hash = await walletClient.sendTransaction({
    to: CONTRACT_ADDRESS,
    data,
    value,
    gas: (gasEstimate * 130n) / 100n, // contract calls need more margin than a plain value transfer
    maxFeePerGas: parseGwei('25'),
    maxPriorityFeePerGas: parseGwei('1'),
    chain: ARC_CHAIN_INLINE,
    nonce,
  } as unknown as Parameters<typeof walletClient.sendTransaction>[0])

  // CRITICAL FIX: sendTransaction() only confirms the RPC node ACCEPTED the
  // transaction for broadcast — it says nothing about whether the
  // transaction actually got mined, or whether it succeeded or reverted
  // once it did. Every caller of sendContractTx (registerTrade, release,
  // deposit, withdrawRemaining, freeze/unfreeze, investigate, adminResolve,
  // every role-management action) was treating "got a hash back" as "this
  // definitely happened" — but a transaction can be accepted into the
  // mempool and then genuinely revert on execution (or never get mined at
  // all) with the caller none the wiser, since sendTransaction's promise
  // had already resolved before either of those things could happen.
  // Confirmed as the actual root cause of trades that appeared to register
  // successfully (a hash came back, the trade was created) but the
  // contract's own getTrade() later showed they were never actually
  // Active — the on-chain call had silently reverted or never confirmed,
  // and nothing downstream ever found out. Arc finalizes deterministically
  // in ~780ms (see Circle's own docs), so waiting here for a real receipt
  // costs almost nothing in the success case, and turns every silent
  // failure into the caller's existing rollback path (delete trade, unlock
  // offer, refund) instead of a phantom "success" with no matching
  // on-chain state.
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30000 })
  if (receipt.status !== 'success') {
    throw new Error(`${functionName}: transaction ${hash} was mined but reverted on-chain (status: ${receipt.status})`)
  }
  return hash
}

/** Seller deposits USDC for their offer. Real on-chain transaction — the deposit IS the value sent with this call. */
export async function depositToEscrow(privateKey: string, offerId: string, amountUsdc: number): Promise<Hash> {
  const sellerAddress = privateKeyToAccount(privateKey as `0x${string}`).address
  return sendContractTx(privateKey, 'deposit', [offerKeyFor(offerId, sellerAddress)], toNativeUnits(amountUsdc))
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
 * Registers a BUY-offer trade's buyer/amount on-chain, authoritatively —
 * the same purpose as registerTradeOnChain above, but for the trade-keyed
 * escrow bucket buy-offer trades use (see depositForTrade). The escrow
 * bucket's "offerKey" here IS the trade's own key (that's what
 * depositForTrade deposited against), and `buyer` is the ORIGINAL buy
 * offer's creator — the person who wants to receive USDC — not whoever
 * accepted the offer and is depositing/releasing.
 */
export async function registerTradeKeyedTradeOnChain(privateKey: string, tradeId: string, buyOfferCreatorAddress: string, amountUsdc: number): Promise<Hash> {
  const key = tradeKeyFor(tradeId)
  return sendContractTx(privateKey, 'registerTrade', [key, key, buyOfferCreatorAddress as `0x${string}`, toNativeUnits(amountUsdc)])
}

/**
 * Releases a buy-offer trade's escrowed funds (deposited under the trade's
 * own key via depositForTrade above) to the buyer. Trade must already be
 * registered (see registerTradeKeyedTradeOnChain).
 */
export async function releaseTradeKeyedEscrow(privateKey: string, tradeId: string): Promise<Hash> {
  return sendContractTx(privateKey, 'release', [tradeKeyFor(tradeId)])
}

/** Refunds a buy-offer trade's escrowed deposit back to the seller who deposited it (e.g. the trade was cancelled or expired). */
export async function refundTradeKeyedEscrow(privateKey: string, tradeId: string): Promise<Hash> {
  return sendContractTx(privateKey, 'withdrawRemaining', [tradeKeyFor(tradeId)])
}

/**
 * Registers a trade's buyer/amount on-chain, authoritatively, BEFORE it can
 * be released — this is what makes release() safe to trust with just a
 * tradeKey (see P2PMeshportEscrowV2.sol's own header on why the old
 * contract's caller-supplied buyer/amount was a real vulnerability). Called
 * once by the SELLER when a sell-offer trade is created (createTrade() in
 * p2pService.ts) — the seller is the only one who can call this for their
 * own offer, matching who's authorized to eventually release it.
 */
export async function registerTradeOnChain(privateKey: string, offerId: string, tradeId: string, buyerAddress: string, amountUsdc: number): Promise<Hash> {
  const sellerAddress = privateKeyToAccount(privateKey as `0x${string}`).address
  return sendContractTx(privateKey, 'registerTrade', [
    tradeKeyFor(tradeId), offerKeyFor(offerId, sellerAddress), buyerAddress as `0x${string}`, toNativeUnits(amountUsdc),
  ])
}

/** Normal-path release for a sell-offer trade — seller-only on-chain, no privileged approval. Trade must already be registered (see registerTradeOnChain). */
export async function releaseFromEscrow(privateKey: string, tradeId: string): Promise<Hash> {
  return sendContractTx(privateKey, 'release', [tradeKeyFor(tradeId)])
}

/** Seller reclaims whatever's left in escrow for an offer (used when the offer itself is cancelled/paused). */
export async function withdrawRemainingFromEscrow(privateKey: string, offerId: string): Promise<Hash> {
  const sellerAddress = privateKeyToAccount(privateKey as `0x${string}`).address
  return sendContractTx(privateKey, 'withdrawRemaining', [offerKeyFor(offerId, sellerAddress)])
}

/**
 * On-chain trade freeze/unfreeze — the contract-level backstop for a
 * dispute lock. `privateKey` here is whoever is calling this, signing with
 * THEIR OWN on-device wallet key via useAuthStore.
 *
 * CORRECTED: freezeTrade/unfreezeTrade are gated by onlyPauser on
 * P2PMeshportEscrowV2, NOT onlyAdmin — this call reverts unless the
 * signer's wallet actually holds the Pauser role (granted via the 2-of-3
 * role manager + timelock flow), not merely "is the dashboard admin".
 * Prefer freezeTradeOnChainViaWallet below for the admin panel — it signs
 * through the browser's injected wallet instead of the logged-in
 * MeshPort session's key, since the person acting as Pauser is not
 * necessarily the same person logged into the dashboard.
 */
export async function freezeTradeOnChain(privateKey: string, tradeId: string): Promise<Hash> {
  return sendContractTx(privateKey, 'freezeTrade', [tradeKeyFor(tradeId)])
}

export async function unfreezeTradeOnChain(privateKey: string, tradeId: string): Promise<Hash> {
  return sendContractTx(privateKey, 'unfreezeTrade', [tradeKeyFor(tradeId)])
}

/**
 * Wallet-signed dispute-flow actions (PREFERRED for the admin panel) —
 * mirrors the pattern already used for role-manager actions:
 * freeze/investigate/resolve each require a DIFFERENT wallet holding the
 * matching role (Pauser/Investigator/Admin), enforced on-chain with
 * per-dispute independence (see P2PMeshportEscrowV2.sol's own comments on
 * frozenBy/investigatedBy). A single dashboard session's logged-in key
 * cannot correctly perform all three steps for one trade — nor should it;
 * that would defeat the entire point of separating these roles. Each
 * function here prompts the CONNECTED injected wallet (MetaMask etc.) to
 * sign — never a private key entered into this app.
 */
export async function freezeTradeOnChainViaWallet(tradeId: string): Promise<Hash> {
  return sendContractTxViaInjectedWallet('freezeTrade', [tradeKeyFor(tradeId)])
}
export async function unfreezeTradeOnChainViaWallet(tradeId: string): Promise<Hash> {
  return sendContractTxViaInjectedWallet('unfreezeTrade', [tradeKeyFor(tradeId)])
}
export async function investigateTradeOnChainViaWallet(tradeId: string, approveRelease: boolean): Promise<Hash> {
  return sendContractTxViaInjectedWallet('investigate', [tradeKeyFor(tradeId), approveRelease])
}
export async function adminResolveTradeOnChainViaWallet(tradeId: string): Promise<Hash> {
  return sendContractTxViaInjectedWallet('adminResolve', [tradeKeyFor(tradeId)])
}

/** Emergency stop — blocks deposit/release/withdrawRemaining contract-wide until unpaused. Admin-only on-chain; reverts otherwise. */
export async function pauseEscrow(privateKey: string): Promise<Hash> {
  return sendContractTx(privateKey, 'pause', [])
}

export async function unpauseEscrow(privateKey: string): Promise<Hash> {
  return sendContractTx(privateKey, 'unpause', [])
}

// ── Role manager multisig (2-of-3) ────────────────────────────────────────
// Every Pauser/Investigator/Admin role change goes through this — see
// P2PMeshportEscrowV2.sol's own comment on why admin alone no longer has
// any direct role-granting power. `privateKey` here is always ONE role
// manager signer's own key, used transiently to sign exactly one
// propose/confirm transaction — never persisted, never sent anywhere but
// this one signed transaction. See the Role Managers admin panel section,
// which walks an operator through entering each signer's key in turn.

export type RoleAction = 'AddPauser' | 'RemovePauser' | 'AddInvestigator' | 'RemoveInvestigator' | 'TransferAdmin' | 'CancelAdminTransfer' | 'RotateSigner'
const ROLE_ACTION_INDEX: Record<RoleAction, number> = {
  AddPauser: 0, RemovePauser: 1, AddInvestigator: 2, RemoveInvestigator: 3, TransferAdmin: 4, CancelAdminTransfer: 5, RotateSigner: 6,
}

/** Step 1: the FIRST role manager signer proposes a change — this counts as their own confirmation (1 of 2 required). Returns the new proposal's id (read back via getRoleProposalCount, since the return value isn't directly recoverable from a plain sendTransaction — callers should read roleProposalCount() before and after). */
export async function proposeRoleChange(privateKey: string, action: RoleAction, target: `0x${string}`): Promise<Hash> {
  return sendContractTx(privateKey, 'proposeRoleChange', [ROLE_ACTION_INDEX[action], target])
}

/** Step 2: a DIFFERENT role manager signer confirms. Executes automatically the instant confirmations reach the 2-of-3 threshold — there is no separate "execute" call. */
export async function confirmRoleChange(privateKey: string, proposalId: bigint): Promise<Hash> {
  return sendContractTx(privateKey, 'confirmRoleChange', [proposalId])
}

/** Any role manager signer who hasn't yet confirmed can cancel a still-pending proposal (e.g. a typo'd target address). */
export async function cancelRoleProposal(privateKey: string, proposalId: bigint): Promise<Hash> {
  return sendContractTx(privateKey, 'cancelRoleProposal', [proposalId])
}

/**
 * Wallet-based equivalents — PREFERRED, and what the production
 * RoleManagersPanel UI actually uses. Signs through the browser's
 * injected wallet extension instead of a pasted private key; see
 * sendContractTxViaInjectedWallet's own comment for the full security
 * reasoning. The privateKey-based versions above remain only for
 * local/test tooling (e.g. the deploy script's optional bootstrap step),
 * never for the production admin panel.
 */
export async function proposeRoleChangeViaWallet(action: RoleAction, target: `0x${string}`): Promise<Hash> {
  return sendContractTxViaInjectedWallet('proposeRoleChange', [ROLE_ACTION_INDEX[action], target])
}
export async function confirmRoleChangeViaWallet(proposalId: bigint): Promise<Hash> {
  return sendContractTxViaInjectedWallet('confirmRoleChange', [proposalId])
}
export async function cancelRoleProposalViaWallet(proposalId: bigint): Promise<Hash> {
  return sendContractTxViaInjectedWallet('cancelRoleProposal', [proposalId])
}
export async function proposeSignerRotationViaWallet(signerIndex: number, newSigner: `0x${string}`): Promise<Hash> {
  return sendContractTxViaInjectedWallet('proposeSignerRotation', [BigInt(signerIndex), newSigner])
}

/**
 * Admin-compromise recovery — semantically-named convenience wrappers over
 * the SAME generic role-manager multisig used for every other role change
 * (AddPauser, RotateSigner, etc.). There is no separate governance system
 * here: TransferAdmin/CancelAdminTransfer are just two more RoleAction
 * values, gated by the identical onlyRoleManagerSigner + 2-of-3 mechanism.
 * The current Admin has NO gating on any of proposeRoleChange/
 * confirmRoleChange/cancelRoleProposal — see P2PMeshportEscrowV2.sol's own
 * comments on this — so a compromised Admin cannot block, veto, or delay
 * any of these calls.
 *
 * Named separately purely for UI/call-site clarity (a "replace Admin"
 * button reading `proposeAdminRotationViaWallet` is clearer than
 * `proposeRoleChangeViaWallet('TransferAdmin', ...)` at the call site) —
 * these are thin wrappers, not new on-chain behavior.
 */
export async function proposeAdminRotationViaWallet(newAdmin: `0x${string}`): Promise<Hash> {
  return proposeRoleChangeViaWallet('TransferAdmin', newAdmin)
}
export async function confirmAdminRotationViaWallet(proposalId: bigint): Promise<Hash> {
  return confirmRoleChangeViaWallet(proposalId)
}
/** Cancels a still-PENDING (not yet 2-of-3-confirmed) admin rotation proposal — before it ever executed. Any role manager signer who hasn't yet confirmed can call this. */
export async function cancelAdminRotationProposalViaWallet(proposalId: bigint): Promise<Hash> {
  return cancelRoleProposalViaWallet(proposalId)
}
/** Reverses an ALREADY-EXECUTED TransferAdmin's pending nomination (clears pendingAdmin back to none) — e.g. the nominated address was wrong, or the emergency has resolved and the rotation should not proceed after all. This itself requires a fresh 2-of-3 CancelAdminTransfer proposal — the current (possibly still-compromised) Admin has no say in it either. */
export async function proposeCancelPendingAdminViaWallet(): Promise<Hash> {
  return proposeRoleChangeViaWallet('CancelAdminTransfer', '0x0000000000000000000000000000000000000000')
}

/** Read-only — the address currently nominated as pending admin (address(0) if none). No transaction, no gas, no signing. */
export async function getPendingAdmin(): Promise<string | null> {
  if (!CONTRACT_ADDRESS) return null
  try {
    const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'pendingAdmin', args: [] })
    const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
    if (!result.data || result.data.length < 42) return null
    return `0x${result.data.slice(-40)}`.toLowerCase()
  } catch {
    return null
  }
}

/** Step 2 of the two-step handover — the nominated address itself must call this to actually become admin (re-verifies they're still an investigator at this exact moment). Wallet-signed. */
export async function acceptAdminViaWallet(): Promise<Hash> {
  return sendContractTxViaInjectedWallet('acceptAdmin', [])
}

export interface OnChainRoleProposal {
  action: RoleAction; target: string; signerIndex: number; confirmations: number; executed: boolean; cancelled: boolean
  /** 0 until 2-of-3 confirmations are reached; then a fixed unix timestamp (seconds) after which executeRoleProposal() can succeed. Never changes once set for a given proposal. */
  executableAfter: number
}
const ROLE_ACTION_NAMES: RoleAction[] = ['AddPauser', 'RemovePauser', 'AddInvestigator', 'RemoveInvestigator', 'TransferAdmin', 'CancelAdminTransfer', 'RotateSigner']

/**
 * Read-only lookup of a role proposal's current state — no transaction, no
 * gas, no signing. Used by the Role Managers panel to show "1 of 2
 * confirmed" / "Pending Role Change, execution available in 1h 42m" etc.
 *
 * SECURITY ADDITION: now includes `executableAfter` (the 2-hour timelock
 * deadline) — re-verified byte-for-byte against the contract's actual
 * 7-word tuple after the timelock feature changed getRoleProposal()'s
 * return shape.
 */
export async function getRoleProposalOnChain(proposalId: bigint): Promise<OnChainRoleProposal | null> {
  if (!CONTRACT_ADDRESS) return null
  try {
    const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'getRoleProposal', args: [proposalId] })
    const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
    if (!result.data) return null
    const hex = result.data.slice(2)
    const word = (i: number) => hex.slice(i * 64, i * 64 + 64)
    return {
      action: ROLE_ACTION_NAMES[Number(BigInt(`0x${word(0)}`))] ?? 'AddPauser',
      target: `0x${word(1).slice(-40)}`.toLowerCase(),
      signerIndex: Number(BigInt(`0x${word(2)}`)),
      confirmations: Number(BigInt(`0x${word(3)}`)),
      executed: BigInt(`0x${word(4)}`) === 1n,
      cancelled: BigInt(`0x${word(5)}`) === 1n,
      executableAfter: Number(BigInt(`0x${word(6)}`)),
    }
  } catch {
    return null
  }
}

/** Wallet-signed — executes a role proposal that has already reached 2-of-3 approval AND whose 2-hour timelock has elapsed. Reverts on-chain (not just in the UI) if either condition isn't met — the countdown shown anywhere in the UI is display-only. */
export async function executeRoleProposalViaWallet(proposalId: bigint): Promise<Hash> {
  return sendContractTxViaInjectedWallet('executeRoleProposal', [proposalId])
}

/** Read-only — true only when a proposal has reached 2-of-3 AND its 2-hour timelock has elapsed AND it hasn't already been executed/cancelled. The contract's own source of truth for "the Execute button should be enabled now." */
export async function checkRoleProposalExecutable(proposalId: bigint): Promise<boolean> {
  if (!CONTRACT_ADDRESS) return false
  try {
    const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'isRoleProposalExecutable', args: [proposalId] })
    const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
    if (!result.data) return false
    return BigInt(result.data) === 1n
  } catch {
    return false
  }
}

/** Read-only — the timelock delay in seconds (2 hours = 7200), read directly from the contract rather than hardcoded client-side, so the UI never silently drifts from whatever the deployed contract actually enforces. */
export async function getTimelockDelaySeconds(): Promise<number> {
  if (!CONTRACT_ADDRESS) return 7200
  try {
    const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'TIMELOCK_DELAY', args: [] })
    const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
    if (!result.data) return 7200
    return Number(BigInt(result.data))
  } catch {
    return 7200
  }
}

/** Read-only — total number of role proposals ever created. The most recent one's id is this value minus 1. */
export async function getRoleProposalCount(): Promise<number> {
  if (!CONTRACT_ADDRESS) return 0
  try {
    const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'roleProposalCount', args: [] })
    const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
    if (!result.data) return 0
    return Number(BigInt(result.data))
  } catch {
    return 0
  }
}

/** Read-only — is this address one of the 3 fixed role manager signers? No transaction, no gas, no signing. */
export async function checkIsRoleManagerSigner(account: string): Promise<boolean> {
  if (!CONTRACT_ADDRESS || !account) return false
  try {
    const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'isRoleManagerSigner', args: [account as `0x${string}`] })
    const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
    if (!result.data) return false
    return BigInt(result.data) === 1n
  } catch {
    return false
  }
}

/** Read-only — the 3 fixed role manager signer addresses set at deployment, for display in the Role Managers admin panel. */
export async function getRoleManagerSigners(): Promise<string[]> {
  if (!CONTRACT_ADDRESS) return []
  try {
    const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
    const out: string[] = []
    for (let i = 0; i < 3; i++) {
      const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'roleManagerSigners', args: [BigInt(i)] })
      const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
      if (result.data && result.data.length >= 42) out.push(`0x${result.data.slice(-40)}`.toLowerCase())
    }
    return out
  } catch {
    return []
  }
}

/**
 * Step 2 of the two-step admin handover — must be signed by the address
 * that was nominated via a TransferAdmin role proposal. Completes the
 * handover; after this confirms, getEscrowAdminAddress() returns this
 * wallet. This one step is unchanged from before — only WHO can nominate
 * (the role manager multisig, not admin unilaterally) changed.
 */
export async function acceptAdmin(privateKey: string): Promise<Hash> {
  return sendContractTx(privateKey, 'acceptAdmin', [])
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

/** Read-only check of how much is still locked for a SELL offer — no transaction, no gas, no signing. */
export async function getEscrowRemaining(offerId: string, sellerAddress: string): Promise<number> {
  if (!CONTRACT_ADDRESS) return 0
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'getRemaining', args: [offerKeyFor(offerId, sellerAddress)] })
  const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
  if (!result.data) return 0
  const raw = BigInt(result.data)
  return Number(raw) / (10 ** USDC_DECIMALS)
}

/** Read-only — how much of a SELL offer's balance is currently committed to Active/Frozen/Investigated trades (never withdrawable, never available for a new trade). No transaction, no gas, no signing. */
export async function getEscrowReserved(offerId: string, sellerAddress: string): Promise<number> {
  if (!CONTRACT_ADDRESS) return 0
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'getReserved', args: [offerKeyFor(offerId, sellerAddress)] })
  const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
  if (!result.data) return 0
  return Number(BigInt(result.data)) / (10 ** USDC_DECIMALS)
}

/** Read-only — the ACTUAL withdrawable/registerable amount for a SELL offer (remaining minus reserved). This is the number to show a seller for "how much can I take out right now" — getEscrowRemaining() alone overstates it once any trade is registered. No transaction, no gas, no signing. */
export async function getEscrowAvailable(offerId: string, sellerAddress: string): Promise<number> {
  if (!CONTRACT_ADDRESS) return 0
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'getAvailable', args: [offerKeyFor(offerId, sellerAddress)] })
  const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
  if (!result.data) return 0
  return Number(BigInt(result.data)) / (10 ** USDC_DECIMALS)
}

/** Read-only check of who the contract considers the seller of a given offer — no transaction, no gas, no signing. */
export async function getSellerOnChain(offerId: string, sellerAddress: string): Promise<string | null> {
  if (!CONTRACT_ADDRESS) return null
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'getSeller', args: [offerKeyFor(offerId, sellerAddress)] })
  const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
  if (!result.data || result.data.length < 42) return null
  return `0x${result.data.slice(-40)}`.toLowerCase()
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
 * Did this trade's release actually happen on-chain? Reads the trade's
 * `state` field via getTrade() and checks for Released (4).
 *
 * SECURITY/CORRECTNESS FIX: this used to call the legacy `tradeReleased`
 * mapping directly (P2PMeshportEscrow.sol's own boolean getter) — which
 * does NOT exist on P2PMeshportEscrowV2.sol at all (replaced by the full
 * Trade struct). Once VITE_P2P_ESCROW_CONTRACT points at a V2 deployment,
 * that call would simply fail (function selector mismatch), caught by the
 * try/catch below and returned as null — which fails SAFE (the reconciler
 * in p2pService.ts treats null as "investigate", never wrongly finalizes
 * or cancels a trade) but silently degrades every stuck-release check to
 * "unknown" forever, permanently disabling this reconciliation path the
 * moment V2 goes live. Reusing getTradeOnChain()'s already-verified
 * decoder (see its own header — checked byte-for-byte against a live
 * deployed V2 contract) fixes this properly instead of leaving it
 * degraded-but-safe. Mirrors the identical fix applied to
 * supabase/functions/p2p-release-reconcile/index.ts's own probeTradeReleased.
 */
export async function probeTradeReleasedOnChain(tradeId: string): Promise<boolean | null> {
  const trade = await getTradeOnChain(tradeId)
  if (!trade) return null
  return trade.state === 'Released'
}

/**
 * How much is still escrowed for a SELL offer's shared pool. Returns null
 * if it cannot be determined.
 */
export async function probeOfferEscrowRemaining(offerId: string, sellerAddress: string): Promise<number | null> {
  if (!CONTRACT_ADDRESS) return null
  try {
    const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'getRemaining', args: [offerKeyFor(offerId, sellerAddress)] })
    const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
    if (!result.data) return null
    return Number(BigInt(result.data)) / (10 ** USDC_DECIMALS)
  } catch {
    return null
  }
}

/**
 * How much is still escrowed under a TRADE's own key — buy-offer trades
 * deposit into a trade-keyed bucket (see depositForTrade), not an offer's
 * shared pool. Returns null if it cannot be determined.
 */
export async function probeTradeEscrowRemaining(tradeId: string): Promise<number | null> {
  if (!CONTRACT_ADDRESS) return null
  try {
    const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'getRemaining', args: [tradeKeyFor(tradeId)] })
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

// ── INVESTIGATOR / ADMIN dispute-resolution tier ─────────────────────────
// See P2PMeshportEscrowV2.sol's own header for the full sequence this
// enforces on-chain: Pauser freezes -> Investigator investigates (records
// an outcome, never moves funds) -> Admin resolves (moves funds for ONLY
// that trade, using ONLY its stored data). `privateKey` throughout is
// always the operator's own manually-entered key for that specific role —
// see the P2P Resolvers admin panel section, which asks Investigator/Admin
// to paste and validate their own key rather than reusing whatever wallet
// happens to be logged into the admin panel browser session, since the
// person operating as Investigator or Admin may not be the same person
// who's logged in.

export async function checkIsInvestigator(account: string): Promise<boolean> {
  if (!CONTRACT_ADDRESS || !account) return false
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'isInvestigator', args: [account as `0x${string}`] })
  try {
    const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
    if (!result.data) return false
    return BigInt(result.data) === 1n
  } catch {
    return false
  }
}

/**
 * The contract only exposes per-address mappings (isPauserRole/
 * isInvestigatorRole) — there is no on-chain array to enumerate "all
 * pausers" or "all investigators" directly. So this scans every
 * PauserAdded/PauserRemoved/InvestigatorAdded/InvestigatorRemoved event
 * this contract has ever emitted to build the set of addresses that have
 * EVER held either role, then re-checks each candidate's CURRENT status
 * directly against isPauser()/isInvestigator() on-chain. The event history
 * is only ever used to know which addresses are worth asking about — the
 * actual "does this address hold the role right now" answer always comes
 * from the live on-chain call, never from event bookkeeping/ordering.
 */
export interface RoleHolders {
  pausers: string[]
  investigators: string[]
}

export async function getCurrentRoleHolders(): Promise<RoleHolders> {
  if (!CONTRACT_ADDRESS) return { pausers: [], investigators: [] }
  try {
    const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 20000 }) })
    const latest = await publicClient.getBlockNumber()
    const eventNames = ['PauserAdded', 'PauserRemoved', 'InvestigatorAdded', 'InvestigatorRemoved'] as const

    // BUG FIX: this used to query fromBlock: 0n -> latest in ONE call per
    // event name. Arc's RPC endpoints reject eth_getLogs ranges that wide
    // (this same codebase caps ranges at 2,000-5,000 blocks elsewhere —
    // see CATCHUP_CHUNK_BLOCKS in arcDepositWatcher.ts and logChunkSize in
    // the indexer's chains.ts — for exactly this reason), so that single
    // call silently failed and fell into the catch below, returning an
    // empty log list for every event type at once. That's why a Pauser
    // that was genuinely added (and shows "Executed" on its proposal,
    // which reads the proposal struct directly, not events) never showed
    // up here. Fetching in RPC-sized windows, walking backward from the
    // latest block to genesis, fixes that — with a per-window shrink
    // fallback in case a given endpoint's actual cap is even smaller than
    // expected.
    const WINDOW = 2_000n
    const MIN_WINDOW = 200n

    async function fetchWindow(eventName: (typeof eventNames)[number], fromBlock: bigint, toBlock: bigint): Promise<any[]> {
      try {
        return await publicClient.getContractEvents({
          address: CONTRACT_ADDRESS, abi: ESCROW_ABI, eventName: eventName as any, fromBlock, toBlock,
        })
      } catch {
        const span = toBlock - fromBlock + 1n
        if (span <= MIN_WINDOW) return [] // give up on this sliver — matches "one failure shouldn't blank the whole list"
        const mid = fromBlock + span / 2n
        const [left, right] = await Promise.all([
          fetchWindow(eventName, fromBlock, mid - 1n),
          fetchWindow(eventName, mid, toBlock),
        ])
        return [...left, ...right]
      }
    }

    async function fetchAllForEvent(eventName: (typeof eventNames)[number]): Promise<any[]> {
      const windows: Array<[bigint, bigint]> = []
      let to = latest
      while (true) {
        const from = to > WINDOW - 1n ? to - (WINDOW - 1n) : 0n
        windows.push([from, to])
        if (from === 0n) break
        to = from - 1n
      }
      // Bounded concurrency so this doesn't fire hundreds of requests at
      // once on a long-lived contract — 6 windows in flight at a time.
      const CONCURRENCY = 6
      const out: any[] = []
      for (let i = 0; i < windows.length; i += CONCURRENCY) {
        const batch = windows.slice(i, i + CONCURRENCY)
        const results = await Promise.all(batch.map(([from, to]) => fetchWindow(eventName, from, to)))
        results.forEach(r => out.push(...r))
      }
      return out
    }

    const allLogs = await Promise.all(eventNames.map(fetchAllForEvent))

    const candidates = new Set<string>()
    allLogs.flat().forEach((log: any) => {
      const acct = log.args?.account as string | undefined
      if (acct) candidates.add(acct.toLowerCase())
    })

    const checked = await Promise.all([...candidates].map(async (addr) => ({
      addr,
      isP: await checkIsPauser(addr),
      isI: await checkIsInvestigator(addr),
    })))

    return {
      pausers: checked.filter(c => c.isP).map(c => c.addr),
      investigators: checked.filter(c => c.isI).map(c => c.addr),
    }
  } catch {
    return { pausers: [], investigators: [] }
  }
}

/**
 * Every privileged role an address might currently hold, checked live
 * on-chain in one shot — Admin, Pending Admin, Role Manager Signer,
 * Pauser, Investigator. Used to badge whichever wallet is connected in
 * the Role Managers admin panel so it's obvious at a glance what that
 * address can and can't do, instead of just "connected" with no context.
 */
export interface AddressRoles {
  isAdmin: boolean
  isPendingAdmin: boolean
  isRoleManagerSigner: boolean
  isPauser: boolean
  isInvestigator: boolean
}

export async function getAddressRoles(account: string): Promise<AddressRoles> {
  const none: AddressRoles = { isAdmin: false, isPendingAdmin: false, isRoleManagerSigner: false, isPauser: false, isInvestigator: false }
  if (!CONTRACT_ADDRESS || !account) return none
  const lower = account.toLowerCase()
  try {
    const [admin, pendingAdmin, isSigner, isPauserRole, isInvestigatorRole] = await Promise.all([
      getEscrowAdminAddress(), getPendingAdmin(), checkIsRoleManagerSigner(account), checkIsPauser(account), checkIsInvestigator(account),
    ])
    return {
      isAdmin: admin === lower,
      isPendingAdmin: pendingAdmin === lower,
      isRoleManagerSigner: isSigner,
      isPauser: isPauserRole,
      isInvestigator: isInvestigatorRole,
    }
  } catch {
    return none
  }
}

export type OnChainTradeState = 'None' | 'Active' | 'Frozen' | 'Investigated' | 'Released' | 'Refunded'
const TRADE_STATE_NAMES: OnChainTradeState[] = ['None', 'Active', 'Frozen', 'Investigated', 'Released', 'Refunded']

export interface OnChainTrade {
  offerKey: string; seller: string; buyer: string; amount: number
  state: OnChainTradeState; investigatedApproveRelease: boolean
  frozenBy: string; investigatedBy: string; resolvedBy: string
}

/** Reads the full authoritative on-chain trade record — the same data release()/adminResolve() themselves trust. Returns null if unreachable or the trade doesn't exist. */
export async function getTradeOnChain(tradeId: string): Promise<OnChainTrade | null> {
  if (!CONTRACT_ADDRESS) return null
  try {
    const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 15000 }) })
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: 'getTrade', args: [tradeKeyFor(tradeId)] })
    const result = await publicClient.call({ to: CONTRACT_ADDRESS, data })
    if (!result.data) return null
    // ABI-decode the 9-field tuple manually (offerKey, seller, buyer, amount, state, investigatedApproveRelease, frozenBy, investigatedBy, resolvedBy) — each field is one 32-byte word.
    const hex = result.data.slice(2)
    const word = (i: number) => hex.slice(i * 64, i * 64 + 64)
    const addr = (w: string) => `0x${w.slice(-40)}`.toLowerCase()
    return {
      offerKey: `0x${word(0)}`,
      seller: addr(word(1)),
      buyer: addr(word(2)),
      amount: Number(BigInt(`0x${word(3)}`)) / (10 ** USDC_DECIMALS),
      state: TRADE_STATE_NAMES[Number(BigInt(`0x${word(4)}`))] ?? 'None',
      investigatedApproveRelease: BigInt(`0x${word(5)}`) === 1n,
      frozenBy: addr(word(6)),
      investigatedBy: addr(word(7)),
      resolvedBy: addr(word(8)),
    }
  } catch {
    return null
  }
}

/** PAUSER: freeze/unfreeze an entire offer (blocks new deposits/trade registrations, doesn't touch trades already registered before the freeze). */
export async function freezeOfferOnChain(privateKey: string, offerId: string, sellerAddress: string): Promise<Hash> {
  return sendContractTx(privateKey, 'freezeOffer', [offerKeyFor(offerId, sellerAddress)])
}
export async function unfreezeOfferOnChain(privateKey: string, offerId: string, sellerAddress: string): Promise<Hash> {
  return sendContractTx(privateKey, 'unfreezeOffer', [offerKeyFor(offerId, sellerAddress)])
}

/** INVESTIGATOR: investigate a FROZEN trade and record the recommended outcome. Does not move funds — see the file header. */
export async function investigateTradeOnChain(privateKey: string, tradeId: string, approveRelease: boolean): Promise<Hash> {
  return sendContractTx(privateKey, 'investigate', [tradeKeyFor(tradeId), approveRelease])
}

/** ADMIN: resolve an already-INVESTIGATED trade — moves funds using ONLY that trade's stored buyer/amount/outcome. */
export async function adminResolveTradeOnChain(privateKey: string, tradeId: string): Promise<Hash> {
  return sendContractTx(privateKey, 'adminResolve', [tradeKeyFor(tradeId)])
}

// addInvestigatorOnChain/removeInvestigatorOnChain/addPauserOnChain used to
// live here as direct onlyAdmin-gated calls — removed, since those
// functions no longer exist on the contract at all. Use
// proposeRoleChange()/confirmRoleChange() above (the 2-of-3 role manager
// multisig) instead.

// ── Security notification feed — derived from on-chain EVENTS only ────────
// A database row is never treated as proof that a role/governance change
// happened. Every entry the Admin Panel's notification section shows comes
// straight from a real event this contract emitted, with the actual
// transaction hash/block number attached — if PauserAdded(address) fired,
// THAT is what's shown as the source, not a Supabase table saying "pauser
// added". This is what "notification integrity" means here: a UI row with
// no corresponding on-chain event behind it should never be possible to
// construct from this function's output in the first place.

export type GovernanceEventName =
  | 'PauserAdded' | 'PauserRemoved' | 'InvestigatorAdded' | 'InvestigatorRemoved'
  | 'AdminTransferInitiated' | 'AdminTransferred' | 'SignerRotated'
  | 'RoleProposalCreated' | 'RoleProposalConfirmed' | 'RoleProposalApproved'
  | 'RoleProposalCancelled' | 'RoleProposalExecuted'

export interface GovernanceEvent {
  name: GovernanceEventName
  args: Record<string, unknown>
  txHash: string
  blockNumber: bigint
  /** Populated with a best-effort block timestamp (unix seconds) — a second RPC round trip per unique block, so callers should expect this to take a little longer than a bare log fetch. */
  timestamp?: number
}

const GOVERNANCE_EVENT_NAMES: GovernanceEventName[] = [
  'PauserAdded', 'PauserRemoved', 'InvestigatorAdded', 'InvestigatorRemoved',
  'AdminTransferInitiated', 'AdminTransferred', 'SignerRotated',
  'RoleProposalCreated', 'RoleProposalConfirmed', 'RoleProposalApproved',
  'RoleProposalCancelled', 'RoleProposalExecuted',
]

/**
 * Fetches every privileged role/governance event emitted by this contract
 * in the last `blockLookback` blocks (default ~24h worth on Arc's ~2s
 * block time), newest first, with real transaction hashes and block
 * timestamps attached. This is what the Admin Panel's security
 * notifications section renders directly — never a Supabase/database
 * record of "a role changed".
 */
export async function getRecentGovernanceEvents(blockLookback = 43200): Promise<GovernanceEvent[]> {
  if (!CONTRACT_ADDRESS) return []
  try {
    const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 20000 }) })
    const latest = await publicClient.getBlockNumber()
    const fromBlock = latest > BigInt(blockLookback) ? latest - BigInt(blockLookback) : 0n

    const allLogs = await Promise.all(
      GOVERNANCE_EVENT_NAMES.map(async (eventName) => {
        try {
          const logs = await publicClient.getContractEvents({
            address: CONTRACT_ADDRESS, abi: ESCROW_ABI, eventName: eventName as any, fromBlock, toBlock: latest,
          })
          return logs.map((log: any) => ({
            name: eventName, args: log.args ?? {}, txHash: log.transactionHash as string, blockNumber: log.blockNumber as bigint,
          }))
        } catch {
          return [] // one event type failing to fetch shouldn't blank the whole feed
        }
      }),
    )
    const flat = allLogs.flat().sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : b.blockNumber < a.blockNumber ? -1 : 0))

    // Best-effort timestamp enrichment, one lookup per unique block.
    const uniqueBlocks = [...new Set(flat.map(e => e.blockNumber))]
    const blockTimestamps = new Map<bigint, number>()
    await Promise.all(uniqueBlocks.map(async (bn) => {
      try {
        const block = await publicClient.getBlock({ blockNumber: bn })
        blockTimestamps.set(bn, Number(block.timestamp))
      } catch { /* leave unset — timestamp is a display nicety, not required */ }
    }))

    return flat.map(e => ({ ...e, timestamp: blockTimestamps.get(e.blockNumber) }))
  } catch {
    return []
  }
}
