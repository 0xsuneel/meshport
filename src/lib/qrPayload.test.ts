import { describe, it, expect } from 'vitest'
import { parseEip681, classifyForeignQr, chainNameOf } from './qrPayload'
import { merchantPaymentUri, arcAddressUri, MERCHANT_QR_EXTERNAL } from './merchantQr'

const TO = '0xa58fd2ffb361329AbF573a555BF0835A75d95294'
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const BASE_USDC_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'

describe('parseEip681', () => {
  it('reads MeshPort\'s own Arc request QR (native USDC, 18 decimals)', () => {
    expect(parseEip681(merchantPaymentUri('Arc_Testnet', TO, 20.6))).toEqual({ to: TO, chainId: 5042002, amount: '20.6' })
  })

  it('reads MeshPort\'s own merchant QR on another network (USDC transfer)', () => {
    const c = MERCHANT_QR_EXTERNAL[0]
    expect(parseEip681(merchantPaymentUri(c.id, TO, 12.5))).toEqual({ to: TO, chainId: c.chainId, amount: '12.5' })
  })

  it('reads a plain address QR with a network and no amount', () => {
    expect(parseEip681(arcAddressUri(TO))).toEqual({ to: TO, chainId: 5042002, amount: null })
  })

  it('reads mainnet USDC requests from other wallets', () => {
    expect(parseEip681(`ethereum:${BASE_USDC_MAINNET}@8453/transfer?address=${TO}&uint256=5e6`))
      .toEqual({ to: TO, chainId: 8453, amount: '5' })
  })

  it('never reads another token\'s amount as USDC (DAI has 18 decimals)', () => {
    // 5 DAI = 5e18 - read as 6-decimal USDC that was 5,000,000,000,000.
    expect(parseEip681(`ethereum:${DAI}@1/transfer?address=${TO}&uint256=5e18`))
      .toEqual({ to: TO, chainId: 1, amount: null })
  })

  it('never reads ETH on Ethereum as USDC', () => {
    expect(parseEip681(`ethereum:${TO}@1?value=1e16`)).toEqual({ to: TO, chainId: 1, amount: null })
  })

  it('keeps the amount of an old QR that names no network', () => {
    expect(parseEip681(`ethereum:${TO}?value=2500000000000000000`)).toEqual({ to: TO, chainId: null, amount: '2.5' })
  })

  it('never pays the token contract when a transfer names no recipient', () => {
    expect(parseEip681(`ethereum:${BASE_USDC_MAINNET}@8453/transfer?uint256=5e6`))
      .toEqual({ to: null, chainId: 8453, amount: '5' })
  })

  it('reads pay- prefixed URIs, upper case and MetaMask send links', () => {
    expect(parseEip681(`ETHEREUM:pay-${TO}@5042002`)?.to).toBe(TO)
    expect(parseEip681(`https://metamask.app.link/send/${TO}@5042002?value=1e18`)).toEqual({ to: TO, chainId: 5042002, amount: '1' })
  })

  it('is null for anything that isn\'t a payment URI', () => {
    expect(parseEip681(TO)).toBeNull()
    expect(parseEip681('ethereum:not-an-address')).toBeNull()
    expect(parseEip681('https://meshport.xyz/paylink/sunil')).toBeNull()
  })
})

describe('classifyForeignQr', () => {
  it('finds Solana wallets: bare address and Solana Pay', () => {
    expect(classifyForeignQr(SOL)).toEqual({ kind: 'solana', address: SOL })
    expect(classifyForeignQr(`solana:${SOL}?amount=1.5&label=Shop`)).toEqual({ kind: 'solana', address: SOL })
  })

  it('names codes MeshPort can\'t pay instead of looking them up as usernames', () => {
    for (const code of [
      'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      'bitcoin:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2?amount=0.01',
      'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      'upi://pay?pa=shop@okaxis&pn=Shop',
      'wc:7f6e504bfad60b485450578e05678ed3e8e8c4751d3c6160be17160d63ec90f9@2?relay-protocol=irn&symKey=abc',
      'litecoin:LcHKx3Yy6q',
      'https://example.com/menu',
    ]) {
      expect(classifyForeignQr(code)?.kind, code).toBe('unsupported')
    }
    expect(classifyForeignQr('https://example.com/menu')).toEqual({ kind: 'unsupported', message: 'This QR is a link to example.com, not a payment QR.' })
  })

  it('leaves EVM addresses, MeshPort links and usernames to the scanner', () => {
    for (const code of [TO, `ethereum:${TO}`, 'https://meshport.xyz/paylink/sunil?amount=5', 'sunil.arc', 'sunil']) {
      expect(classifyForeignQr(code), code).toBeNull()
    }
  })
})

describe('chainNameOf', () => {
  it('names MeshPort\'s networks and the main ones', () => {
    expect(chainNameOf(5042002)).toBe('Arc')
    expect(chainNameOf(8453)).toBe('Base')
    expect(chainNameOf(999999)).toBeNull()
  })
})
