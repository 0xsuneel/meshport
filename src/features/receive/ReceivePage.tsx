import { useState, useEffect, useRef } from 'react'
import { Copy, Share2, CheckCircle, ArrowLeft, Lightbulb, DollarSign, Download, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { parseUnits } from 'viem'
import { ARC } from '@/blockchain/chains'
import { useAuthStore, useUIStore } from '@/store'
import { Card } from '@/components/ui/Card'
import { shortenAddress, copyToClipboard } from '@/lib/utils'
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

  // ── Collect USDC — request a specific amount ──────────────────────────
  // Same feature as Home's "My QR" card (MyQrCard in HomePage.tsx):
  // setting an amount switches the QR from the raw wallet address to an
  // EIP-681 URI carrying that amount, so any external wallet's scanner
  // prefills the send screen with it.
  const [collecting, setCollecting] = useState(false)
  const [amountInput, setAmountInput] = useState('')
  const [activeAmount, setActiveAmount] = useState<string | null>(null)

  if (!user) return null

  const displayUsername = (username || (user?.username || '')).replace(/\.arc$/, '')

  // Payment link — the real shareable URL
  const paymentLink = displayUsername
    ? `${APP_URL}/pay/${displayUsername}`
    : walletAddress
    ? `${APP_URL}/pay/${walletAddress}`
    : APP_URL

  // QR payload — same logic as Home's MyQrCard. No amount: the plain wallet
  // address, which every wallet's scanner (MetaMask, Rabby, Coinbase
  // Wallet, OKX, Binance, MeshPort itself) recognizes as "pay this
  // address". With an amount: EIP-681 (`ethereum:<address>@<chainId>?value=
  // <wei>`), the actual cross-wallet standard for "pay this address this
  // amount" — MetaMask, Rabby, Coinbase Wallet, Trust, and OKX all prefill
  // both fields from it directly. Falls back to the pay link only in the
  // edge case where the wallet address isn't loaded yet.
  const qrData = (() => {
    if (!activeAmount || !walletAddress) return walletAddress || paymentLink
    try {
      const wei = parseUnits(activeAmount, 18)
      return `ethereum:${walletAddress}@${ARC.chainId}?value=${wei.toString()}`
    } catch {
      return walletAddress || paymentLink
    }
  })()

  // Auto-hide the Collect QR after 30s of inactivity if the person never
  // taps the ✕ themselves — same as Home's MyQrCard, so a requested-amount
  // QR doesn't linger indefinitely and get reused for a different amount
  // by accident.
  useEffect(() => {
    if (!activeAmount) return
    const timer = setTimeout(() => setActiveAmount(null), 30000)
    return () => clearTimeout(timer)
  }, [activeAmount])

  // Generate QR
  useEffect(() => {
    if (!qrData || !canvasRef.current) return
    setQrReady(false)
    setQrError(false)

    import('qrcode').then(QRCode => {
      QRCode.toCanvas(canvasRef.current!, qrData, {
        width: 236,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
        errorCorrectionLevel: 'H',
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

  // ── Download / Share QR — same feature as Home's MyQrCard ─────────────
  const handleDownloadQr = () => {
    if (!canvasRef.current) return
    try {
      const link = document.createElement('a')
      link.download = activeAmount
        ? `meshport-qr-${walletAddress?.slice(0, 8)}-$${activeAmount}.png`
        : `meshport-qr-${walletAddress?.slice(0, 8)}.png`
      link.href = canvasRef.current.toDataURL('image/png')
      link.click()
    } catch {
      showToastMessage('Could not download QR', 'error')
    }
  }

  const handleShareQr = async () => {
    if (!canvasRef.current || !qrData || !walletAddress) return
    try {
      canvasRef.current.toBlob(async (blob) => {
        if (!blob) { showToastMessage('Could not share QR', 'error'); return }
        const file = new File([blob], 'meshport-qr.png', { type: 'image/png' })
        const qrShareLink = paymentLink + (activeAmount ? `?amount=${encodeURIComponent(activeAmount)}` : '')
        const shareText = activeAmount
          ? `Pay me $${activeAmount} USDC on MeshPort — ${qrShareLink}`
          : `Pay me on MeshPort — ${qrShareLink}`
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'My QR', text: shareText })
        } else if (navigator.share) {
          await navigator.share({ title: 'My QR', text: shareText })
        } else {
          await navigator.clipboard.writeText(shareText)
          showToastMessage('Copied to clipboard', 'success')
        }
      }, 'image/png')
    } catch (err: any) {
      if (err?.name !== 'AbortError') showToastMessage('Could not share QR', 'error')
    }
  }

  const startCollecting = () => {
    setAmountInput(activeAmount || '')
    setCollecting(true)
  }

  const confirmAmount = () => {
    const value = amountInput.trim()
    const numeric = Number(value)
    if (!value || !(numeric > 0)) {
      showToastMessage('Enter a valid amount', 'error')
      return
    }
    setActiveAmount(numeric.toString())
    setCollecting(false)
  }

  const resetToAddress = () => {
    setActiveAmount(null)
    setAmountInput('')
    setCollecting(false)
  }

  // Held in variables so mobile (single stacked column, unchanged order/
  // output) and desktop (left column: QR, right column: username/address +
  // share) never duplicate this JSX.
  const qrCardSection = (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
      background: 'var(--surface)', borderRadius: 16, border: '1px solid var(--border)',
      padding: 16, boxShadow: 'var(--shadow-1)', width: '100%', boxSizing: 'border-box',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%' }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
          {activeAmount ? `Collect $${activeAmount}` : 'My QR'}
        </span>
        {activeAmount && (
          <button
            onClick={resetToAddress}
            aria-label="Back to My QR"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', padding: 2, cursor: 'pointer' }}>
            <X size={14} style={{ color: 'var(--text-secondary)' }} />
          </button>
        )}
      </div>

      <div className="relative" style={{
        width: 242, height: 242, borderRadius: 12, background: '#DEE6E8',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <canvas
          ref={canvasRef}
          className={`transition-opacity ${qrReady ? 'opacity-100' : 'opacity-0'}`}
          style={{ width: 236, height: 236, borderRadius: 10 }}
        />
        {!qrReady && !qrError && qrData && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl">
            <div className="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {qrError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-white">
            <p className="text-danger text-xs text-center px-2">QR generation failed</p>
            <button onClick={() => { setQrError(false); setQrReady(false) }}
              className="text-brand text-xs underline">Retry</button>
          </div>
        )}
        {!qrData && (
          <p className="text-text-secondary text-xs text-center px-4">No wallet connected</p>
        )}
      </div>

      {/* Collect USDC — amount entry / trigger */}
      {collecting ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', boxSizing: 'border-box' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4, width: '100%', boxSizing: 'border-box',
            border: '1px solid var(--border)', borderRadius: 10, padding: '8px 10px',
          }}>
            <span style={{ fontSize: 14, color: 'var(--text-secondary)', fontWeight: 600 }}>$</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              autoFocus
              placeholder="0.00"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmAmount() }}
              style={{
                width: '100%', minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
                fontSize: 15, color: 'var(--text-primary)',
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, width: '100%', boxSizing: 'border-box' }}>
            <button
              onClick={() => setCollecting(false)}
              style={{
                flex: 1, minWidth: 0, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)',
                background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}>
              Cancel
            </button>
            <button
              onClick={confirmAmount}
              style={{
                flex: 1, minWidth: 0, padding: '8px 14px', borderRadius: 10, border: 'none',
                background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}>
              Generate
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={startCollecting}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'transparent', border: '1px solid var(--border)', borderRadius: 10,
            padding: '8px 14px', cursor: 'pointer', color: 'var(--text-primary)',
          }}>
          <DollarSign size={14} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {activeAmount ? 'Change amount' : 'Collect USDC'}
          </span>
        </button>
      )}

      {/* Divider + Download/Share row — same layout as Home's MyQrCard */}
      <div style={{ width: '100%', height: 1, background: 'var(--border)', margin: '6px 0 2px' }} />
      <div style={{ display: 'flex', width: '100%', alignItems: 'stretch' }}>
        <button
          onClick={handleDownloadQr}
          disabled={!qrReady}
          style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            background: 'transparent', border: 'none', padding: '12px 8px',
            color: qrReady ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontSize: 14, fontWeight: 600, cursor: qrReady ? 'pointer' : 'default',
          }}>
          <Download size={17} />
          Download QR
        </button>
        <div style={{ width: 1, background: 'var(--border)' }} />
        <button
          onClick={handleShareQr}
          disabled={!qrReady}
          style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            background: 'transparent', border: 'none', padding: '12px 8px',
            color: qrReady ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontSize: 14, fontWeight: 600, cursor: qrReady ? 'pointer' : 'default',
          }}>
          <Share2 size={17} />
          Share QR
        </button>
      </div>
    </div>
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
        // username/address + share + tip.
        <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 28, padding: '20px 24px 14px', boxSizing: 'border-box' }}>
          <div style={{ flex: '1 1 0%', minWidth: 0, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {qrCardSection}
          </div>
          <div style={{ flex: '1 1 0%', minWidth: 0, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {copyFieldsSection}
            {shareButtonSection}
            {tipSection}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 space-y-4 pb-8">
            {qrCardSection}
            {copyFieldsSection}
            {shareButtonSection}
            {tipSection}
          </div>
        </div>
      )}
    </div>
  )
}
