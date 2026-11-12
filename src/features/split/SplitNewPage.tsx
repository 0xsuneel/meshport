// New split: amount (when not coming from a payment) → who's in → how to
// split → review → requests sent. Creating a split moves no money: every
// friend gets a payment request for their share (lib/splits).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Search, X, Check } from 'lucide-react'
import { useAuthStore } from '@/store'
import { readPeople } from '@/lib/peopleCache'
import { useUserSearch } from '@/hooks/useUserSearch'
import type { DbUser } from '@/lib/supabase'
import {
  equalShares, percentShares, sharesGap, createSplit, mySplits, money, capShareInput, MAX_SPLIT_PEOPLE, type CreatedSplit,
} from '@/lib/splits'
import {
  SplitHeader, SplitAvatar, ListCard, ProgressBar, Pill, ActionBar, Btn, Tick,
  card, rowStyle, subStyle, nameStyle, amountStyle, SPLIT_CATEGORIES, categoryForTitle, categoryForEmoji,
} from './splitUi'

type Step = 'amount' | 'people' | 'how' | 'review' | 'sent'
type Mode = 'equal' | 'amounts' | 'percent'
type Person = { username: string; name: string; avatar: string | null; userId: string | null }
type Group = { key: string; title: string; emoji: string | null; people: Person[] }

export interface SplitNewState {
  total?: number; title?: string; sourceTx?: string
  /** People already in (Split again with this group). */
  with?: Array<string | { username: string; name?: string | null; avatar?: string | null }>
}

const clean = (u: string) => u.trim().replace(/^@/, '').replace(/\.arc$/i, '').toLowerCase()
const parseAmount = (s: string) => {
  const v = Number(String(s).replace(/[^0-9.]/g, ''))
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0
}

export function SplitNewPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const init = (location.state ?? {}) as SplitNewState
  const me = useAuthStore(s => s.user)
  const myName = clean(me?.username ?? '')

  const [step, setStep] = useState<Step>(init.total && init.total > 0 ? 'people' : 'amount')
  const [totalText, setTotalText] = useState(init.total ? String(init.total) : '')
  const total = parseAmount(totalText)
  const [title, setTitle] = useState(init.title ?? '')
  // The expense's category icon: picked from its name until chosen by hand.
  const [emoji, setEmojiState] = useState<string>(() => categoryForTitle(init.title ?? '').emoji)
  const [catByHand, setCatByHand] = useState(false)
  const setEmoji = (e: string) => { setCatByHand(true); setEmojiState(e) }
  // Tapping a category also fills "What for" with its name ("Taxi") when it's
  // empty or still the name a category filled in - never over words typed by
  // hand. It's a normal field: erase it and type anything.
  const autoTitle = useRef('')
  const pickCategory = (c: { emoji: string; label: string }) => {
    setEmoji(c.emoji)
    if (c.label !== 'Other' && (!title.trim() || title === autoTitle.current)) { setTitle(c.label); autoTitle.current = c.label }
  }
  useEffect(() => { if (!catByHand) setEmojiState(categoryForTitle(title).emoji) }, [title, catByHand])
  const [picked, setPicked] = useState<Person[]>([])
  const [mode, setMode] = useState<Mode>('equal')
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [percents, setPercents] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<CreatedSplit | null>(null)

  // People you know (Pay's contacts) and groups from your earlier splits.
  const contacts = useMemo(() => (readPeople<DbUser>('pay-contacts', me?.id) ?? []).filter(u => clean(u.username) !== myName), [me?.id, myName])
  const [freshContacts, setFreshContacts] = useState<DbUser[] | null>(null)
  useEffect(() => {
    import('@/lib/payPeople').then(m => m.loadPayContacts()).then(list => { if (list) setFreshContacts(list.filter(u => clean(u.username) !== myName)) }).catch(() => {})
  }, [myName])
  const people = freshContacts ?? contacts
  const [groups, setGroups] = useState<Group[]>([])
  useEffect(() => {
    mySplits().then(({ made }) => {
      const seen = new Set<string>()
      const out: Group[] = []
      for (const s of made) {
        const ps = s.members.filter(m => m.username).map(m => ({ username: clean(m.username), name: m.name || m.username, avatar: m.avatar, userId: null }))
        if (ps.length < 2) continue
        const key = ps.map(p => p.username).sort().join(',')
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ key, title: s.title, emoji: s.emoji, people: ps })
        if (out.length >= 4) break
      }
      setGroups(out)
    }).catch(() => {})
  }, [])
  // Coming back from a chat or a group: people already named.
  useEffect(() => {
    if (!init.with?.length) return
    setPicked(init.with.map(u => typeof u === 'string'
      ? { username: clean(u), name: clean(u), avatar: null, userId: null }
      : { username: clean(u.username), name: u.name || clean(u.username), avatar: u.avatar ?? null, userId: null })
      .filter(p => p.username && p.username !== myName))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [query, setQuery] = useState('')
  const { results, searching } = useUserSearch(query, people)
  const isPicked = (u: string) => picked.some(p => p.username === clean(u))
  const toggle = (p: Person) => {
    setError('')
    setPicked(cur => cur.some(x => x.username === p.username) ? cur.filter(x => x.username !== p.username)
      : cur.length >= MAX_SPLIT_PEOPLE - 1 ? cur : [...cur, p])
  }
  const asPerson = (u: DbUser): Person => ({ username: clean(u.username), name: u.display_name || u.username, avatar: u.avatar_url, userId: u.id })
  const pickGroup = (g: Group) => {
    const allIn = g.people.every(p => isPicked(p.username))
    setPicked(cur => allIn ? cur.filter(x => !g.people.some(p => p.username === x.username))
      : [...cur, ...g.people.filter(p => !cur.some(x => x.username === p.username))].slice(0, MAX_SPLIT_PEOPLE - 1))
  }

  // Shares: index 0 is you.
  const n = picked.length + 1
  const shares = useMemo(() => {
    if (mode === 'equal') return equalShares(total, n)
    if (mode === 'percent') return percentShares(total, [myName, ...picked.map(p => p.username)].map(k => Number(percents[k] || 0)))
    return [myName, ...picked.map(p => p.username)].map(k => parseAmount(amounts[k] ?? ''))
  }, [mode, total, n, picked, amounts, percents, myName])
  const gap = sharesGap(total, shares)
  const pctTotal = [myName, ...picked.map(p => p.username)].reduce((a, k) => a + Number(percents[k] || 0), 0)
  const friendsOk = shares.slice(1).every(s => s > 0)
  const howOk = title.trim().length > 0 && gap === 0 && friendsOk && (mode !== 'percent' || Math.abs(pctTotal - 100) < 1e-6)
  const getBack = shares.slice(1).reduce((a, s) => a + s, 0)

  // A share typed in Amounts / % follows the bill: never more than what's
  // left after everyone else's shares (the server checks the total too).
  const [capNote, setCapNote] = useState('')
  useEffect(() => { if (!capNote) return; const t = setTimeout(() => setCapNote(''), 3500); return () => clearTimeout(t) }, [capNote])
  const setShare = (key: string, label: string, text: string) => {
    const keys = [myName, ...picked.map(p => p.username)].filter(k => k !== key)
    if (mode === 'amounts') {
      const others = keys.reduce((a, k) => a + parseAmount(amounts[k] ?? ''), 0)
      const r = capShareInput(text, total - others)
      if (r.capped) setCapNote(`Only ${money(Math.max(0, total - others))} of the ${money(total)} bill is left for ${label}`)
      setAmounts(a => ({ ...a, [key]: r.text }))
    } else {
      const others = keys.reduce((a, k) => a + Number(percents[k] || 0), 0)
      const r = capShareInput(text, 100 - others)
      if (r.capped) setCapNote(`Only ${Math.max(0, Math.round((100 - others) * 100) / 100)}% is left for ${label}`)
      setPercents(a => ({ ...a, [key]: r.text }))
    }
  }

  // Switching to Amounts / % starts from the equal split.
  const switchMode = (m: Mode) => {
    if (m === mode) return
    const eq = equalShares(total, n)
    const keys = [myName, ...picked.map(p => p.username)]
    if (m === 'amounts') setAmounts(Object.fromEntries(keys.map((k, i) => [k, (eq[i] ?? 0).toFixed(2)])))
    if (m === 'percent') {
      const base = Math.floor(10000 / n) / 100
      setPercents(Object.fromEntries(keys.map((k, i) => [k, (i === 0 ? Math.round((100 - base * (n - 1)) * 100) / 100 : base).toString()])))
    }
    setMode(m)
  }

  const back = () => {
    setError('')
    if (step === 'review') setStep('how')
    else if (step === 'how') setStep('people')
    else if (step === 'people' && !(init.total && init.total > 0)) setStep('amount')
    else navigate(-1)
  }

  const send = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const out = await createSplit({
        title: title.trim(), emoji, total, myShare: shares[0] ?? 0, sourceTx: init.sourceTx ?? null,
        members: picked.map((p, i) => ({ username: p.username, userId: p.userId, amount: shares[i + 1] })),
      })
      setCreated(out)
      setStep('sent')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the split - try again')
    } finally { setBusy(false) }
  }

  const headerTitle = step === 'amount' ? 'Split Expense' : step === 'review' ? 'Review split' : step === 'sent' ? '' : `Split ${money(total)}`
  const errorBox = error ? <div role="alert" className="mp-alert" style={{ ...card, padding: '12px 14px', color: 'var(--danger)', fontSize: 13.5, fontWeight: 600 }}>{error}</div> : null

  return (
    <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', background: 'var(--bg)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {step !== 'sent' && <SplitHeader title={headerTitle} onBack={back} />}
      <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 14, width: '100%', maxWidth: 560, margin: '0 auto', flex: 1 }}>

        {step === 'amount' && (<>
          <div style={{ ...card, textAlign: 'center', padding: '26px 16px' }}>
            <div style={subStyle}>Bill total (USDC)</div>
            <input autoFocus inputMode="decimal" placeholder="$0.00" value={totalText ? `$${totalText}` : ''}
              onChange={e => {
                const t = e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').replace(/^(\d*\.\d{0,2}).*$/, '$1')
                // Up to $1,000,000 a bill (the server's limit too).
                if (Number(t) <= 1_000_000) setTotalText(t)
              }}
              aria-label="Bill total"
              style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', textAlign: 'center', fontSize: 40, fontWeight: 700, letterSpacing: '-1px', color: 'var(--text-primary)', marginTop: 6 }} />
          </div>
          <TitleCard title={title} setTitle={setTitle} emoji={emoji} onPick={pickCategory} />
        </>)}

        {step === 'people' && (<>
          <label className="arc-input" style={{ display: 'flex', alignItems: 'center', gap: 10, height: 46, padding: '0 14px' }}>
            <Search size={17} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
            <input className="mp-search-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name or username.arc"
              style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 15, color: 'var(--text-primary)', minWidth: 0 }} />
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Chip you label="You" />
            {picked.map(p => <Chip key={p.username} label={p.name} username={p.username} avatar={p.avatar} onRemove={() => toggle(p)} />)}
          </div>
          {query.trim() ? (
            <PeopleList title={searching ? 'Searching…' : results.length ? 'Results' : 'No one found - type the full username.arc'}
              people={results.filter(u => clean(u.username) !== myName).map(asPerson)} isPicked={isPicked} toggle={toggle} />
          ) : (<>
            {groups.length > 0 && (<>
              <SectionTitle>Groups</SectionTitle>
              <ListCard>{groups.map(g => {
                const on = g.people.every(p => isPicked(p.username))
                return (
                  <button key={g.key} type="button" onClick={() => pickGroup(g)} style={{ ...rowStyle, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
                    <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'color-mix(in srgb, var(--brand) 13%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19, flexShrink: 0 }}>{g.emoji || '👥'}</div>
                    <div style={{ flex: 1, minWidth: 0 }}><div style={nameStyle}>{g.title}</div><div style={{ ...subStyle, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>You, {g.people.map(p => p.name).join(', ')}</div></div>
                    <CheckBox on={on} />
                  </button>
                )
              })}</ListCard>
            </>)}
            <PeopleList title={people.length ? 'People' : 'Type a username.arc to add someone'} people={people.slice(0, 40).map(asPerson)} isPicked={isPicked} toggle={toggle} />
          </>)}
        </>)}

        {step === 'how' && (<>
          <TitleCard title={title} setTitle={setTitle} emoji={emoji} onPick={pickCategory} />
          <div role="tablist" style={{ display: 'flex', background: 'color-mix(in srgb, var(--text-primary) 7%, transparent)', borderRadius: 14, padding: 4 }}>
            {([['equal', 'Equally'], ['amounts', 'Amounts'], ['percent', '%']] as [Mode, string][]).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={mode === id} type="button" onClick={() => switchMode(id)}
                style={{ flex: 1, padding: '9px 0', borderRadius: 11, border: 'none', cursor: 'pointer', fontSize: 13.5, fontWeight: 600,
                  background: mode === id ? 'var(--surface)' : 'transparent', color: mode === id ? 'var(--text-primary)' : 'var(--text-secondary)',
                  boxShadow: mode === id ? '0 1px 3px rgba(0,0,0,.08)' : 'none' }}>{label}</button>
            ))}
          </div>
          <ListCard>{[{ username: myName, name: 'You', avatar: null, you: true }, ...picked.map(p => ({ ...p, you: false }))].map((p, i) => (
            <div key={p.username || 'me'} style={rowStyle}>
              <SplitAvatar you={p.you} name={p.name} username={p.username} avatar={p.avatar} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={nameStyle}>{p.you ? 'You' : p.name}</div>
                <div style={subStyle}>{p.you ? `Paid ${money(total)}` : `${p.username}.arc`}</div>
              </div>
              {mode === 'equal' ? <div style={amountStyle}>{money(shares[i] ?? 0)}</div>
                : mode === 'amounts' ? <NumField prefix="$" value={amounts[p.username] ?? ''} onChange={v => setShare(p.username, p.you ? 'you' : p.name, v)} />
                : <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ ...subStyle, fontVariantNumeric: 'tabular-nums' }}>{money(shares[i] ?? 0)}</span>
                    <NumField suffix="%" value={percents[p.username] ?? ''} onChange={v => setShare(p.username, p.you ? 'you' : p.name, v)} />
                  </div>}
            </div>
          ))}</ListCard>
          {mode === 'equal' ? (<>
            <div style={{ ...card, background: 'color-mix(in srgb, var(--brand) 12%, var(--surface))' }}>
              <div style={rowStyle}>
                <div style={{ flex: 1 }}><div style={{ ...nameStyle, color: 'var(--brand-text)' }}>You get back</div><div style={subStyle}>From {picked.length} {picked.length === 1 ? 'person' : 'people'}</div></div>
                <div style={{ ...amountStyle, fontSize: 20, color: 'var(--brand-text)' }}>{money(getBack)}</div>
              </div>
            </div>
            {n > 1 && shares[0] !== shares[1] && (
              <p style={{ ...subStyle, textAlign: 'center' }}>Shares are rounded down to the cent; the extra cent stays with you.</p>
            )}
          </>) : (<>
            <div style={{ ...rowStyle, padding: '0 6px' }}>
              <div style={{ flex: 1, ...subStyle }}>{mode === 'percent' ? `${Math.round(pctTotal * 100) / 100}% of 100%` : 'Assigned'}</div>
              <div style={amountStyle}>{money(total - gap / 100)} <span style={subStyle}>of {money(total)}</span></div>
            </div>
            <ProgressBar value={total > 0 ? (total - gap / 100) / total : 0} />
            {capNote && <p role="status" style={{ ...subStyle, textAlign: 'center', fontWeight: 600, color: 'var(--warning-text)' }}>{capNote}</p>}
            <p style={{ ...subStyle, textAlign: 'center', fontWeight: 600, color: gap === 0 && friendsOk ? 'var(--brand-text)' : 'var(--warning-text)' }}>
              {gap === 0 ? (friendsOk ? `✓ All ${money(total)} assigned` : 'Everyone you add needs a share above $0')
                : gap > 0 ? `${money(gap / 100)} still to assign` : `${money(-gap / 100)} over the bill`}
            </p>
          </>)}
        </>)}

        {step === 'review' && (<>
          <div style={{ ...card, textAlign: 'center', padding: '22px 16px' }}>
            <div style={{ fontSize: 30 }}>{emoji}</div>
            <div style={{ fontSize: 17, fontWeight: 700, marginTop: 6, color: 'var(--text-primary)' }}>{title.trim()}</div>
            <div style={{ fontSize: 38, fontWeight: 700, letterSpacing: '-1px', marginTop: 4, color: 'var(--text-primary)' }}>{money(total)}</div>
            <div style={subStyle}>{init.sourceTx ? 'Paid by you · ' : ''}USDC on Arc</div>
          </div>
          <ListCard>{[
            ...picked.map((p, i) => (
              <div key={p.username} style={rowStyle}>
                <SplitAvatar name={p.name} username={p.username} avatar={p.avatar} />
                <div style={{ flex: 1, minWidth: 0 }}><div style={nameStyle}>{p.name} will pay you</div><div style={subStyle}>{p.username}.arc</div></div>
                <div style={amountStyle}>{money(shares[i + 1] ?? 0)}</div>
              </div>
            )),
            <div key="me" style={rowStyle}>
              <SplitAvatar you />
              <div style={{ flex: 1 }}><div style={nameStyle}>Your share</div><div style={subStyle}>You paid the bill</div></div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <div style={{ ...amountStyle, color: 'var(--text-secondary)' }}>{money(shares[0] ?? 0)}</div>
                <Pill tone="paid">Paid</Pill>
              </div>
            </div>,
          ]}</ListCard>
          <div style={{ ...card, ...rowStyle, gap: 10 }}>
            <span aria-hidden style={{ fontSize: 18 }}>💬</span>
            <div style={{ ...subStyle, flex: 1 }}>Each person gets a payment request in their chat with you and a notification. Nothing is paid until they pay it themselves.</div>
          </div>
          {errorBox}
        </>)}

        {step === 'sent' && created && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14, paddingTop: 'calc(env(safe-area-inset-top, 0px) + 40px)' }}>
            <Tick />
            <div style={{ fontSize: 20, fontWeight: 700, textAlign: 'center', color: 'var(--text-primary)' }}>Requests sent</div>
            <p style={{ ...subStyle, textAlign: 'center' }}>
              {created.requests.length === 1 ? `${created.requests[0].username}.arc gets a request` : `${created.requests.length} people each get a request`} in chat and a notification.
            </p>
            <ListCard>{[
              <div key="me" style={rowStyle}>
                <SplitAvatar you />
                <div style={{ flex: 1, minWidth: 0 }}><div style={nameStyle}>You</div><div style={subStyle}>{money(shares[0] ?? 0)} · you paid the bill</div></div>
                <Pill tone="paid">Paid</Pill>
              </div>,
              ...created.requests.map(r => {
              const p = picked.find(x => x.username === r.username)
              return (
                <div key={r.code} style={rowStyle}>
                  <SplitAvatar name={p?.name ?? r.username} username={r.username} avatar={p?.avatar} />
                  <div style={{ flex: 1, minWidth: 0 }}><div style={nameStyle}>{p?.name ?? `${r.username}.arc`}</div><div style={subStyle}>{money(r.amount)}</div></div>
                  <Pill tone="pending">Requested</Pill>
                </div>
              )
            })]}</ListCard>
            {created.notPosted.length > 0 && (
              <p style={{ ...subStyle, textAlign: 'center', color: 'var(--warning-text)' }}>
                Couldn't post the card in {created.notPosted.map(u => `${u}.arc`).join(', ')}'s chat - their request is still there; use Remind on the split.
              </p>
            )}
          </div>
        )}
      </div>

      <ActionBar>
        {step === 'amount' && <Btn disabled={!(total > 0) || !title.trim()} onClick={() => setStep('people')}>Next</Btn>}
        {step === 'people' && <Btn disabled={!picked.length} onClick={() => { if (mode !== 'equal') switchMode('equal'); setStep('how') }}>{picked.length ? `Next · ${n} people` : 'Add people'}</Btn>}
        {step === 'how' && <Btn disabled={!howOk} onClick={() => setStep('review')}>Review</Btn>}
        {step === 'review' && <Btn disabled={busy} onClick={send}>{busy ? 'Sending…' : `Send ${picked.length} request${picked.length === 1 ? '' : 's'}`}</Btn>}
        {step === 'sent' && created && (<>
          <Btn kind="ghost" onClick={() => navigate('/', { replace: true })}>Home</Btn>
          <Btn onClick={() => navigate(`/splits/${created.splitId}`, { replace: true })}>View split</Btn>
        </>)}
      </ActionBar>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', margin: '2px 4px -4px' }}>{children}</p>
}

function CheckBox({ on }: { on: boolean }) {
  return on
    ? <span style={{ width: 22, height: 22, borderRadius: 7, background: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Check size={14} color="#fff" strokeWidth={3.5} /></span>
    : <span style={{ width: 22, height: 22, borderRadius: 7, border: '2px solid color-mix(in srgb, var(--text-primary) 22%, transparent)', flexShrink: 0 }} />
}

function Chip({ label, username, avatar, you, onRemove }: { label: string; username?: string; avatar?: string | null; you?: boolean; onRemove?: () => void }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: `0 ${onRemove ? 8 : 12}px 0 4px`, borderRadius: 999,
      background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>
      <SplitAvatar you={you} name={label} username={username} avatar={avatar} size={26} />
      <span style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {onRemove && <button type="button" aria-label={`Remove ${label}`} onClick={onRemove} style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', display: 'flex', color: 'var(--text-secondary)' }}><X size={14} /></button>}
    </span>
  )
}

function PeopleList({ title, people, isPicked, toggle }: { title: string; people: Person[]; isPicked: (u: string) => boolean; toggle: (p: Person) => void }) {
  return (<>
    <SectionTitle>{title}</SectionTitle>
    {people.length > 0 && (
      <ListCard>{people.map(p => (
        <button key={p.username} type="button" onClick={() => toggle(p)} style={{ ...rowStyle, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
          <SplitAvatar name={p.name} username={p.username} avatar={p.avatar} />
          <div style={{ flex: 1, minWidth: 0 }}><div style={nameStyle}>{p.name}</div><div style={subStyle}>{p.username}.arc</div></div>
          <CheckBox on={isPicked(p.username)} />
        </button>
      ))}</ListCard>
    )}
  </>)
}

function TitleCard({ title, setTitle, emoji, onPick }: { title: string; setTitle: (s: string) => void; emoji: string; onPick: (c: { emoji: string; label: string }) => void }) {
  const cat = categoryForEmoji(emoji)
  // The chosen category stays in view in the row (picked from the name too).
  const rowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = rowRef.current
    const on = row?.querySelector<HTMLElement>('[aria-checked="true"]')
    if (row && on) row.scrollTo({ left: Math.max(0, on.offsetLeft - row.clientWidth / 2 + on.clientWidth / 2), behavior: 'smooth' })
  }, [emoji])
  return (
    <div style={card}>
      <div style={subStyle}>What for</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <span aria-hidden style={{ fontSize: 20 }}>{emoji}</span>
        <input value={title} maxLength={60} onChange={e => setTitle(e.target.value)} placeholder="Dinner, rent, cab…" aria-label="What the bill is for"
          style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 17, fontWeight: 650, color: 'var(--text-primary)', minWidth: 0 }} />
      </div>
      <div style={{ ...subStyle, marginTop: 12 }}>Category · <b style={{ color: 'var(--text-primary)' }}>{cat.label}</b></div>
      <div ref={rowRef} role="radiogroup" aria-label="Category" style={{ position: 'relative', display: 'flex', gap: 6, marginTop: 6, overflowX: 'auto', scrollbarWidth: 'none', paddingBottom: 2 }}>
        {SPLIT_CATEGORIES.map(c => {
          const on = c.emoji === emoji
          return (
            <button key={c.id} type="button" role="radio" aria-checked={on} aria-label={c.label} onClick={() => onPick(c)}
              style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, height: 34, padding: '0 11px 0 8px', borderRadius: 999, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                color: on ? 'var(--brand-text)' : 'var(--text-secondary)', whiteSpace: 'nowrap',
                border: on ? '1.5px solid var(--brand)' : '1px solid var(--border)', background: on ? 'color-mix(in srgb, var(--brand) 10%, var(--surface))' : 'var(--bg)' }}>
              <span aria-hidden style={{ fontSize: 16 }}>{c.emoji}</span>{c.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function NumField({ value, onChange, prefix, suffix }: { value: string; onChange: (v: string) => void; prefix?: string; suffix?: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', height: 40, minWidth: 92, maxWidth: 110, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--bg)', padding: '0 10px', gap: 2 }}>
      {prefix && <span style={{ ...amountStyle, color: 'var(--text-secondary)' }}>{prefix}</span>}
      <input inputMode="decimal" value={value} onChange={e => onChange(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').replace(/^(\d*\.\d{0,2}).*$/, '$1'))}
        style={{ width: '100%', minWidth: 0, border: 'none', outline: 'none', background: 'transparent', textAlign: 'right', ...amountStyle }} />
      {suffix && <span style={{ ...amountStyle, color: 'var(--text-secondary)' }}>{suffix}</span>}
    </label>
  )
}
