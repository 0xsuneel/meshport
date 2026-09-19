// supabase/functions/blockchain-indexer/decodeTransferLog.test.ts
import { decodeTransferLog, isMintTransfer, isSelfTransfer } from './decodeTransferLog.ts'

function assert(cond: boolean, msg = ''): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (actual !== expected) throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
}

const CONTRACT = '0xTokenContract'
const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const SENDER = '0xca11bde05977b3631167028862be2a173976ca11'
const pad32 = (addr: string) => '0x' + addr.replace(/^0x/, '').padStart(64, '0')
const ZERO_TOPIC = '0x' + '0'.repeat(64)

function makeLog(overrides: Record<string, unknown> = {}) {
  return {
    topics: [ZERO_TOPIC, pad32(SENDER), pad32(WALLET)],
    data: '0x' + (10_000_000).toString(16),
    transactionHash: '0xTxHash',
    blockNumber: '0x64',
    logIndex: '0x5',
    blockHash: '0xBlockHash',
    transactionIndex: '0x1',
    ...overrides,
  }
}

Deno.test('decodeTransferLog: native-shaped log (18 decimals) decodes correctly', () => {
  const log = makeLog({ data: '0x' + (5_000_000_000_000_000_000n).toString(16) })
  const decoded = decodeTransferLog(log, 18, CONTRACT)
  assert(decoded !== null, 'expected a decoded result')
  assertEquals(decoded!.amount, 5)
  assertEquals(decoded!.wallet, WALLET)
  assertEquals(decoded!.from, SENDER)
})

Deno.test('decodeTransferLog: ERC-20-shaped log (6 decimals) decodes correctly', () => {
  const log = makeLog({ data: '0x' + (10_000_000).toString(16) })
  const decoded = decodeTransferLog(log, 6, CONTRACT)
  assert(decoded !== null)
  assertEquals(decoded!.amount, 10)
  assertEquals(decoded!.contractAddress, CONTRACT)
})

Deno.test('decodeTransferLog: 3 distinct BulkPay-shaped logs (same tx, different log_index/wallet) all decode independently', () => {
  const wallets = ['0xWalletA', '0xWalletB', '0xWalletC']
  const decoded = wallets.map((w, i) => decodeTransferLog(
    makeLog({ topics: [ZERO_TOPIC, pad32(SENDER), pad32(w)], logIndex: '0x' + i.toString(16), transactionHash: '0xBulkTx' }),
    18, CONTRACT,
  ))
  assert(decoded.every(d => d !== null), 'all three logs should decode')
  const logIndexes = decoded.map(d => d!.logIndex)
  assertEquals(new Set(logIndexes).size, 3, 'all three log_index values must be distinct')
  const txHashes = new Set(decoded.map(d => d!.txHash))
  assertEquals(txHashes.size, 1, 'all three logs share the same tx_hash')
})

Deno.test('decodeTransferLog: same wallet receiving two separate logs in one tx decode as two distinct results (log_index differs)', () => {
  const first = decodeTransferLog(makeLog({ logIndex: '0xa', transactionHash: '0xSameTx' }), 6, CONTRACT)
  const second = decodeTransferLog(makeLog({ logIndex: '0xb', transactionHash: '0xSameTx' }), 6, CONTRACT)
  assert(first !== null && second !== null)
  assertEquals(first!.txHash, second!.txHash)
  assert(first!.logIndex !== second!.logIndex, 'log_index must differ even though wallet/tx are identical')
})

Deno.test('decodeTransferLog: no recipient topic -> null, never throws', () => {
  const decoded = decodeTransferLog(makeLog({ topics: [ZERO_TOPIC, pad32(SENDER)] }), 6, CONTRACT)
  assertEquals(decoded, null)
})

Deno.test('decodeTransferLog: unparseable data -> null, never throws', () => {
  const decoded = decodeTransferLog(makeLog({ data: 'not-hex' }), 6, CONTRACT)
  assertEquals(decoded, null)
})

Deno.test('decodeTransferLog: zero amount -> null', () => {
  const decoded = decodeTransferLog(makeLog({ data: '0x0' }), 6, CONTRACT)
  assertEquals(decoded, null)
})

Deno.test('isMintTransfer: zero-address sender topic is a mint', () => {
  const decoded = decodeTransferLog(makeLog({ topics: [ZERO_TOPIC, ZERO_TOPIC, pad32(WALLET)] }), 6, CONTRACT)
  assert(decoded !== null)
  assert(isMintTransfer(decoded!))
})

Deno.test('isMintTransfer: ordinary sender is not a mint', () => {
  const decoded = decodeTransferLog(makeLog(), 6, CONTRACT)
  assert(decoded !== null)
  assert(!isMintTransfer(decoded!))
})

Deno.test('isSelfTransfer: sender === recipient', () => {
  const decoded = decodeTransferLog(makeLog({ topics: [ZERO_TOPIC, pad32(WALLET), pad32(WALLET)] }), 6, CONTRACT)
  assert(decoded !== null)
  assert(isSelfTransfer(decoded!))
})

Deno.test('isSelfTransfer: ordinary transfer is not a self-transfer', () => {
  const decoded = decodeTransferLog(makeLog(), 6, CONTRACT)
  assert(decoded !== null)
  assert(!isSelfTransfer(decoded!))
})
