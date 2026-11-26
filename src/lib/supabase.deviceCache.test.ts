// Device caches in lib/supabase.ts (docs/SUPABASE_LIGHT_PLAN.md, Phase 2):
// public profiles by wallet, known contact pairs, the shared contact list.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) }, clear: () => store.clear(),
})

// A tiny stand-in for the query builder: records each query, answers from `answer`.
const queries: Array<{ table: string; ops: string[] }> = []
let answer: (table: string, ops: string[]) => { data: any; error: any } = () => ({ data: null, error: null })
function builder(table: string) {
  const ops: string[] = []
  queries.push({ table, ops })
  const b: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        const res = answer(table, ops)
        return (ok: any, bad: any) => Promise.resolve(res).then(ok, bad)
      }
      if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve(answer(table, [...ops, prop]))
      return (...args: any[]) => { ops.push(`${prop}(${args.map(a => JSON.stringify(a)).join(',')})`); return b }
    },
  })
  return b
}
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (t: string) => builder(t), auth: {}, channel: () => ({}), rpc: () => Promise.resolve({ data: null, error: null }) }),
}))

let sb: typeof import('./supabase')
beforeAll(async () => { sb = await import('./supabase') })
beforeEach(() => { queries.length = 0; localStorage.clear(); sb.forgetCachedProfile() })

const ALICE = { id: 'u1', username: 'alice', display_name: 'Alice', wallet_address: '0xaaa0000000000000000000000000000000000001', avatar_url: null, created_at: '2026-01-01' }

describe('profile cache', () => {
  it('a wallet looked up once is answered on the device afterwards', async () => {
    answer = () => ({ data: ALICE, error: null })
    expect((await sb.getUserByWalletAddress(ALICE.wallet_address))?.username).toBe('alice')
    expect((await sb.getUserByWalletAddress(ALICE.wallet_address.toUpperCase().replace('0X', '0x')))?.username).toBe('alice')
    expect(queries.filter(q => q.table === 'users')).toHaveLength(1)
  })

  it('fresh: true always asks the server (sign-in / ownership)', async () => {
    answer = () => ({ data: ALICE, error: null })
    await sb.getUserByWalletAddress(ALICE.wallet_address)
    await sb.getUserByWalletAddress(ALICE.wallet_address, { fresh: true })
    expect(queries.filter(q => q.table === 'users')).toHaveLength(2)
  })

  it('batch lookups only ask for wallets not already known, and remember misses', async () => {
    answer = () => ({ data: ALICE, error: null })
    await sb.getUserByWalletAddress(ALICE.wallet_address)
    const other = '0xbbb0000000000000000000000000000000000002'
    answer = () => ({ data: [], error: null })
    const map = await sb.getUsersByWalletAddresses([ALICE.wallet_address, other])
    expect(map.get(ALICE.wallet_address)?.username).toBe('alice')
    const batch = queries.filter(q => q.table === 'users')[1]
    expect(batch.ops.join(' ')).toContain(other)
    expect(batch.ops.join(' ')).not.toContain(ALICE.wallet_address)
    await sb.getUsersByWalletAddresses([other])
    expect(queries.filter(q => q.table === 'users')).toHaveLength(2) // the miss was remembered
  })

  it('forgetCachedProfile makes the next lookup ask again (after a profile edit)', async () => {
    answer = () => ({ data: ALICE, error: null })
    await sb.getUserByWalletAddress(ALICE.wallet_address)
    sb.forgetCachedProfile(ALICE.wallet_address)
    await sb.getUserByWalletAddress(ALICE.wallet_address)
    expect(queries.filter(q => q.table === 'users')).toHaveLength(2)
  })
})

describe('contact caches', () => {
  it('upsertContactDb checks a pair once; later payments from them make no request', async () => {
    answer = (t, ops) => ops.includes('maybeSingle') ? { data: null, error: null } : { data: null, error: null }
    await sb.upsertContactDb('me', 'them')
    const n = queries.length
    await sb.upsertContactDb('me', 'them')
    expect(queries.length).toBe(n)
  })

  it('the contact list is shared for a while, and an add refreshes it', async () => {
    answer = (t) => t === 'contacts' ? { data: [{ contact_id: 'u1', is_favorite: false }], error: null } : { data: [ALICE], error: null }
    await sb.fetchContactsDbStrict('me2')
    await sb.fetchContactsDb('me2')
    expect(queries.filter(q => q.table === 'contacts')).toHaveLength(1)
    await sb.addContactDb('me2', 'u9')
    await sb.fetchContactsDbStrict('me2')
    expect(queries.filter(q => q.table === 'contacts' && !q.ops.some(o => o.startsWith('upsert')))).toHaveLength(2)
  })
})
