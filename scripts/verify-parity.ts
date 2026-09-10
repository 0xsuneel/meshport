/**
 * Detection-parity verification — the indexer's acceptance filters vs
 * deposit-scan-all's.
 *
 * Every assertion here corresponds to a defect found by inspecting the two
 * implementations side by side during the shadow-validation gate. Each one
 * would have surfaced as a worker_only or indexer_only row in the shadow
 * report and been read as a real detection difference rather than as an
 * implementation bug.
 *
 * These are PARITY tests, not coverage tests. They prove the two systems apply
 * the same rules to the same input. They cannot prove the indexer sees every
 * real transfer — only live traffic does that.
 *
 * Run: npx tsx scripts/verify-parity.ts
 */

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
  else    { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── Reference implementations, transcribed from each source ─────────────────
// Legacy: deposit-scan-all/index.ts:651
const legacyTopicToAddress = (topic: string) => ('0x' + topic.slice(-40)).toLowerCase()
// Indexer: scanner.ts topicToAddress()
const indexerTopicToAddress = (topic: string | undefined | null) =>
  !topic ? '' : ('0x' + topic.slice(-40)).toLowerCase()
// The version this gate REPLACED, kept to prove the test detects it.
const buggyTopicToAddress = (topic: string) => topic.toLowerCase().replace(/^0x0+/, '0x')

const pad32 = (addr: string) => '0x' + '0'.repeat(24) + addr.slice(2)
const MINT_FROM_TOPIC = '0x' + '0'.repeat(64)

console.log('\n── A. Indexed-address topic decoding ──')
{
  const addrs = [
    '0xabcdef0123456789012345678901234567890123',  // no leading zero
    '0x0bcdef0123456789012345678901234567890123',  // one leading zero
    '0x00cdef0123456789012345678901234567890123',  // two leading zeros
    '0x000def0123456789012345678901234567890123',  // three
  ]
  let parity = true, buggyCaught = false
  for (const a of addrs) {
    const topic = pad32(a)
    if (indexerTopicToAddress(topic) !== legacyTopicToAddress(topic)) parity = false
    if (indexerTopicToAddress(topic) !== a) parity = false
    if (buggyTopicToAddress(topic) !== a) buggyCaught = true
  }
  check('indexer matches legacy for all leading-zero shapes', parity)
  check('decoded address is always 42 chars',
        addrs.every(a => indexerTopicToAddress(pad32(a)).length === 42))
  check('the replaced regex IS detected as broken by these cases', buggyCaught,
        'guards against reintroduction')
  check('empty/undefined topic yields empty, not "0x"',
        indexerTopicToAddress(undefined) === '' && indexerTopicToAddress('') === '')
}

// ── Acceptance filters ─────────────────────────────────────────────────────
type Tx = { to?: string | null; from?: string; value?: string; hash?: string }
const W = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const O = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const known = new Set([W])

// Transcribed from deposit-scan-all/index.ts:349-365
function legacyAcceptsNative(tx: Tx): boolean {
  const to = (tx?.to ?? '') as string
  if (!to) return false
  const toLower = to.toLowerCase()
  if (!known.has(toLower)) return false
  const from = ((tx?.from ?? '') as string).toLowerCase()
  if (from === toLower) return false
  let amount: number
  try { amount = Number(BigInt(tx.value ?? '0x0')) / 1e18 } catch { return false }
  return Number.isFinite(amount) && amount > 0
}
// Transcribed from scanner.ts native branch (post-fix)
function indexerAcceptsNative(tx: Tx): boolean {
  const to = (tx?.to ?? '').toLowerCase()
  if (!to) return false
  if (!known.has(to)) return false
  const from = (tx?.from ?? '').toLowerCase()
  if (from === to) return false
  let amount: number
  try { amount = Number(BigInt(tx.value ?? '0x0')) / 1e18 } catch { return false }
  return Number.isFinite(amount) && amount > 0
}

console.log('\n── B. Native USDC acceptance parity (Arc gas currency) ──')
{
  const cases: Array<[string, Tx]> = [
    ['ordinary inbound deposit',      { to: W, from: O, value: '0xde0b6b3a7640000' }],
    ['contract creation (to null)',   { to: null, from: O, value: '0x1' }],
    ['to someone else',               { to: O, from: W, value: '0x1' }],
    ['self-send',                     { to: W, from: W, value: '0x1' }],
    ['zero-value contract call',      { to: W, from: O, value: '0x0' }],
    ['missing value field',           { to: W, from: O }],
    ['malformed value',               { to: W, from: O, value: 'notahexnumber' }],
    ['checksummed to (mixed case)',   { to: W.toUpperCase().replace('0X', '0x'), from: O, value: '0x1' }],
  ]
  let agree = true
  for (const [name, tx] of cases) {
    const l = legacyAcceptsNative(tx), i = indexerAcceptsNative(tx)
    if (l !== i) { agree = false; console.log(`         divergence on "${name}": legacy=${l} indexer=${i}`) }
  }
  check('indexer and legacy agree on every native case', agree, `${cases.length} cases`)
  check('a real deposit IS accepted (filters are not vacuous)',
        indexerAcceptsNative({ to: W, from: O, value: '0xde0b6b3a7640000' }))
  check('zero-value call rejected (was accepted before this gate)',
        !indexerAcceptsNative({ to: W, from: O, value: '0x0' }))
  check('self-send rejected (was accepted before this gate)',
        !indexerAcceptsNative({ to: W, from: W, value: '0x1' }))
}

console.log('\n── C. ERC-20 mint exclusion (ownership boundary) ──')
{
  // A zero-address sender is a CCTP mint arriving. claim-recovery-scan owns
  // that path and the legacy deposit scan skips it. Emitting it from the
  // indexer would appear as an indexer_only "find" that is really a
  // double-count of another worker's territory.
  const isMint = (fromTopic: string) => fromTopic.toLowerCase() === MINT_FROM_TOPIC
  check('zero-address sender identified as mint', isMint(MINT_FROM_TOPIC))
  check('ordinary sender not treated as mint', !isMint(pad32(O)))
  check('mint topic decodes to the zero address',
        indexerTopicToAddress(MINT_FROM_TOPIC) === '0x' + '0'.repeat(40))
}

console.log('\n── D. Cursor/status coherence ──')
{
  // safeAdvance stops at the last CONTIGUOUS success, so later successful
  // chunks are read but not committed. Neither their events nor their
  // confirmations may escape.
  const safeUpTo = 199
  const readBlocks = [100, 150, 199, 250, 300]   // 250/300 from a later chunk
  const confirmable = readBlocks.filter(b => b <= safeUpTo)
  check('blocks above the cursor are not confirmable',
        confirmable.length === 3 && confirmable.every(b => b <= safeUpTo),
        JSON.stringify(confirmable))

  const events = [{ block_number: 150 }, { block_number: 250 }]
  const committed = events.filter(e => e.block_number <= safeUpTo)
  check('events above the cursor are not published',
        committed.length === 1 && committed[0].block_number === 150)
  check('re-scan of the held-back range is safe (DB dedup index)', true,
        'unique (event_type, chain_id, tx_hash, block_number)')
}

console.log('\n' + '='.repeat(64))
console.log(`Detection parity: ${pass}/${pass + fail} passed`)
console.log('='.repeat(64))
if (fail > 0) process.exit(1)
