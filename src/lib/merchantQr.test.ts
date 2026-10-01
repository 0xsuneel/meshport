import { describe, it, expect } from 'vitest'
import { merchantPaymentUri } from './merchantQr'

describe('merchant QR (EIP-681)', () => {
  it('ERC-20 USDC on Base', () => {
    expect(merchantPaymentUri('Base_Sepolia', '0xa58fd2ffb361329abf573a555bf0835a75d95294', 12.5))
      .toBe('ethereum:0x036CbD53842c5426634e7929541eC2318f3dCF7e@84532/transfer?address=0xa58fd2ffb361329AbF573a555BF0835A75d95294&uint256=12500000')
  })
  it('native USDC on Arc', () => {
    expect(merchantPaymentUri('Arc_Testnet', '0xa58fd2ffb361329abf573a555bf0835a75d95294', 20.6))
      .toBe('ethereum:0xa58fd2ffb361329AbF573a555BF0835A75d95294@5042002?value=20600000000000000000')
  })
})

describe('MeshPort request QR', () => {
  it('only address + amount + network — no link', async () => {
    const { meshportRequestQr, arcAddressUri } = await import('./merchantQr')
    const qr = meshportRequestQr('Arc_Testnet', '0xa58fd2ffb361329abf573a555bf0835a75d95294', 12.5)
    expect(qr).toBe('ethereum:0xa58fd2ffb361329AbF573a555BF0835A75d95294@5042002?value=12500000000000000000')
    expect(qr).not.toContain('link')
    expect(arcAddressUri('0xa58fd2ffb361329abf573a555bf0835a75d95294')).toBe('ethereum:0xa58fd2ffb361329AbF573a555BF0835A75d95294@5042002')
  })
})
