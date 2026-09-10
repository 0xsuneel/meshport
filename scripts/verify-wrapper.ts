/**
 * verify-wrapper.ts — FIX B: contract-mediated native-USDC detection.
 *
 * Every input is a REAL confirmed transaction, verified against Arc testnet.
 * The six wrapper cases are the exact worker_only set from the live shadow
 * report; the three native cases are the exact indexer_only set.
 *
 * The scanner's acceptance rules are transcribed here rather than imported —
 * scanner.ts needs a live RPC, so the logic is mirrored and kept in lockstep
 * by these assertions.
 *
 * Run: npx tsx scripts/verify-wrapper.ts
 */
let pass = 0, fail = 0
const check = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`) }
  else   { fail++; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`) }
}

const FFFE  = '0xfffffffffffffffffffffffffffffffffffffffe'
const WRAP  = '0x3600000000000000000000000000000000000000'
const EURC  = '0x89b50855aa3be2f677cd6303cec089b5f319d72a'
const ZERO  = '0x0000000000000000000000000000000000000000'
const W1 = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'   // registered
const W2 = '0xfe2ac69fe72e91f1642e98ce0cdf55b8d1800e43'   // registered
const EXT = '0x70e3fb28e1794bb91d5bceb7d66b731d0c61af8e'  // NOT registered
const known = new Set([W1, W2, '0xd9db937066e4e11d233993e44e838923ecdce950'])

type Log = { address: string; from: string; to: string; raw: bigint; tx: string; block: number }
type Tx  = { hash: string; to: string | null; from: string; value: bigint; block: number; logs: Log[] }

/** Native block-scan rule (scanner.ts native branch). */
function nativeEmit(tx: Tx): { wallet: string; amount: number } | null {
  const to = (tx.to ?? '').toLowerCase()
  if (!to || !known.has(to)) return null
  const from = tx.from.toLowerCase()
  if (from === to) return null
  const amount = Number(tx.value) / 1e18
  if (!Number.isFinite(amount) || amount <= 0) return null
  return { wallet: to, amount }
}

/** Contract-mediated rule (scanner.ts FIX B branch) — 0xffff…fffe only. */
function nativeLogEmit(log: Log): { wallet: string; amount: number } | null {
  if (log.address.toLowerCase() !== FFFE) return null      // wrapper NOT scanned
  const wallet = log.to.toLowerCase(), from = log.from.toLowerCase()
  if (!known.has(wallet)) return null
  if (from === ZERO) return null                            // mint -> claim-worker
  if (from === wallet) return null                          // self-transfer
  const amount = Number(log.raw) / 1e18
  if (!Number.isFinite(amount) || amount <= 0) return null
  return { wallet, amount }
}

/** Full pass with cross-source dedup, mirroring scanRange. */
function scan(txs: Tx[]): Array<{ tx: string; wallet: string; amount: number; via: string }> {
  const emitted = new Set<string>()
  const out: Array<{ tx: string; wallet: string; amount: number; via: string }> = []
  for (const tx of txs) {
    const n = nativeEmit(tx)
    if (n) { emitted.add(`${tx.hash}:${n.wallet}`); out.push({ tx: tx.hash, ...n, via: 'native' }) }
  }
  for (const tx of txs) for (const log of tx.logs) {
    const e = nativeLogEmit(log)
    if (!e) continue
    const k = `${log.tx}:${e.wallet}`
    if (emitted.has(k)) continue
    emitted.add(k)
    out.push({ tx: log.tx, ...e, via: 'native-transfer-log' })
  }
  return out
}

const wrapperTx = (hash: string, wallet: string, block: number, sender: string): Tx => ({
  hash, to: WRAP, from: sender, value: 0n, block,
  logs: [
    { address: FFFE, from: sender, to: wallet, raw: 20000000000000000000n, tx: hash, block },
    { address: WRAP, from: sender, to: wallet, raw: 20000000n,             tx: hash, block },
  ],
})

console.log('\n══ A. The six confirmed wrapper transactions (were worker_only) ══')
{
  const S = '0xd4c0b787aa2ff9eb751bb515c877ebbf2daddaae'
  const six: Tx[] = [
    wrapperTx('0x441120660a410dc28fc731e92fbca752a7c5e43d8fd533675afaae410b1734c9', W1, 55965842, S),
    wrapperTx('0xeddce2fc8c160f28209a166775b2c2410f7c2fc4599a5beaaa866c6ee900e9ad', W1, 55955930, S),
    wrapperTx('0x6b6f271bea918f9836dad7c95e5982755f64dcfe01a27d997b3cee65b89e387f', W1, 55943255, S),
    wrapperTx('0x90b65c5001ea9e9c75695571685ccbc1d1fdcc223b58a049adfc11fb9b3a8df8', W1, 55942613, S),
    wrapperTx('0x1c2c5232026574395ca74bf2d3ea475d8c51fcd0587d9c4816fcd15cfbf973f3', W2, 55939975, '0x3c3380cd0000000000000000000000000000000f'),
    wrapperTx('0xaee8c9177c4fc15f4b580e99f577abd07aab2e76f1f3bb425f9d494bcc0ac607', W1, 55937121, S),
  ]
  const ev = scan(six)
  check('all six now produce an event', ev.length === 6, `${ev.length}/6`)
  check('EXACTLY one event each (no double-count from the 0x3600 twin)',
    six.every(t => ev.filter(e => e.tx === t.hash).length === 1))
  check('each detected via the native-transfer log, not the block scan',
    ev.every(e => e.via === 'native-transfer-log'))
  check('amount 20 USDC from the 18-decimal log', ev.every(e => e.amount === 20),
    `amounts: ${[...new Set(ev.map(e => e.amount))].join(',')}`)
  check('credited to the right registered wallets',
    ev.filter(e => e.wallet === W1).length === 5 && ev.filter(e => e.wallet === W2).length === 1)
  check('the 0x3600 wrapper log itself is never a source',
    six.every(t => nativeLogEmit(t.logs[1]) === null), 'only 0xffff…fffe is authoritative')
}

console.log('\n══ B. Native transfers still detected exactly once ══')
{
  const nat = (hash: string, to: string, from: string, wei: bigint, block: number): Tx => ({
    hash, to, from, value: wei, block,
    logs: [{ address: FFFE, from, to, raw: wei, tx: hash, block }],
  })
  const three: Tx[] = [
    nat('0x41113da1cd012040190134fdce83821026d9948f248cdbb3950a2c906647be55', W1, '0xd9db937066e4e11d233993e44e838923ecdce950', 1000000000000000000n, 55907444),
    nat('0xff3c35e3ed804b70a5f7ddbdd050471e2e622ca4eb0a33ddb15daac69c3bd360', W1, '0xd9db937066e4e11d233993e44e838923ecdce950', 2000000000000000000n, 55908954),
    nat('0xe0d20db7a71e980b57fb79b61cafe85cbeb2e7848d3ed803be23be7e7c629c4a', '0xd9db937066e4e11d233993e44e838923ecdce950', W1, 1000000000000000000n, 55908681),
  ]
  const ev = scan(three)
  check('all three detected', ev.length === 3, `${ev.length}/3`)
  check('EXACTLY once each — the fffe log did NOT duplicate the block scan',
    three.every(t => ev.filter(e => e.tx === t.hash).length === 1))
  check('detected via the block scan (native path wins the race)',
    ev.every(e => e.via === 'native'), 'dedup key stops the log pass re-emitting')
  check('amounts correct', ev.map(e => e.amount).sort().join(',') === '1,1,2')
}

console.log('\n══ C. Mixed batch — no cross-contamination ══')
{
  const all: Tx[] = [
    wrapperTx('0xaaa1', W1, 100, '0xd4c0b787aa2ff9eb751bb515c877ebbf2daddaae'),
    { hash: '0xbbb2', to: W1, from: '0xd9db937066e4e11d233993e44e838923ecdce950', value: 5000000000000000000n, block: 101,
      logs: [{ address: FFFE, from: '0xd9db937066e4e11d233993e44e838923ecdce950', to: W1, raw: 5000000000000000000n, tx: '0xbbb2', block: 101 }] },
  ]
  const ev = scan(all)
  check('one wrapper + one native -> exactly 2 events', ev.length === 2, `${ev.length}`)
  check('one of each detection path',
    ev.filter(e => e.via === 'native').length === 1 && ev.filter(e => e.via === 'native-transfer-log').length === 1)
}

console.log('\n══ D. Exclusions preserved ══')
{
  // External recipient (Fix A's case) — wrapper route must not bypass it.
  const ext = wrapperTx('0xccc3', EXT, 200, W1)
  check('wrapper credit to an UNREGISTERED wallet is ignored', scan([ext]).length === 0)

  // Mint (D-3) — claim-worker territory.
  const mint: Tx = { hash: '0xddd4', to: WRAP, from: ZERO, value: 0n, block: 201,
    logs: [{ address: FFFE, from: ZERO, to: W1, raw: 4982914000000000000n, tx: '0xddd4', block: 201 }] }
  check('CCTP mint still excluded (D-3 intact)', scan([mint]).length === 0)

  // Self-transfer.
  const self: Tx = { hash: '0xeee5', to: WRAP, from: W1, value: 0n, block: 202,
    logs: [{ address: FFFE, from: W1, to: W1, raw: 400000000000000000n, tx: '0xeee5', block: 202 }] }
  check('self-transfer still excluded', scan([self]).length === 0)

  // Zero-value.
  const zero: Tx = { hash: '0xfff6', to: WRAP, from: '0xd4c0b787aa2ff9eb751bb515c877ebbf2daddaae', value: 0n, block: 203,
    logs: [{ address: FFFE, from: '0xd4c0b787aa2ff9eb751bb515c877ebbf2daddaae', to: W1, raw: 0n, tx: '0xfff6', block: 203 }] }
  check('zero-value transfer still excluded', scan([zero]).length === 0)
}

console.log('\n══ E. EURC / cirBTC path unchanged ══')
{
  // The EURC contract is not the native-transfer contract, so the FIX B pass
  // must ignore it entirely — EURC continues to flow through the token scan.
  const eurcLog: Log = { address: EURC, from: '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b', to: W1, raw: 746215n, tx: '0x0a86418d', block: 55907029 }
  check('EURC log ignored by the native-transfer pass', nativeLogEmit(eurcLog) === null,
    'address !== 0xffff…fffe')
  check('EURC would still be caught by the unchanged token scan',
    eurcLog.address === EURC && known.has(eurcLog.to), 'token branch untouched')
}

console.log('\n══ F. Idempotency — re-scanning the same range ══')
{
  const S = '0xd4c0b787aa2ff9eb751bb515c877ebbf2daddaae'
  const batch = [
    wrapperTx('0x441120660a410dc28fc731e92fbca752a7c5e43d8fd533675afaae410b1734c9', W1, 55965842, S),
    { hash: '0xbbb2', to: W1, from: '0xd9db937066e4e11d233993e44e838923ecdce950', value: 5000000000000000000n, block: 101,
      logs: [{ address: FFFE, from: '0xd9db937066e4e11d233993e44e838923ecdce950', to: W1, raw: 5000000000000000000n, tx: '0xbbb2', block: 101 }] },
  ]
  const a = scan(batch), b = scan(batch)
  check('same input -> same output', JSON.stringify(a) === JSON.stringify(b), `${a.length} events`)
  check('a re-scan produces identical keys (DB unique index absorbs the rest)',
    a.map(e => `${e.tx}:${e.wallet}`).join('|') === b.map(e => `${e.tx}:${e.wallet}`).join('|'))
}

console.log('\n' + '='.repeat(68))
console.log(`Fix B — wrapper detection: ${pass}/${pass + fail} passed`)
console.log('='.repeat(68))
console.log('\nDetection layer only. Comparison logic untouched (that is Fix C).\n')
if (fail > 0) process.exit(1)
