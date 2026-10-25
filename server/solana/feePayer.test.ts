// server/solana/feePayer.ts with real Solana transactions built by
// @solana/kit and real keys: what MeshPort pays for, and what it refuses.
import { describe, it, expect, beforeAll } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createKeyPairFromBytes, createTransactionMessage,
  getAddressFromPublicKey, getBase58Decoder, getTransactionEncoder, partiallySignTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Blockhash, type Instruction,
} from '@solana/kit'
import {
  ASSOCIATED_TOKEN_PROGRAM, checkFeePayerTransaction, coSign, COMPUTE_BUDGET_PROGRAM, FeePayerError, feePayerKeys,
  SYSTEM_PROGRAM, TOKEN_PROGRAM, USDC_MINT_DEVNET,
} from './feePayer'

function secret64(): Uint8Array {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return new Uint8Array(Buffer.concat([
    privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
    publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  ]))
}

let payerSecret: string, payer: Address, payerKeys: CryptoKeyPair
let user: Address, userKeys: CryptoKeyPair
const other = 'So11111111111111111111111111111111111111112' as Address // any account
const BLOCKHASH = { blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k' as Blockhash, lastValidBlockHeight: 100n }

beforeAll(async () => {
  const p = secret64()
  payerSecret = getBase58Decoder().decode(p)
  payerKeys = await createKeyPairFromBytes(p)
  payer = await getAddressFromPublicKey(payerKeys.publicKey)
  userKeys = await createKeyPairFromBytes(secret64())
  user = await getAddressFromPublicKey(userKeys.publicKey)
})

const u64 = (v: bigint) => { const b = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n } return b }
const transferChecked = (opts: { mint?: string; authority?: Address; amount?: bigint; decimals?: number; disc?: number } = {}): Instruction => ({
  programAddress: TOKEN_PROGRAM as Address,
  accounts: [
    { address: other, role: AccountRole.WRITABLE },
    { address: (opts.mint ?? USDC_MINT_DEVNET) as Address, role: AccountRole.READONLY },
    { address: 'Fq8Rq9ZPLhvZFTqHaqjnZkFNCyHMmuFmfY8Ki4RT2Eah' as Address, role: AccountRole.WRITABLE },
    { address: opts.authority ?? user, role: AccountRole.READONLY_SIGNER },
  ],
  data: new Uint8Array([opts.disc ?? 12, ...u64(opts.amount ?? 1_500_000n), opts.decimals ?? 6]),
})
const openUsdcAccount = (opts: { payerAddr?: Address; mint?: string } = {}): Instruction => ({
  programAddress: ASSOCIATED_TOKEN_PROGRAM as Address,
  accounts: [
    { address: opts.payerAddr ?? payer, role: AccountRole.WRITABLE_SIGNER },
    { address: 'Fq8Rq9ZPLhvZFTqHaqjnZkFNCyHMmuFmfY8Ki4RT2Eah' as Address, role: AccountRole.WRITABLE },
    { address: 'GtjYHh1cbxM2pEdVbM1BEyqvVBkdUNQJ7jJYPzyGP4pt' as Address, role: AccountRole.READONLY },
    { address: (opts.mint ?? USDC_MINT_DEVNET) as Address, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM as Address, role: AccountRole.READONLY },
    { address: TOKEN_PROGRAM as Address, role: AccountRole.READONLY },
  ],
  data: new Uint8Array([1]),
})
const computeLimit = (units: number): Instruction => {
  const d = new Uint8Array(5); d[0] = 2; new DataView(d.buffer).setUint32(1, units, true)
  return { programAddress: COMPUTE_BUDGET_PROGRAM as Address, data: d }
}
const systemTransferFromPayer = (): Instruction => ({
  programAddress: SYSTEM_PROGRAM as Address,
  accounts: [{ address: payer, role: AccountRole.WRITABLE_SIGNER }, { address: other, role: AccountRole.WRITABLE }],
  data: new Uint8Array([2, 0, 0, 0, ...u64(1_000_000_000n)]),
})

async function build(instructions: Instruction[], opts: { feePayer?: Address; userSigns?: boolean } = {}): Promise<Uint8Array> {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(opts.feePayer ?? payer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(BLOCKHASH, m),
    m => appendTransactionMessageInstructions(instructions, m),
  )
  let tx = compileTransaction(msg)
  if (opts.userSigns !== false) tx = await partiallySignTransaction([userKeys], tx)
  return new Uint8Array(getTransactionEncoder().encode(tx))
}

const refused = async (bytes: Promise<Uint8Array>, msg: RegExp) => {
  const b = await bytes
  expect(() => checkFeePayerTransaction(b, payer)).toThrow(FeePayerError)
  expect(() => checkFeePayerTransaction(b, payer)).toThrow(msg)
}

describe('Solana fee payer: what MeshPort pays for', () => {
  it('a USDC transfer signed by the sender, with a compute limit, is co-signed', async () => {
    const checked = checkFeePayerTransaction(await build([computeLimit(200_000), transferChecked()]), payer)
    expect(checked.usdcUnits).toBe(1_500_000n)
    const signed = await coSign(checked, (await feePayerKeys(payerSecret)).keys)
    expect(signed.signatures[payer]).toBeTruthy()
    expect(signed.signatures[user]).toBeTruthy()
  })

  it("opening the recipient's USDC account, rent paid by MeshPort, then a transfer", async () => {
    const checked = checkFeePayerTransaction(await build([openUsdcAccount(), transferChecked()]), payer)
    expect(checked.accountsOpened).toBe(1)
  })

  it('feePayerKeys turns the stored secret back into the same address', async () => {
    expect((await feePayerKeys(payerSecret)).address).toBe(payer)
    await expect(feePayerKeys('abc')).rejects.toThrow(/64-byte/)
  })
})

describe("Solana fee payer: what it refuses (MeshPort's SOL can't be taken)", () => {
  it("a different fee payer, or the sender hasn't signed", async () => {
    await refused(build([transferChecked()], { feePayer: user }), /fee payer must be MeshPort/)
    await refused(build([transferChecked()], { userSigns: false }), /not signed/)
  })

  it('sending SOL from the fee payer', async () => {
    await refused(build([systemTransferFromPayer(), transferChecked()]), /not paid for by MeshPort/)
  })

  it('the fee payer as transfer authority, or a non-USDC token, or a plain Transfer', async () => {
    await refused(build([transferChecked(), transferChecked({ authority: payer })]), /can't take part in a transfer/)
    await refused(build([transferChecked({ mint: 'So11111111111111111111111111111111111111112' })]), /Only USDC/)
    await refused(build([transferChecked({ disc: 3 })]), /Only USDC transfers/)
    await refused(build([transferChecked({ decimals: 9 })]), /6 decimals/)
  })

  it('opening a non-USDC account, or one the fee payer would own', async () => {
    await refused(build([openUsdcAccount({ mint: 'So11111111111111111111111111111111111111112' }), transferChecked()]), /Only USDC accounts/)
  })

  it('a compute limit over the cap, including one that would read as negative', async () => {
    await refused(build([computeLimit(1_400_000), transferChecked()]), /Compute limit too high/)
    await refused(build([computeLimit(0xffffffff), transferChecked()]), /Compute limit too high/)
  })

  it('garbage bytes', () => {
    expect(() => checkFeePayerTransaction(new Uint8Array([1, 2, 3]), payer)).toThrow(FeePayerError)
    expect(() => checkFeePayerTransaction(new Uint8Array(), payer)).toThrow(/size/)
  })
})
