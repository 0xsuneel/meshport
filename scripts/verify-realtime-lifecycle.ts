/**
 * verify-realtime-lifecycle.ts — subscribeWithRetry lifecycle (chatService.ts).
 *
 * Reproduces the production failure of 2026-08-20: opening the Activity page
 * produced ~844 repeated warnings
 *
 *   [Realtime] activity:0x05d0…26e0 dropped (CLOSED) — reconnecting in 25504ms
 *
 * followed by
 *
 *   Uncaught (in promise) RangeError: Maximum call stack size exceeded
 *     at Array.filter / trigger / leave / unsubscribe
 *
 * ROOT CAUSE. client.removeChannel() synchronously calls channel.unsubscribe(),
 * which inside supabase-js runs leave() -> trigger() and re-invokes the SAME
 * status callback with 'CLOSED'. The terminal branch then called
 * removeChannel() again on the same dying channel -> unbounded synchronous
 * recursion.
 *
 * The tell was every warning quoting the SAME delay: the backoff advance sits
 * after removeChannel(), so it never ran until the recursion unwound and each
 * nested frame read the same stale value. Section B asserts that too — a
 * regression reappears as identical delays.
 *
 * ── Why the state machine is transcribed rather than imported ───────────────
 * chatService.ts reads import.meta.env at module scope, so it cannot be loaded
 * under tsx's CJS output. Same approach as verify-cursor-stall.ts, which
 * transcribes scanner.ts's cursor rule for the same reason.
 *
 * Because a transcription can drift from production, Section E asserts against
 * the REAL chatService.ts source text: the guard, the detach-before-remove and
 * the deferred removal must all be present, and the old recursive line must be
 * absent. So this suite cannot pass while the shipped code lacks the fix.
 *
 * Run: npx tsx scripts/verify-realtime-lifecycle.ts
 */
import * as fs from 'fs'
import * as path from 'path'

let pass = 0, fail = 0
const check = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`) }
  else   { fail++; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`) }
}

const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'lib', 'chatService.ts'), 'utf8')

/* ── The FIXED state machine, transcribed from chatService.ts ──────────────── */

interface Ch { name: string; cb: ((s: string) => void) | null }

function makeHarness() {
  const created: Ch[] = []
  const removed: string[] = []
  const warns: string[] = []
  const microtasks: Array<() => void> = []
  let depth = 0, maxDepth = 0

  const client = {
    channel(name: string): Ch {
      const ch: Ch = { name, cb: null }
      created.push(ch)
      return ch
    },
    removeChannel(ch: Ch) {
      depth++; maxDepth = Math.max(maxDepth, depth)
      if (depth > 40) { depth--; throw new Error('RECURSION: removeChannel nested >40 deep') }
      removed.push(ch.name)
      ch.cb?.('CLOSED')      // supabase-js: unsubscribe fires CLOSED synchronously
      depth--
    },
  }

  /** Transcribed from subscribeWithRetry, including the fix. */
  function subscribe(base: string) {
    const BASE_MS = 2000, MAX_MS = 30_000
    let cur = BASE_MS, cancelled = false, attempt = 0
    let retryTimer: (() => void) | null = null          // injectable: fire via runRetry()
    let channel: Ch | null = null

    const connect = () => {
      if (cancelled) return
      retryTimer = null
      attempt += 1
      const myAttempt = attempt
      let settled = false                                   // ← the fix
      channel = client.channel(`${base}-${attempt}`)
      channel.cb = (status: string) => {
        if (cancelled) return
        if (myAttempt !== attempt) return
        if (status === 'SUBSCRIBED') { cur = BASE_MS; return }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          if (settled) return                               // ← the fix
          settled = true
          const delay = cur
          warns.push(`[Realtime] ${base} dropped (${status}) — reconnecting in ${Math.round(delay)}ms`)
          const dying = channel
          channel = null                                    // ← the fix
          if (dying) microtasks.push(() => { try { client.removeChannel(dying) } catch { /* gone */ } })
          retryTimer = connect
          cur = Math.min(cur * 2, MAX_MS) * (0.8 + Math.random() * 0.4)
        }
      }
    }
    connect()

    const stop = () => {
      cancelled = true
      retryTimer = null
      const dying = channel
      channel = null
      if (dying) { try { client.removeChannel(dying) } catch { /* gone */ } }
    }
    /** Fire the pending retry, producing a genuinely new attempt. */
    stop.runRetry = () => { const t = retryTimer; retryTimer = null; t?.() }
    return stop
  }

  const drain = () => { while (microtasks.length) microtasks.shift()!() }
  return { subscribe, created, removed, warns, drain, maxDepth: () => maxDepth }
}

console.log('\n══ A. The production recursion is gone ══')
{
  const h = makeHarness()
  const unsub = h.subscribe(`activity:${WALLET}`)
  let threw: string | null = null
  try { h.created[0].cb!('CLOSED'); h.drain() } catch (e) { threw = String(e) }

  check('a CLOSED status does NOT recurse into RangeError', threw === null, threw ?? 'no throw')
  check('removeChannel never nests (depth <= 1)', h.maxDepth() <= 1, `max depth ${h.maxDepth()}`)
  check('exactly ONE drop warning for one drop', h.warns.length === 1, `${h.warns.length}`)
  check('  the warning names the channel', h.warns[0]?.includes(`activity:${WALLET}`))
  check('the dying channel is removed exactly once', h.removed.length === 1, `${h.removed.length}`)
  unsub()
}

console.log('\n══ B. Backoff advances (the identical-delay signature) ══')
{
  const h = makeHarness()
  const unsub = h.subscribe('chan')
  const delays: number[] = []

  // Four genuine consecutive failures, each on its own fresh attempt.
  for (let i = 0; i < 4; i++) {
    h.created[h.created.length - 1].cb!('CLOSED')
    h.drain()
    delays.push(Number(/in (\d+)ms/.exec(h.warns[h.warns.length - 1])![1]))
    if (i < 3) unsub.runRetry()          // fire the pending retry -> new attempt
  }

  check('four drops produced four attempts', h.created.length === 4, `${h.created.length}`)
  check('exactly ONE warning per drop, never a burst',
    h.warns.length === 4, `${h.warns.length} warnings / 4 drops`)
  check('first delay is the 2s baseline', delays[0] >= 1500 && delays[0] <= 2500, `${delays[0]}ms`)
  check('delays are NOT all identical (the recursion signature is absent)',
    new Set(delays).size > 1, JSON.stringify(delays.map(Math.round)))
  check('backoff grows across attempts', delays[3] > delays[0],
    `${Math.round(delays[0])}ms -> ${Math.round(delays[3])}ms`)
  check('and stays capped at 30s +jitter', delays.every(d => d <= 36_000),
    `max ${Math.round(Math.max(...delays))}ms`)

  // Extra CLOSED frames on an ALREADY-settled attempt must add nothing —
  // this is precisely what produced 844 identical warnings in production.
  const before = h.warns.length
  const cur = h.created[h.created.length - 1]
  for (let i = 0; i < 50; i++) cur.cb!('CLOSED')
  h.drain()
  check('50 extra CLOSED frames on a settled attempt add ZERO warnings',
    h.warns.length === before, `${h.warns.length - before} added`)
  check('  and cause no extra channel removals', h.maxDepth() <= 1, `max depth ${h.maxDepth()}`)
  unsub()
}

console.log('\n══ C. One channel per mount; clean teardown; re-entry ══')
{
  const h = makeHarness()
  const unsub = h.subscribe(`activity:${WALLET}`)
  check('subscribing creates exactly ONE channel', h.created.length === 1, `${h.created.length}`)
  h.created[0].cb!('SUBSCRIBED')
  check('  a successful subscribe creates no extra channel', h.created.length === 1)

  unsub(); h.drain()
  check('leaving the page removes the channel', h.removed.length === 1, `${h.removed.length}`)

  let late: string | null = null
  try { h.created[0].cb!('CLOSED'); h.drain() } catch (e) { late = String(e) }
  check('a CLOSED arriving AFTER unsubscribe is inert',
    late === null && h.removed.length === 1, `removed ${h.removed.length}`)

  const unsub2 = h.subscribe(`activity:${WALLET}`)
  check('returning creates exactly ONE new channel', h.created.length === 2, `${h.created.length}`)
  unsub2(); h.drain()
  check('  and it tears down cleanly', h.removed.length === 2, `${h.removed.length}`)
}

console.log('\n══ D. Repeated unsubscribe (React double-invoke / StrictMode) ══')
{
  const h = makeHarness()
  const unsub = h.subscribe('dbl')
  h.created[0].cb!('SUBSCRIBED')
  let threw: string | null = null
  try { unsub(); unsub(); unsub(); h.drain() } catch (e) { threw = String(e) }
  check('calling unsubscribe repeatedly is safe', threw === null, threw ?? 'no throw')
  check('  the channel is removed only once', h.removed.length === 1, `${h.removed.length}`)
}

console.log('\n══ E. The SHIPPED chatService.ts actually contains the fix ══')
{
  // Ties this suite to production code so a transcription cannot drift.
  check('per-attempt `settled` guard is declared', /let settled = false/.test(SRC))
  check('terminal branch returns early when settled', /if \(settled\) return/.test(SRC))
  check('channel is detached before removal (`channel = null`)',
    (SRC.match(/channel = null/g) ?? []).length >= 3,
    `${(SRC.match(/channel = null/g) ?? []).length} detach sites (status/resync/cleanup)`)
  check('removal is deferred out of the status callback (queueMicrotask)',
    /queueMicrotask\(\(\) => \{\s*try \{ client\.removeChannel\(dying\)/.test(SRC))
  check('the OLD recursive line is gone (`if (channel) client.removeChannel(channel)`)',
    !/if \(channel\) client\.removeChannel\(channel\)/.test(SRC))
  check('removals are wrapped so a double-remove cannot throw',
    (SRC.match(/try \{ client\.removeChannel\(dying\) \} catch/g) ?? []).length >= 2,
    `${(SRC.match(/try \{ client\.removeChannel\(dying\) \} catch/g) ?? []).length} guarded sites`)
  check('backoff advance still present and still capped',
    /Math\.min\(currentRetryDelayMs \* 2, MAX_RETRY_DELAY_MS\)/.test(SRC))
  check('the drop warning is retained for observability',
    /\[Realtime\] \$\{channelNameBase\} dropped/.test(SRC))
}

console.log('\n' + '='.repeat(68))
console.log(`Realtime lifecycle verification: ${pass}/${pass + fail} passed`)
console.log('='.repeat(68))
console.log('\nA: recursion gone. B: backoff advances. C: one channel per mount +')
console.log('clean teardown. D: repeated unsubscribe safe. E: the shipped source')
console.log('really contains the fix (guards against transcription drift).\n')
if (fail > 0) process.exit(1)
