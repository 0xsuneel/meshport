// server/solana/feePayer.ts
//
// MeshPort pays Solana network fees so users never need SOL (docs/SOLANA.md,
// option A). The user's Privy wallet signs a transaction whose fee payer is
// MeshPort's key; this checks it and adds MeshPort's signature. MeshPort's
// SOL can only ever go to network fees and to opening USDC accounts:
//
//   - fee payer = MeshPort's key, and every other signer has already signed
//   - top-level instructions only from: Compute Budget (capped), Associated
//     Token Account create / create-idempotent for USDC (MeshPort may pay the
//     rent), and SPL Token TransferChecked of USDC
//   - MeshPort's key appears in no instruction except as that rent payer, so
//     it can't be a transfer source, owner or authority
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

    refuse('This kind of transaction is not paid for by MeshPort')
  }
  return { transaction, usdcUnits, accountsOpened }
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
