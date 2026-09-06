import { useState, useEffect } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { Zap, Copy, CheckCircle, ArrowRight, ArrowLeft, Home, Globe, Lock, DollarSign } from 'lucide-react'
import { getUserByUsername } from '@/lib/supabase'
import { useAuthStore, useUIStore } from '@/store'
import { Avatar } from '@/components/ui/Avatar'
import { copyToClipboard } from '@/lib/utils'
import { useMediaQuery } from '@/hooks/useMediaQuery'

const APP_URL = 'https://meshport.xyz'

const BENEFITS = [
  {
    icon: <Zap className="w-5 h-5" style={{ color: 'var(--brand)' }} />,
    bg: 'color-mix(in srgb, var(--brand) 15%, transparent)',
    label: 'Sub-second',
    desc: 'Confirms in under a second',
  },
  {
    icon: <DollarSign className="w-5 h-5" style={{ color: 'var(--success)' }} />,
    bg: 'color-mix(in srgb, var(--success) 12%, transparent)',
    label: 'Near-zero fees',
    desc: '~$0.01 per transfer',
  },
  {
    icon: <Lock className="w-5 h-5" style={{ color: 'var(--accent-text)' }} />,
    bg: 'color-mix(in srgb, var(--accent) 12%, transparent)',
    label: 'Non-custodial',
    desc: 'Only you hold your keys',
  },
  {
    icon: <Globe className="w-5 h-5" style={{ color: 'var(--warning)' }} />,
    bg: 'color-mix(in srgb, var(--warning) 12%, transparent)',
    label: 'Global',
    desc: 'Send USDC anywhere',
  },
]

export function PayPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const { username }        = useParams<{ username: string }>()
  const navigate            = useNavigate()
  const [searchParams]      = useSearchParams()
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)

  // Optional `?amount=` — set when this pay link came from a "Collect USDC"
  // QR/link generated on the Home screen. When present, the amount is
  // carried straight through into the Send flow so the payer never has to
  // type it in themselves; they only confirm and sign.
  const amountParam = searchParams.get('amount')
  const requestedAmount = amountParam && Number(amountParam) > 0 ? amountParam : null

  const [recipient, setRecipient] = useState<any>(null)
  const [loading, setLoading]     = useState(true)
  const [notFound, setNotFound]   = useState(false)
  const [copied, setCopied]       = useState(false)
  const { showToastMessage } = useUIStore()

  const clean = (username ?? '').toLowerCase().replace(/\.arc$/, '').trim()

  useEffect(() => {
    if (!clean) { setNotFound(true); setLoading(false); return }
    getUserByUsername(clean)
      .then(u => { if (u) setRecipient(u); else setNotFound(true) })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false))
  }, [clean])

  const handlePay = () => {
    const walletAddr = recipient?.wallet_address
    const toParam = `${clean}|${walletAddr}|${recipient?.display_name || clean}|${recipient?.avatar_url || ''}`
    const sendUrl = `/pay-send?to=${encodeURIComponent(toParam)}${requestedAmount ? `&amount=${encodeURIComponent(requestedAmount)}` : ''}`
    if (isAuthenticated) {
      navigate(sendUrl, { state: { returnTo: '/payment-link' } })
    } else {
      try { sessionStorage.setItem('meshport_return_to', sendUrl) } catch {}
      navigate('/auth')
    }
  }

  const handleCopy = async () => {
    const ok = await copyToClipboard(`${APP_URL}/pay/${clean}`)
    setCopied(true)
    showToastMessage(ok ? 'Payment link copied' : 'Could not copy link', ok ? 'success' : 'error')
    setTimeout(() => setCopied(false), 2000)
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="w-10 h-10 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'color-mix(in srgb, var(--brand) 30%, transparent)', borderTopColor: 'var(--brand)' }} />
      </div>
    )
  }

  if (notFound || !recipient) {
    return (
      <div className="h-full flex flex-col items-center justify-center px-6 text-center gap-4" style={{ background: 'var(--bg)' }}>
        <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 20%, transparent)' }}>
          <span className="text-2xl">🔍</span>
        </div>
        <h1 className="text-xl font-bold text-text-primary">User not found</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          <span className="font-semibold" style={{ color: 'var(--brand)' }}>{clean}.arc</span> doesn't exist on MeshPort.
        </p>
        <button onClick={() => navigate('/')}
          className="mt-2 px-6 py-3 rounded-2xl text-sm font-bold text-white flex items-center gap-2"
          style={{ background: 'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
          <Home className="w-4 h-4" /> Back to Home
        </button>
      </div>
    )
  }

  const displayName = recipient.display_name || clean

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg)' }}>

      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-12 pb-4">
        {!isDesktop && (
          <button onClick={() => navigate('/')} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="MeshPort" className="w-6 h-6 rounded-lg" />
          <span className="text-text-primary font-bold text-sm">MeshPort</span>
        </div>
        <button onClick={handleCopy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs active:scale-95 transition-transform"
          style={{ background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)', color: 'var(--text-secondary)' }}>
          {copied ? <CheckCircle className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </div>

      <div className="flex-1 flex flex-col px-5 pb-10 gap-6">

        {/* Recipient */}
        <div className="flex flex-col items-center gap-3 pt-2">
          <Avatar name={displayName} src={recipient.avatar_url} size="xl" showRing />
          <div className="text-center">
            <h2 className="text-2xl font-bold text-text-primary">{displayName}</h2>
            <p className="font-semibold mt-1 text-sm" style={{ color: 'var(--brand)' }}>{clean}.arc</p>
            {requestedAmount ? (
              <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>is requesting</p>
            ) : (
              <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>Send money to {displayName} on MeshPort</p>
            )}
          </div>
          {requestedAmount && (
            <p className="text-4xl font-extrabold text-text-primary">${requestedAmount}</p>
          )}
        </div>

        {/* Pay button — Option C */}
        <button onClick={handlePay}
          className="w-full flex items-center gap-4 active:scale-[.98] transition-all"
          style={{
            background: 'var(--brand)',
            border: '1px solid color-mix(in srgb, black 12%, transparent)',
            borderRadius: 18,
            padding: '0',
            overflow: 'hidden',
          }}>
          {/* Icon panel */}
          <div className="flex items-center justify-center flex-shrink-0"
            style={{ width: 64, height: 64, background: 'rgba(0,0,0,0.22)' }}>
            <Zap className="w-6 h-6 text-white" />
          </div>
          {/* Text */}
          <div className="flex-1 text-left">
            <p className="text-white font-extrabold text-[17px] leading-tight">
              {requestedAmount ? `Pay $${requestedAmount}` : `Pay ${clean}.arc`}
            </p>
            <p className="text-xs font-medium mt-0.5" style={{ color: 'rgba(255,255,255,0.55)' }}>
              {requestedAmount ? `to ${clean}.arc` : 'Tap to enter amount'}
            </p>
          </div>
          {/* Arrow circle */}
          <div className="flex items-center justify-center flex-shrink-0 rounded-full mr-4"
            style={{ width: 36, height: 36, background: 'rgba(255,255,255,0.12)' }}>
            <ArrowRight className="w-4 h-4 text-white" />
          </div>
        </button>

        {!isAuthenticated && (
          <p className="text-xs text-center -mt-3" style={{ color: 'var(--text-muted)' }}>
            You'll sign in to complete the payment
          </p>
        )}

        {/* Divider */}
        <div style={{ borderTop: '1px solid var(--border)' }} />

        {/* Why MeshPort */}
        <div>
          <p className="text-xs font-semibold mb-3" style={{ color: 'var(--text-secondary)', letterSpacing: '0.06em' }}>WHY MESHPORT</p>
          <div className="grid grid-cols-2 gap-2.5">
            {BENEFITS.map(b => (
              <div key={b.label}
                className="flex flex-col gap-3 p-3.5 rounded-2xl"
                style={{ background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)' }}>
                <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: b.bg }}>
                  {b.icon}
                </div>
                <div>
                  <p className="text-[13px] font-bold text-text-primary leading-tight">{b.label}</p>
                  <p className="text-[11px] mt-0.5 leading-snug" style={{ color: 'var(--text-secondary)' }}>{b.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col items-center gap-3 pt-2 pb-2">
          {/* Back to Home — medium pill button, clearly visible */}
          <button onClick={() => navigate('/')}
            className="flex items-center gap-2 px-6 py-3 rounded-2xl active:scale-95 transition-transform"
            style={{
              background: 'color-mix(in srgb, var(--text-primary) 7%, transparent)',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              fontSize: 14,
              fontWeight: 600,
            }}>
            <Home className="w-4 h-4" />
            Back to Home
          </button>

          {/* Powered by MeshPort */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full"
            style={{ background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)' }}>
            <div className="w-4 h-4 rounded-md flex items-center justify-center" style={{ background: 'var(--brand)' }}>
              <Zap className="w-2.5 h-2.5 text-white" />
            </div>
            <span style={{ color: 'var(--text-secondary)', fontSize: 11, fontWeight: 500 }}>Powered by MeshPort</span>
          </div>
        </div>

      </div>
    </div>
  )
}
