import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Send, X } from 'lucide-react'
import { useAuthStore } from '@/store'
import { submitSupportTicket, fetchMySupportTickets, supabase, type SupportTicket } from '@/lib/supabase'
import { useMediaQuery } from '@/hooks/useMediaQuery'

const SUBJECTS = ['General', 'Payment issue', 'Wallet & security', 'Bug report', 'Other']

const STATUS_STYLE: Record<SupportTicket['status'], { label: string; bg: string; text: string }> = {
  open:        { label: 'Open',        bg: 'bg-brand/15',   text: 'text-brand' },
  in_progress: { label: 'In progress', bg: 'bg-warning/15', text: 'text-warning' },
  resolved:    { label: 'Resolved',    bg: 'bg-success/15', text: 'text-success' },
  closed:      { label: 'Closed',      bg: 'bg-text-secondary/15', text: 'text-text-secondary' },
}

// `embedded`/`onClose` mirror NotificationsPage's own popup treatment
// (see ProfileSubPages.tsx) — DesktopHeader now opens this the same way
// it opens the notifications bell, as a dialog over whatever page the
// person is on, instead of a full-page navigation to /help-support.
// Mobile is untouched: it still only ever reaches this via the real route.
export function HelpSupportPage({ embedded, onClose }: { embedded?: boolean; onClose?: () => void } = {}) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const username = useAuthStore(s => s.username)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const [subject, setSubject] = useState(SUBJECTS[0])
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [tickets, setTickets] = useState<SupportTicket[]>([])
  const [loadingTickets, setLoadingTickets] = useState(true)
  const [toast, setToast] = useState('')

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 2500) }

  const loadTickets = useCallback(async () => {
    if (!user?.id) return
    setLoadingTickets(true)
    const t = await fetchMySupportTickets(user.id)
    setTickets(t)
    setLoadingTickets(false)
  }, [user?.id])

  useEffect(() => { loadTickets() }, [loadTickets])

  // Live-update the ticket list the moment an admin replies, without polling.
  useEffect(() => {
    if (!user?.id) return
    const channel = supabase
      .channel(`support_tickets_${user.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'support_tickets', filter: `user_id=eq.${user.id}` },
        () => loadTickets(),
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [user?.id, loadTickets])

  const handleSubmit = async () => {
    if (!message.trim()) { showToast('Please describe your issue'); return }
    if (!user?.id) { showToast('You need to be signed in'); return }
    setSubmitting(true)
    const res = await submitSupportTicket({
      userId:        user.id,
      walletAddress: walletAddress || null,
      email:         user.email || null,
      username:      username || null,
      subject,
      message:       message.trim(),
    })
    setSubmitting(false)
    if (!res.success) { showToast(res.error || 'Could not submit — try again'); return }
    setMessage('')
    setSubject(SUBJECTS[0])
    showToast('Ticket submitted — we\u2019ll get back to you here')
    loadTickets()
  }

  return (
    <div className={embedded ? 'bg-bg' : 'flex-1 overflow-y-auto'}>
      <div className={embedded
        ? 'flex items-center justify-between px-5 pt-5 pb-4 border-b border-border'
        : 'header-row sticky top-0 z-20 bg-bg/95 backdrop-blur-md justify-between px-5 pt-header pb-header'}>
        <div className="flex items-center gap-3">
          {!embedded && !isDesktop && (
            <button onClick={() => navigate(-1)} className="back-btn">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <h1 className="text-xl font-bold text-text-primary">Help & Support</h1>
        </div>
        {embedded && (
          <button onClick={onClose} aria-label="Close"
            className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 hover:bg-[rgb(var(--text-primary-rgb)/0.08)] transition-colors">
            <X className="w-4 h-4 text-text-secondary" />
          </button>
        )}
      </div>

      <div className={embedded ? 'px-5 pb-6 pt-4 space-y-6 max-h-[70vh] overflow-y-auto' : 'px-5 pb-8 pt-2 space-y-6'}>
        {/* ── New ticket form ── */}
        <div className="bg-surface border border-border rounded-3xl p-5 space-y-4">
          <p className="text-sm font-semibold text-text-primary">Describe your issue</p>

          <div className="flex flex-wrap gap-2">
            {SUBJECTS.map(s => (
              <button key={s} onClick={() => setSubject(s)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  subject === s ? 'bg-brand text-white' : 'bg-surface text-text-secondary border border-border'
                }`}>
                {s}
              </button>
            ))}
          </div>

          <textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder="Tell us what's going on..."
            rows={4}
            className="w-full bg-surface border border-border rounded-2xl px-4 py-3 text-sm text-text-primary placeholder-text-secondary outline-none focus:border-brand resize-none"
          />

          <button onClick={handleSubmit} disabled={submitting}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl text-white text-sm font-semibold active:scale-95 transition-transform disabled:opacity-60"
            style={{ background: 'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
            <Send className="w-4 h-4" /> {submitting ? 'Submitting…' : 'Submit ticket'}
          </button>
        </div>

        {/* ── Ticket history ── */}
        <div>
          <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3 px-1">Your tickets</p>

          {loadingTickets ? (
            <div className="text-center py-8 text-sm text-text-secondary">Loading…</div>
          ) : tickets.length === 0 ? (
            <div className="bg-surface border border-border rounded-3xl p-6 text-center">
              <p className="text-sm text-text-secondary">No tickets yet — anything you submit above will show up here.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {tickets.map(t => {
                const s = STATUS_STYLE[t.status]
                return (
                  <div key={t.id} className="bg-surface border border-border rounded-3xl p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-text-primary">{t.subject}</p>
                        <p className="text-xs text-text-secondary mt-0.5">{new Date(t.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                      </div>
                      <span className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-medium ${s.bg} ${s.text}`}>{s.label}</span>
                    </div>
                    <p className="text-sm text-text-secondary leading-relaxed">{t.message}</p>
                    {t.adminReply && (
                      <div className="bg-[rgb(var(--text-primary-rgb)/0.04)] border border-brand/20 rounded-2xl p-3">
                        <p className="text-xs font-semibold text-brand mb-1">MeshPort Support</p>
                        <p className="text-sm text-text-secondary leading-relaxed">{t.adminReply}</p>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-surface border border-border text-text-primary text-sm px-4 py-2.5 rounded-full shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  )
}
