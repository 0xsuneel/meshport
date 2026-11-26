import { assertEquals, assert } from 'jsr:@std/assert@1'
import { toChainEvent, validSignature, ALCHEMY_NETWORKS } from './lib.ts'
import { INDEXED_CHAINS } from '../blockchain-indexer/chains.ts'

const arc = INDEXED_CHAINS.find(c => c.id === 'arc')!
const sepolia = INDEXED_CHAINS.find(c => c.id === 'ethereum-sepolia')!
const USER = '0x00000000000000000000000000000000000000aa'
const OTHER = '0x00000000000000000000000000000000000000bb'

Deno.test('every mapped network is a known chain', () => {
  for (const id of Object.values(ALCHEMY_NETWORKS)) assert(INDEXED_CHAINS.some(c => c.id === id), id)
})

Deno.test('Sepolia USDC transfer -> transfer_detected with exact amount', () => {
  const r = toChainEvent(sepolia, {
    blockNum: '0x10', hash: '0xAB', fromAddress: OTHER, toAddress: USER, category: 'token',
    rawContract: { rawValue: '0x' + (2_500_000).toString(16), address: sepolia.tokens[0].contract, decimals: 6 },
    log: { logIndex: '0x3', blockHash: '0xCD', transactionIndex: '0x1' },
  })!
  assertEquals(r.event_type, 'transfer_detected')
  assertEquals(r.wallet_address, USER)
  assertEquals(r.tx_hash, '0xab')
  assertEquals((r.metadata as any).amount, 2.5)
  assertEquals((r.metadata as any).from, OTHER)
  assertEquals(r.log_index, 3)
  assertEquals(r.block_number, 16)
  assertEquals(r.assets, ['USDC'])
})

Deno.test('untracked token, self-transfer and zero amount are ignored', () => {
  assertEquals(toChainEvent(sepolia, { hash: '0x1', fromAddress: OTHER, toAddress: USER, category: 'token',
    rawContract: { rawValue: '0x10', address: '0x1111111111111111111111111111111111111111', decimals: 6 } }), null)
  assertEquals(toChainEvent(sepolia, { hash: '0x1', fromAddress: USER, toAddress: USER, category: 'token',
    rawContract: { rawValue: '0x10', address: sepolia.tokens[0].contract, decimals: 6 } }), null)
  assertEquals(toChainEvent(sepolia, { hash: '0x1', fromAddress: OTHER, toAddress: USER, category: 'token',
    rawContract: { rawValue: '0x0', address: sepolia.tokens[0].contract, decimals: 6 } }), null)
})

Deno.test('Arc native USDC value transfer -> deposit_detected', () => {
  const r = toChainEvent(arc, { blockNum: '0x5', hash: '0xEE', fromAddress: OTHER, toAddress: USER, category: 'external', value: 1.25, rawContract: { address: null } })!
  assertEquals(r.event_type, 'deposit_detected')
  assertEquals((r.metadata as any).amount, 1.25)
  assertEquals(r.log_index, null)
})

Deno.test('Arc native USDC Transfer log -> deposit_detected; mint skipped', () => {
  const raw = '0x' + (3n * 10n ** 18n).toString(16)
  const r = toChainEvent(arc, { hash: '0xEE', fromAddress: OTHER, toAddress: USER, category: 'token',
    rawContract: { rawValue: raw, address: arc.nativeTransferLogContract, decimals: 18 }, log: { logIndex: '0x0' } })!
  assertEquals(r.event_type, 'deposit_detected')
  assertEquals((r.metadata as any).amount, 3)
  assertEquals(toChainEvent(arc, { hash: '0xEE', fromAddress: '0x0000000000000000000000000000000000000000', toAddress: USER, category: 'token',
    rawContract: { rawValue: raw, address: arc.nativeTransferLogContract, decimals: 18 } }), null)
})

Deno.test('signature: HMAC-SHA256 hex of the raw body with any configured key', async () => {
  const body = '{"a":1}'
  const key = 'whsec_test'
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body)))).map(b => b.toString(16).padStart(2, '0')).join('')
  assert(await validSignature(body, sig, ['other', key]))
  assert(!(await validSignature(body, sig, ['other'])))
  assert(!(await validSignature(body + ' ', sig, [key])))
  assert(!(await validSignature(body, '', [key])))
})
