import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store'
import { formatAmount } from '@/lib/utils'
import { fetchRecentContacts, recentSendTarget, RECENT_AVATAR_COLORS, type RecentContact } from '@/lib/recentContacts'
import { useMediaQuery } from '@/hooks/useMediaQuery'

// Same "Recent" as the Home avatar row and the Send page recent row (see
// src/lib/recentContacts.ts), just scanning more history and showing more
// people since this is the full "View all" list.
type RecentPerson = RecentContact

function Avatar({ person, size, color }: { person: RecentPerson; size: number; color: string }) {
  const [ok, setOk] = useState(true)
  const initial = person.isSelf
    ? 'Y'
    : ((person.display_name || person.username || person.wallet_address || 'U')
        .replace(/\.arc$/, '')).charAt(0).toUpperCase()
  if (person.avatar_url && ok) {
    return (
      <img src={person.avatar_url} alt={initial} onError={() => setOk(false)}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover',
          border: '1px solid var(--border)', flexShrink: 0 }}/>
    )
  }
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: color,
      border: '1px solid var(--border)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: size * 0.4, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
      {initial}
    </div>
  )
}

const COLORS = RECENT_AVATAR_COLORS

export function RecentPaidPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const [people, setPeople]   = useState<RecentPerson[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!walletAddress) { setLoading(false); return }

    const load = async () => {
      try {
        // Same Home Avatar Recent logic, just scanning more activity history
        // (100 rows per direction) and returning more people (20) for the
        // full list.
        const result = await fetchRecentContacts(walletAddress, { activityLimit: 100, maxAddresses: 30, resultLimit: 20 })
        setPeople(result)
      } catch (e) {
        console.error('RecentPaidPage error:', e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [walletAddress])

  const shortName = (p: RecentPerson) => {
    if (p.isSelf) return 'You'
    const raw = p.display_name || p.username || ''
    if (raw) return raw.replace(/\.arc$/, '').split(' ')[0]
    return p.wallet_address.slice(0, 6) + '...' + p.wallet_address.slice(-6)
  }

  const timeAgoShort = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    if (days < 7) return `${days}d ago`
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  const goSend = (p: RecentPerson) => {
    navigate(`/pay-send?to=${encodeURIComponent(recentSendTarget(p))}`, { state: { returnTo: '/recent-paid' } })
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)', paddingBottom: 90 }}>
      {/* Header */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: 'color-mix(in srgb, var(--bg) 95%, transparent)', backdropFilter: 'blur(20px)',
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 22px)',
        paddingBottom: 18, paddingLeft: 20, paddingRight: 20,
        minHeight: 44, boxSizing: 'border-box',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        {!isDesktop && (
          <button onClick={() => navigate('/')} className="back-btn">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M15 6L9 12l6 6" stroke="var(--text-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        )}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>Recent</div>
        </div>
      </div>

      <div style={{ padding: '16px 20px' }}>
        {loading ? (
          // Skeleton
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {[0,1,2,3,4,5].map(i => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12,
                padding: '14px 0', borderBottom: '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
                <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', flexShrink: 0 }}/>
                <div style={{ flex: 1 }}>
                  <div style={{ width: 100, height: 13, borderRadius: 6, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', marginBottom: 8 }}/>
                  <div style={{ width: 60, height: 10, borderRadius: 6, background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)' }}/>
                </div>
                <div style={{ width: 60, height: 13, borderRadius: 6, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}/>
              </div>
            ))}
          </div>
        ) : people.length === 0 ? (
          <div style={{ textAlign: 'center', paddingTop: 60 }}>
            <div style={{ width: 64, height: 64, borderRadius: 20, background: 'var(--surface)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M7 17L17 7M17 7H9M17 7V15" stroke="var(--text-secondary)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No payments yet</div>
            <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 24 }}>
              People you pay will appear here
            </div>
            <button onClick={() => navigate('/pay-send')}
              style={{ padding: '13px 32px', borderRadius: 14, background: 'var(--brand)',
                color: '#fff', fontSize: 15, fontWeight: 600,
                border: '1px solid color-mix(in srgb, black 12%, transparent)', cursor: 'pointer' }}>
              Make your first payment
            </button>
          </div>
        ) : (
          <div style={{ background: 'var(--surface)', borderRadius: 16, border: '1px solid var(--border)', overflow: 'hidden' }}>
            {people.map((p, i) => (
              <div key={p.wallet_address}
                onClick={() => goSend(p)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '14px 16px', cursor: 'pointer',
                  borderBottom: i < people.length - 1 ? '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)' : 'none',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 2%, transparent)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <Avatar person={p} size={48} color={COLORS[i % COLORS.length]} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.display_name || (p.username ? p.username.replace(/\.arc$/, '') : p.wallet_address.slice(0, 6) + '...' + p.wallet_address.slice(-6))}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--link)', marginTop: 1, fontFamily: 'monospace',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.username ? (p.username.endsWith('.arc') ? p.username : p.username + '.arc') : (p.wallet_address.slice(0, 6) + '...' + p.wallet_address.slice(-6))}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                    {p.times_sent > 1 ? `${p.times_sent} payments · ` : ''}{timeAgoShort(p.last_paid)}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                    ${formatAmount(p.last_amount)}
                  </div>
                  {p.times_sent > 1 && (
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                      ${formatAmount(p.total_sent)} total
                    </div>
                  )}
                </div>
                {/* Send arrow */}
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'color-mix(in srgb, var(--brand) 12%, transparent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginLeft: 4 }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M2 12L12 2M12 2H5M12 2V9" stroke="var(--brand)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
