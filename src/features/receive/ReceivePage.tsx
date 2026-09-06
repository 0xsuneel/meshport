import { useState, useEffect, useRef } from 'react'
import {Copy, Share2, CheckCircle, ArrowLeft, Lightbulb} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore, useUIStore } from '@/store'
import { Card } from '@/components/ui/Card'
import { UsernameDisplay } from '@/components/ui/UsernameDisplay'
import { Avatar } from '@/components/ui/Avatar'
import { shortenAddress, midShortenAddress, copyToClipboard } from '@/lib/utils'
import { useMediaQuery } from '@/hooks/useMediaQuery'

const APP_URL = 'https://meshport.xyz'

interface CopyRowProps {
  label: string
  value: string
  onCopy: () => void
  copied: boolean
}

function CopyRow({ label, value, onCopy, copied }: CopyRowProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-text-secondary mb-0.5">{label}</p>
        <p className="text-sm font-mono text-text-primary truncate">{value}</p>
      </div>
      <button onClick={onCopy} className="ml-3 p-2 rounded-xl bg-surface border border-border flex-shrink-0 active:scale-90 transition-transform">
        {copied ? <CheckCircle className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4 text-text-secondary" />}
      </button>
    </div>
  )
}

export function ReceivePage() {
  const isDesktop  = useMediaQuery('(min-width: 980px)')
  const navigate   = useNavigate()
  const user = useAuthStore(s => s.user)
  const username = useAuthStore(s => s.username)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const [copied, setCopied]   = useState<string | null>(null)
  const { showToastMessage } = useUIStore()
  const canvasRef             = useRef<HTMLCanvasElement>(null)
  const [qrReady, setQrReady] = useState(false)
  const [qrError, setQrError] = useState(false)

  if (!user) return null

  const displayUsername = (username || (user?.username || '')).replace(/\.arc$/, '')

  // Payment link — the real shareable URL
  const paymentLink = displayUsername
    ? `${APP_URL}/pay/${displayUsername}`
    : walletAddress
    ? `${APP_URL}/pay/${walletAddress}`
    : APP_URL

  // QR encodes the raw wallet address — not the pay link. External wallets
  // (MetaMask, OKX Wallet, Trust Wallet, etc.) recognize a bare 0x… address
  // in a QR as "send to this address" and act on it directly; a plain
  // https:// link isn't a wallet address to them, so scanning it just
  // opened the page in a browser instead of prefilling a send screen —
  // that's why external-wallet scans were showing the pay link instead of
  // an address to send to.
  //
  // MeshPort's own scanner (ScannerPage.tsx) already handles a bare address
  // the same way it handles any pasted/scanned address — it still resolves
  // this back to the MeshPort profile (avatar, username, "Verified
  // MeshPort User") via getUserByWalletAddress — so MeshPort-to-MeshPort
  // scanning behaves exactly the same as before. Falls back to the pay
  // link only in the edge case where the wallet address isn't loaded yet.
  const qrData = walletAddress || paymentLink

  // Generate QR
  useEffect(() => {
    if (!qrData || !canvasRef.current) return
    setQrReady(false)
    setQrError(false)

    import('qrcode').then(QRCode => {
      QRCode.toCanvas(canvasRef.current!, qrData, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
        errorCorrectionLevel: 'M',
      }, (err) => {
        if (err) { setQrError(true); return }
        setQrReady(true)
      })
    }).catch(() => setQrError(true))
  }, [qrData])

  const handleCopy = async (value: string, key: string) => {
    const ok = await copyToClipboard(value)
    setCopied(key)
    const label = key === 'link' ? 'Payment link' : key === 'username' ? 'Username' : 'Address'
    showToastMessage(ok ? `${label} copied` : `Could not copy ${label.toLowerCase()}`, ok ? 'success' : 'error')
    setTimeout(() => setCopied(null), 2000)
  }

  const handleShare = async () => {
    const shareData = {
      title: 'Pay me on MeshPort',
      text: displayUsername
        ? `Send USDC to ${displayUsername}.arc on MeshPort ⚡`
        : `Send me USDC on MeshPort`,
      url: paymentLink,
    }
    if (navigator.share) {
      try { await navigator.share(shareData) } catch {}
    } else {
      await handleCopy(paymentLink, 'link')
    }
  }

  // Held in variables so mobile (single stacked column, unchanged order/
  // output) and desktop (left column: QR + link, right column: identity +
  // share) never duplicate this JSX.
  const qrCardSection = (
    <Card className="p-6 flex flex-col items-center gap-4 bg-brand/10 border-brand/20">
      <div className="bg-white rounded-2xl p-3 w-[216px] h-[216px] flex items-center justify-center relative" style={{ border: '1px solid var(--border)' }}>
        <canvas
          ref={canvasRef}
          className={`rounded transition-opacity ${qrReady ? 'opacity-100' : 'opacity-0'}`}
          style={{ width: 200, height: 200 }}
        />
        {!qrReady && !qrError && qrData && (
          <div className="absolute inset-0 flex items-center justify-center rounded-2xl">
            <div className="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {qrError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl bg-white">
            <p className="text-danger text-xs text-center px-2">QR generation failed</p>
            <button onClick={() => { setQrError(false); setQrReady(false) }}
              className="text-brand text-xs underline">Retry</button>
          </div>
        )}
        {!qrData && (
          <p className="text-text-secondary text-xs text-center px-4">No wallet connected</p>
        )}
      </div>

      {/* Identity */}
      {(displayUsername || walletAddress) && (
        <div className="flex flex-col items-center gap-1">
          <Avatar name={displayUsername || 'User'} src={user.avatar} size="sm" />
          {displayUsername && (
            <UsernameDisplay username={displayUsername} size="lg" className="justify-center" />
          )}
          {walletAddress && (
            <p className="text-xs text-text-secondary font-mono">{midShortenAddress(walletAddress)}</p>
          )}
        </div>
      )}
    </Card>
  )

  const paymentLinkSection = (
    <Card className="p-4">
      <p className="text-xs text-text-secondary mb-2 font-semibold uppercase tracking-wide">Payment Link</p>
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm text-brand font-mono truncate">{paymentLink}</p>
        <button onClick={() => handleCopy(paymentLink, 'link')}
          className="p-2 rounded-xl bg-surface border border-border flex-shrink-0 active:scale-90 transition-transform">
          {copied === 'link'
            ? <CheckCircle className="w-4 h-4 text-success" />
            : <Copy className="w-4 h-4 text-text-secondary" />}
        </button>
      </div>
    </Card>
  )

  const copyFieldsSection = (
    <Card className="divide-y divide-border">
      {displayUsername && (
        <CopyRow
          label="Username"
          value={displayUsername + '.arc'}
          onCopy={() => handleCopy(displayUsername + '.arc', 'username')}
          copied={copied === 'username'}
        />
      )}
      {walletAddress && (
        <CopyRow
          label="Wallet Address"
          value={shortenAddress(walletAddress)}
          onCopy={() => handleCopy(walletAddress, 'address')}
          copied={copied === 'address'}
        />
      )}
    </Card>
  )

  const shareButtonSection = (
    <button onClick={handleShare}
      className="w-full flex items-center justify-center gap-2 py-4 bg-brand text-white font-semibold rounded-2xl shadow-elevation-2 active:scale-95 transition-transform"
      style={{ border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
      <Share2 className="w-5 h-5" /> Share Payment Link
    </button>
  )

  const tipSection = (
    <div className="p-3 bg-surface rounded-2xl border border-border flex items-start gap-2">
      <Lightbulb className="w-4 h-4 text-text-secondary flex-shrink-0 mt-0.5" />
      <p className="text-xs text-text-secondary flex-1">
        Anyone who scans this QR or opens the link can send you USDC instantly
      </p>
    </div>
  )

  return (
    <div className={`flex flex-col h-screen bg-bg overflow-hidden ${isDesktop ? '' : 'lg:max-w-[720px]'}`}>

      {/* Header */}
      <div className="header-row sticky top-0 z-20 backdrop-blur-md bg-bg/95 flex-shrink-0 gap-3 px-5 pt-header pb-header">
        {!isDesktop && (
          <button onClick={() => navigate('/')} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <div>
          <h1 className="text-xl font-bold text-text-primary">Receive USDC</h1>
          <p className="text-text-secondary text-xs mt-0.5">Share your QR or link to receive payments</p>
        </div>
      </div>

      {isDesktop ? (
        // Full-bleed 2-column split (no maxWidth cap), same gap/padding
        // treatment as Swap's desktop layout. Left: QR only. Right:
        // payment link (above username) + identity/copy fields + share + tip.
        <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 28, padding: '20px 24px 14px', boxSizing: 'border-box' }}>
          <div style={{ flex: '1 1 0%', minWidth: 0, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {qrCardSection}
          </div>
          <div style={{ flex: '1 1 0%', minWidth: 0, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {paymentLinkSection}
            {copyFieldsSection}
            {shareButtonSection}
            {tipSection}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 space-y-4 pb-8">
            {qrCardSection}
            {paymentLinkSection}
            {copyFieldsSection}
            {shareButtonSection}
            {tipSection}
          </div>
        </div>
      )}
    </div>
  )
}
