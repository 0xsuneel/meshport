// src/lib/solanaCctp.ts
//
// USDC from Solana to Arc over CCTP v2 (docs/SOLANA.md) - Bring Funds and a
// store's settlement from Solana. One Solana transaction:
//
//   TokenMessengerMinterV2.deposit_for_burn_with_hook - burns the user's
//   USDC with Circle's forwarding hook ("cctp-forward"), so Circle's
//   Forwarding Service mints on Arc to the user's own Arc address. No
//   MeshPort relay and no Arc gas.
//
// MeshPort pays: its fee payer (/api/solana-fee-payer) is the transaction's
// fee payer and the CCTP event account's rent payer, so the user needs no
// SOL. Signers: the user's Solana wallet (wallet/solana.ts) and a fresh
// keypair for the event account; the fee payer signs last, server-side.
//
// Account order and the instruction layout are Circle's IDL
// (circlefin/solana-cctp-contracts, token_messenger_minter_v2.json).

import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress, getTransactionEncoder, partiallySignTransaction,
  pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Blockhash, type Instruction,
} from '@solana/kit'
import { SOLANA_RPC, SOLANA_USDC_MINT } from './solana'

export const SOLANA_DOMAIN = 5
export const ARC_DOMAIN = 26
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const ASSOCIATED_TOKEN_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
export const SYSTEM_PROGRAM = address('11111111111111111111111111111111')
export const MESSAGE_TRANSMITTER_V2 = address('CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC')
export const TOKEN_MESSENGER_MINTER_V2 = address('CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe')
/** Anchor discriminator of deposit_for_burn_with_hook (from Circle's IDL). */
export const DEPOSIT_FOR_BURN_WITH_HOOK = new Uint8Array([111, 245, 62, 131, 204, 108, 223, 155])
/** Circle Forwarding Service hook: "cctp-forward", version 0, no extra data. */
export const FORWARD_HOOK = new Uint8Array([...new TextEncoder().encode('cctp-forward'), ...new Uint8Array(20)])
export const FAST_FINALITY = 1000

const utf8 = (s: string) => new TextEncoder().encode(s)
const enc = getAddressEncoder()

async function pda(program: Address, seeds: Array<Uint8Array | Address>): Promise<Address> {
  const [a] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: seeds.map(s => (typeof s === 'string' ? enc.encode(s) : s)),
  })
  return a
}

/** The USDC associated token account of a Solana wallet. */
export function usdcTokenAccount(owner: string): Promise<Address> {
  return pda(ASSOCIATED_TOKEN_PROGRAM, [address(owner), TOKEN_PROGRAM, address(SOLANA_USDC_MINT)])
}

function u64(v: bigint): Uint8Array { const b = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n } return b }
function u32(v: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b }

/** An Arc (EVM) address as CCTP's 32-byte mint recipient. */
export function evmToBytes32(evm: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(evm)) throw new Error('Not an Arc address')
  const out = new Uint8Array(32)
  for (let i = 0; i < 20; i++) out[12 + i] = parseInt(evm.slice(2 + i * 2, 4 + i * 2), 16)
  return out
}

/** Borsh-encoded DepositForBurnWithHookParams, after the discriminator. */
export function burnData(p: { amount: bigint; destinationDomain: number; mintRecipient: Uint8Array; maxFee: bigint; minFinality: number; hook: Uint8Array }): Uint8Array {
  const parts = [
    DEPOSIT_FOR_BURN_WITH_HOOK, u64(p.amount), u32(p.destinationDomain), p.mintRecipient,
    new Uint8Array(32), // destination_caller: anyone (the Forwarding Service needs it unset)
    u64(p.maxFee), u32(p.minFinality), u32(p.hook.length), p.hook,
  ]
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0))
  let at = 0
  for (const x of parts) { out.set(x, at); at += x.length }
  return out
}

/** Circle's fee for a fast, forwarded Solana → Arc burn of `amount` (base units). */
export async function quoteSolanaToArc(amount: bigint, fetchImpl: typeof fetch = fetch): Promise<{ maxFee: bigint; forwardFee: bigint; protocolFee: bigint }> {
  for (const host of ['https://iris-api-sandbox.circle.com', 'https://iris-api.circle.com']) {
    try {
      const r = await fetchImpl(`${host}/v2/burn/USDC/fees/${SOLANA_DOMAIN}/${ARC_DOMAIN}?forward=true`)
      if (!r.ok) continue
      const rows = await r.json() as Array<{ finalityThreshold: number; minimumFee: number; forwardFee?: { high?: number } }>
      const fast = rows.find(x => x.finalityThreshold === FAST_FINALITY)
      if (!fast?.forwardFee?.high) continue
      const forwardFee = BigInt(Math.ceil(fast.forwardFee.high))
      // minimumFee is in basis points of the amount; round up.
      const protocolFee = (amount * BigInt(Math.round(fast.minimumFee * 100)) + 999_999n) / 1_000_000n
      // 10% headroom on the forwarding fee: the burn's maxFee is a cap, the
      // actual fee is what Circle charges.
      return { forwardFee, protocolFee, maxFee: protocolFee + forwardFee + forwardFee / 10n }
    } catch { /* next host */ }
  }
  throw new Error("Couldn't get Circle's fee for Solana → Arc - try again")
}

async function latestBlockhash(fetchImpl: typeof fetch): Promise<{ blockhash: Blockhash; lastValidBlockHeight: bigint }> {
  const r = await fetchImpl(SOLANA_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] }),
  })
  const j = await r.json() as { result?: { value: { blockhash: string; lastValidBlockHeight: number } } }
  if (!j.result) throw new Error('Solana is not reachable right now - try again')
  return { blockhash: j.result.value.blockhash as Blockhash, lastValidBlockHeight: BigInt(j.result.value.lastValidBlockHeight) }
}

/**
 * The burn transaction, signed by the event account but not yet by the user
 * or the fee payer (wire format). `owner` is the user's Solana address,
 * `arcRecipient` their Arc address.
 */
export async function buildSolanaBurnToArc(p: {
  owner: string; arcRecipient: string; amount: bigint; maxFee: bigint; feePayer: string; fetchImpl?: typeof fetch
}): Promise<Uint8Array> {
  if (p.amount <= 0n) throw new Error('Amount must be more than 0')
  if (p.maxFee >= p.amount) throw new Error('The amount must be more than the fee')
  const owner = address(p.owner)
  const feePayer = address(p.feePayer)
  const mint = address(SOLANA_USDC_MINT)
  const event = await generateKeyPairSigner()
  const [senderAuthority, tokenMessenger, tokenMinter, localToken, remoteTokenMessenger, denylist, eventAuthority, messageTransmitter, burnAccount] = await Promise.all([
    pda(TOKEN_MESSENGER_MINTER_V2, [utf8('sender_authority')]),
    pda(TOKEN_MESSENGER_MINTER_V2, [utf8('token_messenger')]),
    pda(TOKEN_MESSENGER_MINTER_V2, [utf8('token_minter')]),
    pda(TOKEN_MESSENGER_MINTER_V2, [utf8('local_token'), mint]),
    pda(TOKEN_MESSENGER_MINTER_V2, [utf8('remote_token_messenger'), utf8(String(ARC_DOMAIN))]),
    pda(TOKEN_MESSENGER_MINTER_V2, [utf8('denylist_account'), owner]),
    pda(TOKEN_MESSENGER_MINTER_V2, [utf8('__event_authority')]),
    pda(MESSAGE_TRANSMITTER_V2, [utf8('message_transmitter')]),
    usdcTokenAccount(p.owner),
  ])
  const R = AccountRole
  const burn: Instruction = {
    programAddress: TOKEN_MESSENGER_MINTER_V2,
    accounts: [
      { address: owner, role: R.READONLY_SIGNER },
      { address: feePayer, role: R.WRITABLE_SIGNER },          // event_rent_payer
      { address: senderAuthority, role: R.READONLY },
      { address: burnAccount, role: R.WRITABLE },
      { address: denylist, role: R.READONLY },
      { address: messageTransmitter, role: R.WRITABLE },
      { address: tokenMessenger, role: R.READONLY },
      { address: remoteTokenMessenger, role: R.READONLY },
      { address: tokenMinter, role: R.READONLY },
      { address: localToken, role: R.WRITABLE },
      { address: mint, role: R.WRITABLE },
      { address: event.address, role: R.WRITABLE_SIGNER },     // message_sent_event_data
      { address: MESSAGE_TRANSMITTER_V2, role: R.READONLY },
      { address: TOKEN_MESSENGER_MINTER_V2, role: R.READONLY },
      { address: TOKEN_PROGRAM, role: R.READONLY },
      { address: SYSTEM_PROGRAM, role: R.READONLY },
      { address: eventAuthority, role: R.READONLY },
      { address: TOKEN_MESSENGER_MINTER_V2, role: R.READONLY }, // program
    ],
    data: burnData({ amount: p.amount, destinationDomain: ARC_DOMAIN, mintRecipient: evmToBytes32(p.arcRecipient), maxFee: p.maxFee, minFinality: FAST_FINALITY, hook: FORWARD_HOOK }),
  }
  const lifetime = await latestBlockhash(p.fetchImpl ?? fetch)
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    m => appendTransactionMessageInstructions([burn], m),
  )
  const tx = await partiallySignTransaction([event.keyPair], compileTransaction(message))
  return new Uint8Array(getTransactionEncoder().encode(tx))
}
