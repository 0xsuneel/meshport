// api/_lib/relayerSigner: the relayer signs through Circle (RELAYER_MODE=circle)
// and every signed transaction is checked before it is broadcast.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createWalletClient, custom, defineChain, parseTransaction, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import crypto from 'node:crypto'

// "Circle's" key for the test - Circle's API is mocked with a local signer.
const CIRCLE_PK = ('0x' + '11'.repeat(32)) as Hex
const circleSigner = privateKeyToAccount(CIRCLE_PK)
const OLD_PK = ('0x' + '22'.repeat(32)) as Hex
const oldKey = privateKeyToAccount(OLD_PK)
const { publicKey: RSA_PUB, privateKey: RSA_PRIV } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const ENTITY = 'ab'.repeat(32)

const signed: any[] = []
let tamper: ((tx: any) => any) | null = null
function mockCircle() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    if (url.endsWith('/config/entity/publicKey')) {
      return new Response(JSON.stringify({ data: { publicKey: RSA_PUB.export({ type: 'spki', format: 'pem' }) } }), { status: 200 })
    }
    if (url.endsWith('/developer/sign/transaction')) {
      const body = JSON.parse(init.body)
      // The ciphertext really is the Entity Secret, encrypted to Circle's key.
      const secret = crypto.privateDecrypt({ key: RSA_PRIV, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(body.entitySecretCiphertext, 'base64')).toString('hex')
      expect(secret).toBe(ENTITY)
      expect(body.walletId).toBe('wallet-1')
      const t = JSON.parse(body.transaction)
      signed.push(t)
      const tx: any = {
        type: 'eip1559', chainId: t.chainId, nonce: t.nonce, to: t.to, value: BigInt(t.value), data: t.data,
        gas: BigInt(t.gas), maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas),
      }
      const signedTransaction = await circleSigner.signTransaction(tamper ? tamper(tx) : tx)
      return new Response(JSON.stringify({ data: { signedTransaction } }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }))
}

const ARC = defineChain({ id: 5042002, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['http://x'] } } })
const sent: Hex[] = []
const transport = custom({
  async request({ method, params }: any) {
    if (method === 'eth_chainId') return '0x' + ARC.id.toString(16)
    if (method === 'eth_sendRawTransaction') { sent.push(params[0]); return '0x' + 'ee'.repeat(32) }
    throw new Error('unexpected ' + method)
  },
})
const TX = { to: '0x000000000000000000000000000000000000dEaD' as Hex, data: '0x1234' as Hex, value: 5n, nonce: 7, gas: 100_000n, maxFeePerGas: 30n, maxPriorityFeePerGas: 2n }

describe('relayerSigner', () => {
  beforeEach(() => {
    vi.resetModules()
    signed.length = 0; sent.length = 0; tamper = null
    process.env.RELAYER_MODE = 'circle'
    process.env.CIRCLE_API_KEY = 'TEST_API_KEY:x'
    process.env.CIRCLE_ENTITY_SECRET = ENTITY
    process.env.CIRCLE_RELAYER_WALLET_ID = 'wallet-1'
    process.env.CIRCLE_RELAYER_ADDRESS = circleSigner.address
    process.env.BRIDGE_RELAYER_PRIVATE_KEY = OLD_PK
    delete process.env.CIRCLE_SIGN_UNSUPPORTED_CHAINS
    mockCircle()
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('sends through Circle: the exact transaction viem built, signed by the Circle wallet', async () => {
    const { relayerAccount } = await import('../../api/_lib/relayerSigner')
    const account = await relayerAccount(5042002)
    expect(account.address.toLowerCase()).toBe(circleSigner.address.toLowerCase())
    const wallet = createWalletClient({ chain: ARC, transport, account })
    await wallet.sendTransaction(TX)
    expect(signed).toEqual([{ nonce: 7, to: TX.to, value: '5', data: '0x1234', gas: '100000', maxFeePerGas: '30', maxPriorityFeePerGas: '2', chainId: 5042002 }])
    const p: any = parseTransaction(sent[0])
    expect(p).toMatchObject({ chainId: 5042002, nonce: 7, value: 5n, data: '0x1234', gas: 100_000n })
  })

  it('never broadcasts a signature that does not match the request', async () => {
    tamper = (tx) => ({ ...tx, to: '0x000000000000000000000000000000000000bEEF' })
    const { relayerAccount } = await import('../../api/_lib/relayerSigner')
    const wallet = createWalletClient({ chain: ARC, transport, account: await relayerAccount(5042002) })
    await expect(wallet.sendTransaction(TX)).rejects.toThrow(/does not match/)
    expect(sent).toEqual([])
  })

  it('rejects a transaction signed by another key', async () => {
    const { checkSigned, circleTxObject } = await import('../../api/_lib/relayerSigner')
    const asked = circleTxObject({ ...TX, chainId: 5042002 })
    const byOther = await oldKey.signTransaction({ type: 'eip1559', chainId: 5042002, ...TX })
    await expect(checkSigned(byOther, asked, circleSigner.address)).rejects.toThrow(/does not match/)
  })

  it('a legacy gasPrice is sent to Circle as EIP-1559 fees', async () => {
    const { circleTxObject } = await import('../../api/_lib/relayerSigner')
    expect(circleTxObject({ chainId: 1, nonce: 0, gas: 21000n, gasPrice: 9n, to: TX.to })).toMatchObject({ maxFeePerGas: '9', maxPriorityFeePerGas: '9', value: '0', data: '0x' })
  })

  it('chains Circle cannot sign on (Sonic, Sei, HyperEVM) keep the private key', async () => {
    const { relayerAccount } = await import('../../api/_lib/relayerSigner')
    for (const id of [14601, 1328, 998]) expect((await relayerAccount(id)).address).toBe(oldKey.address)
    expect((await relayerAccount(84532)).address.toLowerCase()).toBe(circleSigner.address.toLowerCase())
  })

  it('key mode (default) is unchanged', async () => {
    delete process.env.RELAYER_MODE
    const { relayerAccount, relayerAddress } = await import('../../api/_lib/relayerSigner')
    expect((await relayerAccount(5042002)).address).toBe(oldKey.address)
    expect(await relayerAddress()).toBe(oldKey.address)
  })

  it('the P2P operator address is the Circle wallet in circle mode', async () => {
    const { relayerAddress } = await import('../../api/_lib/relayerSigner')
    expect((await relayerAddress())!.toLowerCase()).toBe(circleSigner.address.toLowerCase())
  })

  it('without Circle settings, circle mode falls back to the key rather than failing', async () => {
    delete process.env.CIRCLE_RELAYER_WALLET_ID
    const { relayerAccount } = await import('../../api/_lib/relayerSigner')
    expect((await relayerAccount(5042002)).address).toBe(oldKey.address)
  })
})


