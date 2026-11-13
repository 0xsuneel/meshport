// A split group (/splits/:id): everyone in a split - its creator and the
// people asked for a share - like a group chat in Chats.
//   Top: the bill, how many have paid, and your part - Pay your share (the
//   share's own payment request, passcode and all), or for the person who
//   paid the bill: each person with Remind / Mark as received.
//   Below: the group's thread - messages from anyone in it, with the split's
//   events in line ("Rohit paid $8.33").
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Bell, ChevronDown, Send } from 'lucide-react'
import {
  getSplit, paidOf, remindSplitMember, markSplitReceived, isSettled, memberOpen, money, splitMessages, sendSplitMessage,
  watchSplitMessages, markSplitGroupSeen, SPLITS_CHANGED_EVENT, type SplitSummary, type SplitMember, type SplitMessage,
} from '@/lib/splits'
import { canRemindAt } from '@/lib/businessBills'
import { useAuthStore, useUIStore } from '@/store'
import { SplitHeader, SplitAvatar, ProgressBar, Pill, Btn, card, rowStyle, subStyle, nameStyle, amountStyle, when } from './splitUi'

type Item =
  | { kind: 'msg'; at: string; m: SplitMessage }
  | { kind: 'event'; at: string; text: string; to?: string }

export function SplitDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const myUserId = useAuthStore(st => st.user?.id ?? null)
  const showToastMessage = useUIStore(st => st.showToastMessage)
  const [s, setS] = useState<SplitSummary | null>(null)
  const [msgs, setMsgs] = useState<SplitMessage[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [details, setDetails] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => getSplit(id).then(v => { setS(v); setError('') }).catch(e => setError(e instanceof Error ? e.message : 'Could not load the split')), [id])
  // The thread belongs to the group (every split made with "Split again with
  // group" shares it): keyed by the group's first split.
  const groupId = s?.id === id ? s.groupId : null
  useEffect(() => {
    if (!groupId) return
    setMsgs([])
    splitMessages(groupId).then(setMsgs).catch(() => {})
    return watchSplitMessages(groupId, m => setMsgs(cur => cur.some(x => x.id === m.id) ? cur : [...cur, m]))
  }, [groupId])
  useEffect(() => {
    void load()
    // Payments show within seconds.
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 8000)
    const on = () => void load()
    window.addEventListener(SPLITS_CHANGED_EVENT, on)
    markSplitGroupSeen(id)
    return () => { clearInterval(t); window.removeEventListener(SPLITS_CHANGED_EVENT, on); markSplitGroupSeen(id) }
  }, [id, load])

  // Who said what: every person in the group, by user id.
  const names = useMemo(() => {
    const m = new Map<string, { name: string; username: string | null; avatar: string | null }>()
    if (s?.creator.userId) m.set(String(s.creator.userId), { name: s.creator.name ?? s.creator.username ?? 'Someone', username: s.creator.username, avatar: s.creator.avatar })
    for (const p of s?.members ?? []) if (p.userId) m.set(String(p.userId), { name: p.name ?? p.username ?? 'Someone', username: p.username, avatar: p.avatar })
    return m
  }, [s])

  const items = useMemo<Item[]>(() => {
    if (!s) return []
    const creatorName = s.isCreator ? 'You' : (s.creator.name ?? 'Someone')
    const out: Item[] = [{ kind: 'event', at: s.createdAt, text: `${creatorName} split ${money(s.total)} · ${s.emoji ? `${s.emoji} ` : ''}${s.title}` }]
    if (s.myShare > 0) out.push({ kind: 'event', at: s.createdAt, text: `${creatorName} paid the bill · ${s.isCreator ? 'your' : 'their'} share ${money(s.myShare)} is paid` })
    for (const m of s.members) {
      if (m.status !== 'paid' || !m.paidAt) continue
      const who = m.isMe ? 'You' : (m.name ?? 'Someone')
      out.push({ kind: 'event', at: m.paidAt, text: m.completedByMe ? `${who}${m.isMe ? 'r' : "'s"} share was marked received · ${money(m.amount)}` : `${who} paid ${money(m.amount)}` })
    }
    // The group's other splits (Split again with group), in line - tap to open.
    for (const g of s.groupSplits) {
      const who = g.isCreator ? 'You' : (g.creatorName ?? 'Someone')
      const done = g.requests > 0 && g.paidCount >= g.requests ? ' · settled' : ''
      out.push({ kind: 'event', at: g.createdAt, to: g.id, text: `${who} split ${money(g.total)} · ${g.emoji ? `${g.emoji} ` : ''}${g.title}${done}` })
    }
    for (const m of msgs) out.push({ kind: 'msg', at: m.created_at, m })
    out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    if (isSettled(s)) out.push({ kind: 'event', at: '', text: 'All settled 🎉' })
    return out
  }, [s, msgs])

  // Stay at the latest message.
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items.length])

  const toast = (m: string, t: 'success' | 'error') => showToastMessage(m, t)
  const remind = async (m: SplitMember) => {
    setBusy(`r:${m.id}`)
    try { await remindSplitMember(m.id); toast(`Reminded ${m.name ?? m.username}`, 'success'); await load() }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not remind', 'error') }
    finally { setBusy(null) }
  }
  const received = async (m: SplitMember) => {
    setBusy(`c:${m.id}`)
    try { await markSplitReceived(m.code); toast(`${m.name ?? m.username}'s share marked as received`, 'success'); await load() }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not update', 'error') }
    finally { setBusy(null) }
  }
  const payMine = async (code: string) => {
    setBusy('pay')
    try {
      const { getPayment, orderPaySendUrl } = await import('@/lib/merchantPay')
      navigate(orderPaySendUrl(await getPayment(code)))
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not open the payment', 'error') }
    finally { setBusy(null) }
  }
  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      const m = await sendSplitMessage(s?.groupId ?? id, text)
      setMsgs(cur => cur.some(x => x.id === m.id) ? cur : [...cur, m])
      setDraft('')
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not send', 'error') }
    finally { setSending(false) }
  }

  const back = () => (window.history.length > 1 ? navigate(-1) : navigate('/chat', { replace: true }))
  if (!s) {
    return (
      <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}>
        <SplitHeader title="Split" onBack={back} />
        <div style={{ padding: '0 16px' }}>{error
          ? <div role="alert" style={{ ...card, color: 'var(--danger)', fontWeight: 600, fontSize: 14 }}>{error}</div>
          : <div style={{ ...card, height: 140 }} className="animate-pulse" />}</div>
      </div>
    )
  }

  const settled = isSettled(s)
  const mine = s.members.find(m => m.isMe) ?? null
  const owedTotal = s.members.reduce((a, m) => a + m.amount, 0)
  // Everyone else in this group (for "Split again with group").
  const groupPeople = [
    ...(!s.isCreator && s.creator.username ? [{ username: s.creator.username, name: s.creator.name, avatar: s.creator.avatar }] : []),
    ...s.members.filter(m => !m.isMe && m.username).map(m => ({ username: m.username!, name: m.name, avatar: m.avatar })),
  ]

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <SplitHeader title={`${s.emoji ? `${s.emoji} ` : ''}${s.title}`} onBack={back}
        right={<span style={{ ...subStyle, whiteSpace: 'nowrap' }}>{s.people} people</span>} />

      {/* The split: progress and your part. */}
      <div style={{ padding: '0 16px 10px', flexShrink: 0, width: '100%', maxWidth: 560, margin: '0 auto' }}>
        <div style={{ ...card, padding: 14 }}>
          <div style={rowStyle}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {s.isCreator ? (<>
                <div style={subStyle}>{settled ? 'All settled' : 'You get back'}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>{settled ? money(owedTotal) : money(s.owedLeft)}{!settled && <span style={{ ...subStyle, fontSize: 13, fontWeight: 600 }}> left of {money(owedTotal)}</span>}</div>
              </>) : (<>
                <div style={subStyle}>{s.creator.name ?? 'Someone'} paid {money(s.total)} · your share</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>{money(mine?.amount ?? 0)}</div>
              </>)}
            </div>
            {!s.isCreator && mine && (memberOpen(mine)
              ? <Btn style={{ flex: 'none', height: 42, padding: '0 18px', borderRadius: 14, fontSize: 14.5 }} disabled={busy === 'pay'} onClick={() => payMine(mine.code)}>{busy === 'pay' ? 'Opening…' : 'Pay'}</Btn>
              : <Pill tone={mine.status === 'paid' ? 'paid' : 'muted'}>{mine.status === 'paid' ? 'Paid' : mine.status}</Pill>)}
          </div>
          <div style={{ marginTop: 10 }}><ProgressBar value={paidOf(s).paid / paidOf(s).of} /></div>
          <button type="button" onClick={() => setDetails(d => !d)} aria-expanded={details}
            style={{ ...rowStyle, width: '100%', marginTop: 8, padding: 0, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <span style={{ ...subStyle, flex: 1, textAlign: 'left' }}>{paidOf(s).paid} of {paidOf(s).of} paid · bill {money(s.total)}</span>
            <span style={{ ...subStyle, fontWeight: 700, color: 'var(--brand-text)', display: 'flex', alignItems: 'center', gap: 2 }}>
              {details ? 'Hide' : 'Everyone'} <ChevronDown size={14} style={{ transform: details ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
            </span>
          </button>
          {details && (
            <div style={{ marginTop: 6 }}>
              {/* The person who made the split paid the bill: their share is paid, automatically. */}
              <div style={{ ...rowStyle, padding: '10px 0', borderTop: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
                <SplitAvatar name={s.creator.name} username={s.creator.username} avatar={s.creator.avatar} you={s.isCreator} size={34} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={nameStyle}>{s.isCreator ? 'You' : (s.creator.name ?? `${s.creator.username}.arc`)}</div>
                  <div style={subStyle}>Paid the bill · {when(s.createdAt)}</div>
                </div>
                <div style={{ ...amountStyle, fontSize: 14.5 }}>{money(s.myShare)}</div>
                <Pill tone="paid">Paid</Pill>
              </div>
              {s.members.map(m => {
                const paid = m.status === 'paid'
                const open = memberOpen(m)
                const remindable = s.isCreator && open && canRemindAt(m.lastRemindedAt).ok
                return (
                  <div key={m.id} style={{ padding: '10px 0', borderTop: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
                    <div style={rowStyle}>
                      <SplitAvatar name={m.name} username={m.username} avatar={m.avatar} size={34} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={nameStyle}>{m.isMe ? 'You' : (m.name ?? `${m.username}.arc`)}</div>
                        <div style={subStyle}>{paid ? (m.completedByMe ? `Marked received · ${when(m.paidAt)}` : `Paid ${when(m.paidAt)}`) : open ? 'Not paid yet' : m.status}</div>
                      </div>
                      <div style={{ ...amountStyle, fontSize: 14.5 }}>{money(m.amount)}</div>
                      <Pill tone={paid ? 'paid' : open || m.status === 'processing' ? 'pending' : 'muted'}>{paid ? (m.completedByMe ? 'Received' : 'Paid') : m.status === 'processing' ? 'Paying…' : open ? 'Pending' : m.status}</Pill>
                    </div>
                    {s.isCreator && open && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <Btn kind="soft" style={{ height: 36, fontSize: 13, borderRadius: 11 }} disabled={!remindable || !!busy} onClick={() => remind(m)}>
                          <Bell size={14} />{busy === `r:${m.id}` ? 'Reminding…' : remindable ? 'Remind' : `Remind in ${canRemindAt(m.lastRemindedAt).inHours} h`}
                        </Btn>
                        <Btn kind="ghost" style={{ height: 36, fontSize: 13, borderRadius: 11 }} disabled={!!busy} onClick={() => received(m)}>
                          {busy === `c:${m.id}` ? 'Saving…' : 'Mark as received'}
                        </Btn>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* The group's thread. */}
      <div ref={threadRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 16px 12px', display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 560, margin: '0 auto' }}>
        {items.map((it, k) => it.kind === 'event' ? (it.to ? (
          // Another split of this group: opens it.
          <button key={`e${k}`} type="button" onClick={() => navigate(`/splits/${it.to}`)} style={{ alignSelf: 'center', maxWidth: '86%', textAlign: 'center', fontSize: 12.5, fontWeight: 600, color: 'var(--brand-text)',
            background: 'color-mix(in srgb, var(--brand) 12%, transparent)', border: 'none', cursor: 'pointer', borderRadius: 999, padding: '5px 12px' }}>{it.text} ›</button>
        ) : (
          <div key={`e${k}`} style={{ alignSelf: 'center', maxWidth: '86%', textAlign: 'center', fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)',
            background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', borderRadius: 999, padding: '5px 12px' }}>{it.text}</div>
        )) : (() => {
          const mineMsg = !!myUserId && String(it.m.sender_user_id) === String(myUserId)
          const who = names.get(String(it.m.sender_user_id))
          return (
            <div key={it.m.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', justifyContent: mineMsg ? 'flex-end' : 'flex-start' }}>
              {!mineMsg && <SplitAvatar name={who?.name} username={who?.username} avatar={who?.avatar} size={28} />}
              <div style={{ maxWidth: '76%', padding: '8px 12px', borderRadius: mineMsg ? '16px 16px 6px 16px' : '16px 16px 16px 6px',
                background: mineMsg ? 'color-mix(in srgb, var(--brand) 18%, var(--surface))' : 'var(--surface)', color: 'var(--text-primary)' }}>
                {!mineMsg && <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand-text)', marginBottom: 2 }}>{who?.name ?? 'Someone'}</div>}
                <div style={{ fontSize: 14.5, lineHeight: 1.4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{it.m.body}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', textAlign: 'right', marginTop: 2 }}>{new Date(it.m.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>
              </div>
            </div>
          )
        })())}
      </div>

      {/* Settled: the split is closed (as Google Pay closes a paid bill) - no
          more messages here; split something new, with the same people or
          anyone (as PhonePe adds a new expense to a group). */}
      {settled ? (
        <div style={{ flexShrink: 0, padding: '12px 16px calc(env(safe-area-inset-bottom, 0px) + 14px)', borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
          <p style={{ ...subStyle, textAlign: 'center', marginBottom: 10 }}>All settled 🎉 · This split is closed</p>
          <div style={{ display: 'flex', gap: 10 }}>
            <Btn kind="ghost" style={{ height: 48, fontSize: 14.5 }} onClick={() => navigate('/splits/new')}>New split expense</Btn>
            <Btn style={{ height: 48, fontSize: 14.5 }} onClick={() => navigate('/splits/new', { state: { with: groupPeople, group: s.groupId } })}>Split again with group</Btn>
          </div>
        </div>
      ) : (
      <form onSubmit={e => { e.preventDefault(); void send() }}
        style={{ flexShrink: 0, display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px calc(env(safe-area-inset-bottom, 0px) + 10px)', borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
        <input value={draft} onChange={e => setDraft(e.target.value)} maxLength={1000} placeholder="Message the group" aria-label="Message the group"
          style={{ flex: 1, minWidth: 0, height: 44, borderRadius: 22, border: '1px solid var(--border)', background: 'var(--bg)', padding: '0 16px', fontSize: 15, color: 'var(--text-primary)', outline: 'none' }} />
        <button type="submit" aria-label="Send" disabled={!draft.trim() || sending}
          style={{ width: 44, height: 44, borderRadius: '50%', border: 'none', background: 'var(--brand)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', opacity: !draft.trim() || sending ? 0.5 : 1, flexShrink: 0 }}>
          <Send size={18} />
        </button>
      </form>
      )}
    </div>
  )
}
