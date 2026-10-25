// server/solana/feePayer.ts
//
// MeshPort pays Solana network fees so users never need SOL (docs/SOLANA.md,
// option A). The user's Solana wallet signs a transaction whose fee payer is
// MeshPort's key; this checks it and adds MeshPort's signature. MeshPort's
// SOL can only ever go to network fees, opening USDC accounts and the rent of
// CCTP burn event accounts:
//
//   - fee payer = MeshPort's key, and every other signer has already signed
//   - top-level instructions only from: Compute Budget (capped), Associated
//     Token Account create / create-idempotent for USDC (MeshPort may pay the
//     rent), SPL Token TransferChecked of USDC, and CCTP v2
//     deposit_for_burn_with_hook of USDC to Arc with Circle's forwarding hook
//     (MeshPort may be its event rent payer)
//   - MeshPort's key appears in no instruction except as those rent payers,
//     so it can't be a transfer source, owner or authority
//   - no address lookup tables, at most MAX_INSTRUCTIONS instructions

import {
  createKeyPairFromBytes, getBase58Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder,
  partiallySignTransaction, type Address, type Transaction,
} from '@solana/kit'

export const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
export const SYSTEM_PROGRAM = '11111111111111111111111111111111'
export const TOKEN_MESSENGER_MINTER_V2 = 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe'
export const MESSAGE_TRANSMITTER_V2 = 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC'
const DEPOSIT_FOR_BURN_WITH_HOOK = [111, 245, 62, 131, 204, 108, 223, 155]
const ARC_DOMAIN = 26
const FORWARD_MAGIC = [...new TextEncoder().encode('cctp-forward')]

const MAX_INSTRUCTIONS = 6
const MAX_COMPUTE_UNITS = 400_000
// Priority fee cap: 400k CU at 100k micro-lamports is 40,000 lamports (0.00004 SOL).
const MAX_MICRO_LAMPORTS_PER_CU = 100_000n
const MAX_TX_BYTES = 1232 // Solana's packet limit

export class FeePayerError extends Error {
  constructor(message: string) { super(message) }
}
const refuse = (m: string): never => { throw new FeePayerError(m) }

function u32le(d: ArrayLike<number>, at: number): number { return (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0 }
function u64le(d: ArrayLike<number>, at: number): bigint {
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i])
  return v
}

export interface CheckedTransaction {
  transaction: Transaction
  /** USDC moved by TransferChecked instructions, in base units (6 decimals). */
  usdcUnits: bigint
  /** USDC accounts this transaction opens with MeshPort paying the rent. */
  accountsOpened: number
  /** CCTP burns to Arc (Bring Funds / settlement), in base units. */
  burnUnits: bigint
}

/** Decode and check a user-signed transaction against the rules above. */
export function checkFeePayerTransaction(bytes: Uint8Array, feePayer: string, usdcMint = USDC_MINT_DEVNET): CheckedTransaction {
  if (bytes.length === 0 || bytes.length > MAX_TX_BYTES) refuse('Transaction size is not valid')
  let transaction: Transaction
  try { transaction = getTransactionDecoder().decode(bytes) } catch { return refuse('Not a Solana transaction') }
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
  const accounts = message.staticAccounts as readonly string[]
  if ('addressTableLookups' in message && (message.addressTableLookups?.length ?? 0) > 0) refuse('Address lookup tables are not accepted')
  if (accounts[0] !== feePayer) refuse("The fee payer must be MeshPort's fee payer")

  // Every signer except the fee payer has already signed.
  const signers = accounts.slice(0, message.header.numSignerAccounts)
  if (signers.length < 2) refuse('The transaction needs the sender to sign it')
  for (const s of signers.slice(1)) {
    if (s === feePayer) refuse('The fee payer may only appear once')
    if (!transaction.signatures[s as Address]) refuse('The sender has not signed this transaction')
  }

  const instructions = message.instructions
  if (instructions.length === 0 || instructions.length > MAX_INSTRUCTIONS) refuse('Too many instructions')
  let usdcUnits = 0n
  let accountsOpened = 0
  let burnUnits = 0n
  for (const ix of instructions) {
    const program = accounts[ix.programAddressIndex]
    const keys = (ix.accountIndices ?? []).map(i => accounts[i])
    const data = ix.data ?? new Uint8Array()
    if (!program) refuse('Unknown program')

    if (program === COMPUTE_BUDGET_PROGRAM) {
      if (data[0] === 2 && data.length === 5) { if (u32le(data, 1) > MAX_COMPUTE_UNITS) refuse('Compute limit too high') }
      else if (data[0] === 3 && data.length === 9) { if (u64le(data, 1) > MAX_MICRO_LAMPORTS_PER_CU) refuse('Priority fee too high') }
      else refuse('Compute budget instruction not allowed')
      continue
    }

    if (program === ASSOCIATED_TOKEN_PROGRAM) {
      // create (empty / [0]) or create-idempotent ([1]):
      // [payer, associated account, owner, mint, system program, token program]
      if (!(data.length === 0 || (data.length === 1 && (data[0] === 0 || data[0] === 1)))) refuse('Token account instruction not allowed')
      if (keys.length !== 6) refuse('Token account instruction is malformed')
      if (keys[3] !== usdcMint) refuse('Only USDC accounts can be opened')
      if (keys[4] !== SYSTEM_PROGRAM || keys[5] !== TOKEN_PROGRAM) refuse('Token account instruction is malformed')
      if (keys.slice(1).includes(feePayer)) refuse("MeshPort's fee payer can't own an account here")
      if (keys[0] === feePayer) accountsOpened++
      continue
    }

    if (program === TOKEN_PROGRAM) {
      // TransferChecked: [source, mint, destination, authority], data [12, amount u64, decimals u8]
      if (data[0] !== 12 || data.length !== 10) refuse('Only USDC transfers are allowed')
      if (keys.length < 4 || keys[1] !== usdcMint) refuse('Only USDC transfers are allowed')
      if (data[9] !== 6) refuse('USDC has 6 decimals')
      if (keys.includes(feePayer)) refuse("MeshPort's fee payer can't take part in a transfer")
      usdcUnits += u64le(data, 1)
      continue
    }

    if (program === TOKEN_MESSENGER_MINTER_V2) {
      // deposit_for_burn_with_hook (Circle's IDL): [owner, event_rent_payer,
      // sender_authority, burn_token_account, denylist, message_transmitter,
      // token_messenger, remote_token_messenger, token_minter, local_token,
      // burn_token_mint, message_sent_event_data, message_transmitter_program,
      // token_messenger_minter_program, token_program, system_program,
      // event_authority, program]
      // data: disc(8) amount u64, domain u32, mint_recipient(32),
      // destination_caller(32), max_fee u64, min_finality u32, hook (u32 len + bytes)
      if (DEPOSIT_FOR_BURN_WITH_HOOK.some((b, i) => data[i] !== b)) refuse('Only CCTP burns to Arc are allowed')
      if (keys.length !== 18) refuse('CCTP burn is malformed')
      if (keys[10] !== usdcMint) refuse('Only USDC can be burned')
      if (keys[12] !== MESSAGE_TRANSMITTER_V2 || keys[13] !== TOKEN_MESSENGER_MINTER_V2 || keys[14] !== TOKEN_PROGRAM || keys[15] !== SYSTEM_PROGRAM || keys[17] !== TOKEN_MESSENGER_MINTER_V2) {
        refuse('CCTP burn is malformed')
      }
      if (keys[0] === feePayer || keys.some((k, i) => k === feePayer && i !== 1)) refuse("MeshPort's fee payer can't take part in a burn")
      if (data.length < 8 + 8 + 4 + 32 + 32 + 8 + 4 + 4) refuse('CCTP burn is malformed')
      if (u32le(data, 16) !== ARC_DOMAIN) refuse('Solana burns are paid for only to Arc')
      const hookLen = u32le(data, 8 + 8 + 4 + 32 + 32 + 8 + 4)
      const hookAt = 8 + 8 + 4 + 32 + 32 + 8 + 4 + 4
      if (data.length !== hookAt + hookLen || hookLen < FORWARD_MAGIC.length || FORWARD_MAGIC.some((b, i) => data[hookAt + i] !== b)) {
        refuse("Only burns forwarded by Circle's Forwarding Service are allowed")
      }
      burnUnits += u64le(data, 8)
      continue
    }

    refuse('This kind of transaction is not paid for by MeshPort')
  }
  return { transaction, usdcUnits, accountsOpened, burnUnits }
}

/** MeshPort's fee payer keys from its 64-byte secret (base58, as stored in Vercel). */
export async function feePayerKeys(secretBase58: string): Promise<{ keys: CryptoKeyPair; address: string }> {
  const bytes = getBase58Encoder().encode(secretBase58.trim())
  if (bytes.length !== 64) throw new Error('SOLANA_FEE_PAYER_SECRET must be a 64-byte secret key')
  const keys = await createKeyPairFromBytes(new Uint8Array(bytes))
  const { getAddressFromPublicKey } = await import('@solana/kit')
  return { keys, address: await getAddressFromPublicKey(keys.publicKey) }
}

/** Add MeshPort's fee-payer signature to a checked transaction. */
export async function coSign(checked: CheckedTransaction, keys: CryptoKeyPair): Promise<Transaction> {
  return partiallySignTransaction([keys], checked.transaction)
}

/** The USDC associated token account of a Solana wallet. */
export async function usdcTokenAccount(owner: string, usdcMint = USDC_MINT_DEVNET): Promise<Address> {
  const { getAddressEncoder, getProgramDerivedAddress, address } = await import('@solana/kit')
  const enc = getAddressEncoder()
  const [ata] = await getProgramDerivedAddress({
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM),
    seeds: [enc.encode(address(owner)), enc.encode(address(TOKEN_PROGRAM)), enc.encode(address(usdcMint))],
  })
  return ata
}

/**
 * MeshPort opening a wallet's USDC account (create-idempotent, MeshPort pays
 * the rent), so USDC can be sent to it - Arc → Solana transfers need the
 * recipient's account to exist. Built and signed entirely here.
 */
export async function openUsdcAccountTransaction(owner: string, keys: CryptoKeyPair, feePayer: string,
  lifetime: { blockhash: string; lastValidBlockHeight: bigint }, usdcMint = USDC_MINT_DEVNET): Promise<Transaction> {
  const kit = await import('@solana/kit')
  const ata = await usdcTokenAccount(owner, usdcMint)
  const R = kit.AccountRole
  const ix = {
    programAddress: kit.address(ASSOCIATED_TOKEN_PROGRAM),
    accounts: [
      { address: kit.address(feePayer), role: R.WRITABLE_SIGNER },
      { address: ata, role: R.WRITABLE },
      { address: kit.address(owner), role: R.READONLY },
      { address: kit.address(usdcMint), role: R.READONLY },
      { address: kit.address(SYSTEM_PROGRAM), role: R.READONLY },
      { address: kit.address(TOKEN_PROGRAM), role: R.READONLY },
    ],
    data: new Uint8Array([1]),
  }
  const message = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    m => kit.setTransactionMessageFeePayer(kit.address(feePayer), m),
    m => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: lifetime.blockhash as any, lastValidBlockHeight: lifetime.lastValidBlockHeight }, m),
    m => kit.appendTransactionMessageInstructions([ix], m),
  )
  return kit.partiallySignTransaction([keys], kit.compileTransaction(message))
}
