// src/wallet/account.ts
//
// The wallet as the rest of the app sees it: an address plus "please sign".
// Signing happens in the wallet frame; nothing here ever holds the key.
//
//   WalletAccount      a viem LocalAccount - pass it anywhere viem takes an
//                      account (createWalletClient, writeContract, …)
//   toEthersSigner     the same account as an ethers v6 Signer
//   createWalletAdapter  Circle App Kit's EthersAdapter on that signer - the
//                      drop-in for createEthersAdapterFromPrivateKey, same
//                      getProvider, so relayed / custom RPC providers behave
//                      exactly as before

import { toAccount } from 'viem/accounts'
import { bytesToHex, type LocalAccount, type SignableMessage, type TransactionSerializable, type TypedDataDefinition } from 'viem'
import { callWallet, WalletFrameError } from './frameClient'
import type { FrameTransaction, Hex } from './protocol'

export type WalletAccount = LocalAccount<'custom'> & { readonly meshportWallet: true }

const cache = new Map<string, WalletAccount>()

// Only plain transaction fields cross into the frame - a viem request can
// carry the account object, chain formatters etc. (functions can't be posted
// and the frame must sign exactly the fields it can see).
const TX_FIELDS = ['type', 'chainId', 'nonce', 'to', 'value', 'data', 'gas', 'gasPrice',
  'maxFeePerGas', 'maxPriorityFeePerGas', 'accessList'] as const

export function plainTransaction(tx: TransactionSerializable): FrameTransaction {
  const out: FrameTransaction = {}
  for (const f of TX_FIELDS) {
    const v = (tx as Record<string, unknown>)[f]
    if (v !== undefined && v !== null) out[f] = f === 'accessList' ? (v as any[]).map(a => ({ address: a.address, storageKeys: [...a.storageKeys] })) : v
  }
  return out
}

function plainMessage(message: SignableMessage): string | { raw: Hex } {
  if (typeof message === 'string') return message
  const raw = message.raw
  return { raw: typeof raw === 'string' ? raw : bytesToHex(raw) }
}

/**
 * A frame request that may be refused for want of the passcode
 * ("approval-required", lib/walletApproval): ask for it once, then retry.
 */
export async function withApproval<T>(request: () => Promise<T>): Promise<T> {
  try { return await request() } catch (e) {
    if (!(e instanceof WalletFrameError) || e.code !== 'approval-required') throw e
    const { requestWalletApproval } = await import('@/lib/walletApproval')
    if (!(await requestWalletApproval())) throw e
    return request()
  }
}

/** The wallet at `address`, signing through the frame. */
export function walletAccount(address: string): WalletAccount {
  const key = address.toLowerCase()
  const hit = cache.get(key)
  if (hit) return hit
  const base = toAccount({
    address: address as Hex,
    async signMessage({ message }) {
      return (await callWallet('sign:message', { address, message: plainMessage(message) })).signature
    },
    async signTransaction(transaction) {
      return (await withApproval(() => callWallet('sign:transaction', { address, transaction: plainTransaction(transaction) }))).serialized
    },
    async signTypedData(typedData) {
      const { domain, types, primaryType, message } = typedData as TypedDataDefinition
      return (await withApproval(() => callWallet('sign:typed-data', { address, typedData: { domain, types, primaryType, message } as Record<string, unknown> }))).signature
    },
  })
  const account = Object.assign(base, { meshportWallet: true as const }) as WalletAccount
  cache.set(key, account)
  return account
}

export function isWalletAccount(v: unknown): v is WalletAccount {
  return !!v && typeof v === 'object' && (v as any).meshportWallet === true
}

// ── ethers v6 ───────────────────────────────────────────────────────────────
// ethers stays code-split (see blockchain/ProviderManager.ts), so the Signer
// class is built on first use.
let signerClass: Promise<any> | null = null

function ethersSignerClass(): Promise<any> {
  if (signerClass) return signerClass
  signerClass = import('ethers').then(({ AbstractSigner, Transaction, TypedDataEncoder, copyRequest, hexlify, resolveAddress }) => {
    class FrameSigner extends AbstractSigner {
      constructor(readonly account: WalletAccount, provider?: any) { super(provider ?? null) }

      connect(provider: any) { return new FrameSigner(this.account, provider) }

      async getAddress() { return this.account.address }

      async signTransaction(tx: any): Promise<string> {
        // copyRequest, as ethers' Wallet does: sendTransaction passes a Transaction
        // instance, whose fields are getters that a spread would drop.
        const req: any = copyRequest(tx)
        if (req.from) {
          const from = await resolveAddress(req.from, this.provider)
          if (from.toLowerCase() !== this.account.address.toLowerCase()) throw new Error('Transaction from a different address')
          delete req.from
        }
        if (req.to) req.to = await resolveAddress(req.to, this.provider)
        const t = Transaction.from(req)
        const base = {
          chainId: Number(t.chainId), nonce: t.nonce, to: (t.to ?? undefined) as Hex | undefined,
          value: t.value, data: t.data as Hex, gas: t.gasLimit,
        }
        const accessList = t.accessList?.map(a => ({ address: a.address as Hex, storageKeys: a.storageKeys as Hex[] }))
        const viemTx: TransactionSerializable =
          t.type === 2 ? { ...base, type: 'eip1559', maxFeePerGas: t.maxFeePerGas ?? undefined, maxPriorityFeePerGas: t.maxPriorityFeePerGas ?? undefined, accessList }
          : t.type === 1 ? { ...base, type: 'eip2930', gasPrice: t.gasPrice ?? undefined, accessList }
          : { ...base, type: 'legacy', gasPrice: t.gasPrice ?? undefined }
        return this.account.signTransaction(viemTx)
      }

      async signMessage(message: string | Uint8Array): Promise<string> {
        return this.account.signMessage({ message: typeof message === 'string' ? message : { raw: hexlify(message) as Hex } })
      }

      async signTypedData(domain: any, types: Record<string, any[]>, value: Record<string, any>): Promise<string> {
        const { EIP712Domain: _drop, ...rest } = types
        return this.account.signTypedData({
          domain, types: rest, primaryType: TypedDataEncoder.getPrimaryType(rest), message: value,
        } as any)
      }
    }
    return FrameSigner
  })
  return signerClass
}

/** The wallet as an ethers v6 Signer (optionally on a provider). */
export async function toEthersSigner(account: WalletAccount, provider?: any): Promise<any> {
  const FrameSigner = await ethersSignerClass()
  return new FrameSigner(account, provider)
}

// ── Circle App Kit ──────────────────────────────────────────────────────────
// Circle's EthersAdapter re-attaches a `Wallet` signer to each chain's
// provider (getProvider) when it switches chains; any other signer is treated
// as a browser wallet and asked to wallet_switchEthereumChain. This subclass
// gives the frame signer the Wallet behaviour, so broadcasts keep going
// through the same providers (relayed, Arc forwarders) they always did.
// Capabilities come from Circle's own factory, so they match its defaults.
let adapterClass: Promise<any> | null = null

function frameAdapterClass(): Promise<any> {
  if (adapterClass) return adapterClass
  adapterClass = import('@circle-fin/adapter-ethers-v6').then(({ EthersAdapter }) => {
    class FrameEthersAdapter extends (EthersAdapter as any) {
      async switchToChain(chain: any) {
        if (chain?.type !== 'evm') throw new Error(`EthersAdapter can only switch to EVM chains. Received: ${String(chain?.type)} (${chain?.name})`)
        const current = (this as any).getSigner()
        try {
          const network = await current?.provider?.getNetwork()
          if (network && network.chainId === BigInt(chain.chainId)) return
        } catch { /* re-attach below */ }
        const provider = await (this as any).getProvider(chain)
        // Same field Circle's own Wallet branch assigns (adapter-ethers-v6 1.9.x).
        ;(this as any)._signer = current.connect(provider)
      }
    }
    return FrameEthersAdapter
  })
  return adapterClass
}

function addressOnlyProvider(address: string) {
  return {
    async request({ method }: { method: string }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address]
      if (method === 'eth_chainId') return '0x1'
      throw new Error(`${method} is not available here`)
    },
  }
}

export async function createWalletAdapter(opts: { account: WalletAccount; getProvider?: (p: { chain: any }) => any; capabilities?: any }): Promise<any> {
  const [{ createEthersAdapterFromProvider }, FrameEthersAdapter, signer] = await Promise.all([
    import('@circle-fin/adapter-ethers-v6'), frameAdapterClass(), toEthersSigner(opts.account),
  ])
  const template: any = await createEthersAdapterFromProvider({
    provider: addressOnlyProvider(opts.account.address) as any,
    getProvider: opts.getProvider as any,
    capabilities: opts.capabilities,
  })
  try { template.getSigner()?.provider?.destroy?.() } catch { /* */ }
  return new FrameEthersAdapter({ getProvider: template.options.getProvider, signer }, template.capabilities)
}
