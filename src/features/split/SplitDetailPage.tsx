// One split. Its creator sees every person (Paid / Pending), can Remind
// someone who hasn't paid (once every 12 hours) or mark a share received when
// it was paid another way; it reads "All settled" once everyone has paid.
// Someone in the split sees the bill, the progress and their own share, with
// Pay - the usual payment of that request, passcode and all.
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { getSplit, remindSplitMember, markSplitReceived, isSettled, memberOpen, money, SPLITS_CHANGED_EVENT, type SplitSummary, type SplitMember } from '@/lib/splits'
import { canRemindAt } from '@/lib/businessBills'
import { useUIStore } from '@/store'
import { SplitHeader, SplitAvatar, ListCard, ProgressBar, Pill, ActionBar, Btn, Tick, card, rowStyle, subStyle, nameStyle, amountStyle, when } from './splitUi'

export function SplitDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const showToastMessage = useUIStore(st => st.showToastMessage)
  const toast = { show: (m: string, t: 'success' | 'error') => showToastMessage(m, t) }
  const [s, setS] = useState<SplitSummary | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => getSplit(id).then(v => { setS(v); setError('') }).catch(e => setError(e instanceof Error ? e.message : 'Could not load the split')), [id])
  useEffect(() => {
    void load()
    // Live enough: a friend's payment shows within seconds.
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 8000)
    const on = () => void load()
    window.addEventListener(SPLITS_CHANGED_EVENT, on)
    return () => { clearInterval(t); window.removeEventListener(SPLITS_CHANGED_EVENT, on) }
  }, [load])

  const back = () => (window.history.length > 1 ? navigate(-1) : navigate('/splits', { replace: true }))
  const remind = async (m: SplitMember) => {
    setBusy(`r:${m.id}`)
    try { await remindSplitMember(m.id); toast.show(`Reminded ${m.name ?? m.username}`, 'success'); await load() }
    catch (e) { toast.show(e instanceof Error ? e.message : 'Could not remind', 'error') }
    finally { setBusy(null) }
  }
  const received = async (m: SplitMember) => {
    setBusy(`c:${m.id}`)
    try { await markSplitReceived(m.code); toast.show(`${m.name ?? m.username}'s share marked as received`, 'success'); await load() }
    catch (e) { toast.show(e instanceof Error ? e.message : 'Could not update', 'error') }
    finally { setBusy(null) }
  }
  const payMine = async (code: string) => {
    setBusy('pay')
    try {
      const { getPayment, orderPaySendUrl } = await import('@/lib/merchantPay')
      navigate(orderPaySendUrl(await getPayment(code)))
    } catch (e) { toast.show(e instanceof Error ? e.message : 'Could not open the payment', 'error') }
    finally { setBusy(null) }
  }

  const title = s ? `${s.emoji ? `${s.emoji} ` : ''}${s.title}` : 'Split'
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
  const owedTotal = s.members.reduce((a, m) => a + m.amount, 0)
  const mine = !s.isCreator ? s.members[0] : null

  return (
    <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', background: 'var(--bg)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <SplitHeader title={title} onBack={back} />
      <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 14, width: '100%', maxWidth: 560, margin: '0 auto' }}>
        {s.isCreator ? (settled ? (
          <div style={{ ...card, textAlign: 'center', padding: '24px 16px' }}>
            <Tick size={64} />
            <div style={{ fontSize: 19, fontWeight: 700, marginTop: 12, color: 'var(--text-primary)' }}>All settled</div>
            <div style={{ ...subStyle, marginTop: 4 }}>You got back {money(owedTotal)} from {s.requests} {s.requests === 1 ? 'person' : 'people'}</div>
            <div style={{ marginTop: 14 }}><ProgressBar value={1} /></div>
          </div>
        ) : (
          <div style={card}>
            <div style={subStyle}>You get back</div>
            <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.6px', color: 'var(--text-primary)' }}>
              {money(s.owedLeft)} <span style={{ ...subStyle, fontSize: 14, fontWeight: 600 }}>left of {money(owedTotal)}</span>
            </div>
            <div style={{ marginTop: 12 }}><ProgressBar value={s.requests ? s.paidCount / s.requests : 0} /></div>
            <div style={{ ...subStyle, marginTop: 8 }}>{s.paidCount} of {s.requests} paid · Bill {money(s.total)} · {when(s.createdAt)}</div>
          </div>
        )) : (
          <div style={card}>
            <div style={subStyle}>{s.creator.name ?? `${s.creator.username}.arc`} split {money(s.total)} with {s.people - 1} {s.people - 1 === 1 ? 'person' : 'people'}</div>
            <div style={{ ...subStyle, marginTop: 10 }}>Your share</div>
            <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.6px', color: 'var(--text-primary)' }}>{money(mine?.amount ?? 0)}</div>
            <div style={{ marginTop: 12 }}><ProgressBar value={s.requests ? s.paidCount / s.requests : 0} /></div>
            <div style={{ ...subStyle, marginTop: 8 }}>{s.paidCount} of {s.requests} paid · {when(s.createdAt)}</div>
          </div>
        )}

        <ListCard>{s.members.map(m => {
          const paid = m.status === 'paid'
          const open = memberOpen(m)
          const remindable = s.isCreator && open && canRemindAt(m.lastRemindedAt).ok
          return (
            <div key={m.id}>
              <div style={rowStyle}>
                <SplitAvatar name={m.name} username={m.username} avatar={m.avatar} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={nameStyle}>{s.isCreator ? (m.name ?? `${m.username}.arc`) : 'Your share'}</div>
                  <div style={subStyle}>{paid
                    ? (m.completedByMe ? `Marked received · ${when(m.paidAt)}` : `Paid ${when(m.paidAt)} · on Arc`)
                    : m.status === 'partially_paid' ? `Paid ${money(m.received)} so far`
                    : open ? `Requested ${when(m.createdAt)}${m.lastRemindedAt ? ` · reminded ${when(m.lastRemindedAt)}` : ''}`
                    : m.status}</div>
                </div>
                <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                  <div style={amountStyle}>{money(m.amount)}</div>
                  <Pill tone={paid ? 'paid' : open || m.status === 'processing' ? 'pending' : 'muted'}>{paid ? (m.completedByMe ? 'Received' : 'Paid') : m.status === 'processing' ? 'Paying…' : open ? 'Pending' : m.status}</Pill>
                </div>
              </div>
              {s.isCreator && open && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <Btn kind="soft" style={{ height: 40, fontSize: 13.5, borderRadius: 12 }} disabled={!remindable || !!busy} onClick={() => remind(m)}>
                    <Bell size={15} />{busy === `r:${m.id}` ? 'Reminding…' : remindable ? 'Remind' : `Remind in ${canRemindAt(m.lastRemindedAt).inHours} h`}
                  </Btn>
                  <Btn kind="ghost" style={{ height: 40, fontSize: 13.5, borderRadius: 12 }} disabled={!!busy} onClick={() => received(m)}>
                    {busy === `c:${m.id}` ? 'Saving…' : 'Mark as received'}
                  </Btn>
                </div>
              )}
            </div>
          )
        })}</ListCard>

        {s.isCreator && !settled && (
          <p style={{ ...subStyle, textAlign: 'center' }}>"Mark as received" when they paid you in cash or another way.<br />The split closes by itself once everyone has paid.</p>
        )}
        {s.isCreator && s.myShare > 0 && (
          <div style={{ ...card, ...rowStyle }}>
            <SplitAvatar you />
            <div style={{ flex: 1 }}><div style={nameStyle}>Your share</div><div style={subStyle}>{s.sourceTx ? 'Paid with the bill' : 'Not requested'}</div></div>
            <div style={{ ...amountStyle, color: 'var(--text-secondary)' }}>{money(s.myShare)}</div>
          </div>
        )}
      </div>
      <ActionBar>
        {!s.isCreator && mine && memberOpen(mine)
          ? <Btn disabled={busy === 'pay'} onClick={() => payMine(mine.code)}>{busy === 'pay' ? 'Opening…' : `Pay ${money(Math.max(0, mine.amount - mine.received))}`}</Btn>
          : <Btn kind={settled ? 'primary' : 'ghost'} onClick={() => navigate('/splits', { replace: true })}>{settled ? 'Done' : 'All splits'}</Btn>}
      </ActionBar>
    </div>
  )
}
