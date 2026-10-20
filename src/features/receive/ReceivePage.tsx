import { useState, useEffect, useRef } from 'react'
import { Copy, Share2, CheckCircle, ArrowLeft, Lightbulb, Download, ListChecks, User, Store as StoreIcon } from 'lucide-react'
import { AnimatePresence } from 'framer-motion'
import { TokenMenu } from '@/components/ui/TokenMenu'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMerchant, useBusinessTab } from '@/lib/merchant'
import { listStores, type Store } from '@/lib/businessTeam'
import { arcAddressUri } from '@/lib/merchantQr'
import { personalPayLink, shopPayLink } from '@/lib/payLinks'
import { shopFrom } from '@/lib/orderLabels'
import { RequestQrPanel } from './RequestQrPanel'
import { LinkShare } from '@/features/merchant/RequestResult'
import { useAuthStore, useUIStore } from '@/store'
import { Card } from '@/components/ui/Card'
import { shortenAddress, copyToClipboard } from '@/lib/utils'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { drawMeshportQr } from '@/lib/qrLogo'

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

  // One QR for everyone (merchants too - no separate MeshPort / Merchant QR tabs).
  const merchant = useMerchant()
  const [params] = useSearchParams()
  // My QR | Request, side by side like Business → Collect payment. Request
  // makes an order-numbered payment request (same form and screen as Business).
  const [tab, setTab] = useState<'qr' | 'request'>(() => params.get('request') === '1' || params.get('customer') ? 'request' : 'qr')
  const requesting = tab === 'request'
  // Business accounts pick which QR to show, like Pay's token picker:
  // Personal first (a plain payment to the account), then each store's Shop
  // QR (main store first), so each store's payments land in it.
  const business = useBusinessTab()
  const [stores, setStores] = useState<Store[]>([])
  const [qrPick, setQrPick] = useState<string>('personal')
  const [qrMenu, setQrMenu] = useState(false)
  useEffect(() => {
    if (!business) return
    listStores().then(list => setStores([...list].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)))).catch(() => {})
  }, [business])
  const store = stores.find(s => s.id === qrPick) ?? null
  // No stores yet: the business itself is the one shop.
  const shopQr = business && qrPick !== 'personal'
  const qrOptions = business ? [
    { id: 'personal', label: 'Personal', icon: <span className="inline-flex items-center justify-center size-[22px] rounded-full bg-brand/15 text-brand-text"><User className="size-3.5" /></span> },
    ...(stores.length ? stores.map(st => ({ id: st.id, label: st.name, icon: <span className="inline-flex items-center justify-center size-[22px] rounded-full bg-brand/15 text-brand-text"><StoreIcon className="size-3.5" /></span> }))
      : [{ id: 'shop', label: 'Shop QR', icon: <span className="inline-flex items-center justify-center size-[22px] rounded-full bg-brand/15 text-brand-text"><StoreIcon className="size-3.5" /></span> }]),
  ] : []
  const picked = qrOptions.find(o => o.id === qrPick) ?? qrOptions[0]
  if (!user) return null

  const displayUsername = (username || (user?.username || '')).replace(/\.arc$/, '')

  // Payment link - the real shareable URL
  // A business's plain username link is its Shop QR, so the Personal QR says
  // personal=1 (the pay page and the scanner then make a normal payment).
  // (Same builders as Home and the Business tab - payLinks.ts.)
  const paymentLink = displayUsername
    ? (shopQr ? shopPayLink(displayUsername, store?.id) : personalPayLink(displayUsername, business))
    : walletAddress
    ? `${APP_URL}/paylink/${walletAddress}`
    : APP_URL

  // My QR - a personal account's, and a business's Personal QR - is just the
  // address on Arc (ethereum:<address>@<Arc chain id>): a wallet that knows
  // Arc fills in the address and network, one that doesn't still reads the
  // address, and MeshPort's scanner finds the account by its wallet. A shop's
  // QR keeps its pay page link (amount page, payment recorded for the store).
  const qrData = (!shopQr || !displayUsername) && walletAddress ? arcAddressUri(walletAddress) : paymentLink

  // Generate QR
  useEffect(() => {
    if (!qrData || !canvasRef.current) return
    setQrReady(false)
    setQrError(false)

    drawMeshportQr(canvasRef.current, qrData)
      .then(() => setQrReady(true))
      .catch(() => setQrError(true))
    // Redraw when My QR comes back into view (after Request payment) - the
    // canvas is a fresh, empty element then.
  }, [qrData, requesting])

  const handleCopy = async (value: string, key: string) => {
    const ok = await copyToClipboard(value)
    setCopied(key)
    const label = key === 'link' ? 'Payment link' : key === 'username' ? 'Username' : 'Address'
    showToastMessage(ok ? `${label} copied` : `Could not copy ${label.toLowerCase()}`, ok ? 'success' : 'error')
    setTimeout(() => setCopied(null), 2000)
  }

  // A shop's QR is shared as the shop (and its store): "Pay Royal Salons ·
  // Cutting Edge on MeshPort" - the same words as the Business tab's Shop QR.
  const shopName = shopQr ? shopFrom(merchant.storeName || displayUsername, store?.name) : ''
  const handleShare = async () => {
    const shareData = {
      title: shopQr ? `Pay ${shopName}` : 'Pay me on MeshPort',
      text: shopQr ? `Pay ${shopName} on MeshPort`
        : displayUsername
        ? `Send USDC, EURC or cirBTC to ${displayUsername}.arc on MeshPort ⚡`
        : 'Send me USDC, EURC or cirBTC on MeshPort',
      url: paymentLink,
    }
    if (navigator.share) {
      try { await navigator.share(shareData) } catch {}
    } else {
      await handleCopy(paymentLink, 'link')
    }
  }

  // ── Download / Share QR - same feature as Home's MyQrCard ─────────────
  const handleDownloadQr = () => {
    if (!canvasRef.current) return
    try {
      const link = document.createElement('a')
      link.download = `meshport-qr-${walletAddress?.slice(0, 8)}.png`
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
        const shareText = shopQr ? `Pay ${shopName} on MeshPort - ${paymentLink}` : `Pay me on MeshPort - ${paymentLink}`
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

  // Held in variables so mobile (single stacked column, unchanged order/
  // output) and desktop (left column: QR, right column: username/address +
  // share) never duplicate this JSX.
  const qrCardSection = (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
      background: 'var(--surface)', borderRadius: 16, border: '1px solid var(--border)',
      padding: 16, boxShadow: 'var(--shadow-1)', width: '100%', boxSizing: 'border-box',
    }}>
      {business && picked ? (
        // Which QR: the same pill + floating list as Pay's token picker.
        <div style={{ position: 'relative', zIndex: qrMenu ? 41 : undefined, minWidth: 200, maxWidth: '100%' }}>
          <button type="button" onClick={e => { e.stopPropagation(); setQrMenu(v => !v) }} aria-expanded={qrMenu} aria-label={`QR: ${picked.label}`}
            className="w-full flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full active:opacity-70"
            style={{ background: 'color-mix(in srgb, var(--brand) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 35%, transparent)' }}>
            {picked.icon}
            <span className="flex-1 min-w-0 truncate text-left text-sm font-bold text-text-primary">{picked.label}</span>
            <svg className="w-2.5 h-2.5 flex-shrink-0" style={{ color: 'var(--brand-text)', transform: qrMenu ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          <AnimatePresence>
            {qrMenu && <TokenMenu ariaLabel="Choose QR" selected={picked.id} options={qrOptions} onSelect={setQrPick} onClose={() => setQrMenu(false)} />}
          </AnimatePresence>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%' }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>My QR</span>
        </div>
      )}

      {/* The frame hugs the QR: drawMeshportQr sizes the canvas to whole pixels per module (≤236px). */}
      <div className="relative" style={{
        padding: 3, minWidth: 200, minHeight: 200, borderRadius: 12, background: '#DEE6E8',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <canvas
          ref={canvasRef}
          width={236}
          height={236}
          className={qrReady ? 'opacity-100' : 'opacity-0'}
          style={{ borderRadius: 10 }}
        />
        {!qrReady && !qrError && qrData && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl">
            <div className="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {qrError && (
          <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-white">
            <p className="text-danger text-xs text-center px-2">QR generation failed</p>
            <button onClick={() => { setQrError(false); setQrReady(false) }}
              className="text-brand text-xs underline">Retry</button>
          </div>
        )}
        {!qrData && (
          <p className="text-text-secondary text-xs text-center px-4">No wallet connected</p>
        )}
      </div>

      {/* Divider + Download/Share row - same layout as Home's MyQrCard */}
      <div style={{ width: '100%', height: 1, background: 'var(--border)', margin: '6px 0 2px' }} />
      <div style={{ display: 'flex', width: '100%', alignItems: 'stretch' }}>
        <button
          onClick={handleDownloadQr}
          disabled={!qrReady}
          style={{
            flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'clamp(5px, 1.6vw, 8px)',
            background: 'transparent', border: 'none', padding: '12px 6px', whiteSpace: 'nowrap',
            color: qrReady ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontSize: 'clamp(12.5px, 3.8vw, 14px)', fontWeight: 600, cursor: qrReady ? 'pointer' : 'default',
          }}>
          <Download size={17} />
          Download QR
        </button>
        <div style={{ width: 1, background: 'var(--border)' }} />
        <button
          onClick={handleShareQr}
          disabled={!qrReady}
          style={{
            flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'clamp(5px, 1.6vw, 8px)',
            background: 'transparent', border: 'none', padding: '12px 6px', whiteSpace: 'nowrap',
            color: qrReady ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontSize: 'clamp(12.5px, 3.8vw, 14px)', fontWeight: 600, cursor: qrReady ? 'pointer' : 'default',
          }}>
          <Share2 size={17} />
          Share QR
        </button>
      </div>
    </div>
  )

  // A store's QR: its pay link to copy and share (as Business → Shop QR) -
  // not the account's username and address.
  const copyFieldsSection = shopQr ? (
    <LinkShare url={paymentLink} text={`Pay ${shopName} on MeshPort`} />
  ) : (
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

  const shareButtonSection = shopQr ? null : (
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
        {shopQr
          ? `Customers scan, type the amount and pay${store ? ` - counted for ${store.name}` : ''}`
          : 'Scan with MeshPort or any wallet app (MetaMask, OKX, Trust, Coinbase…) - it opens your payment page on Arc'}
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
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="text-xl font-bold text-text-primary">Receive</h1>
          <p className="text-text-secondary text-xs mt-0.5">One QR for USDC, EURC and cirBTC</p>
        </div>
        {/* Requests you made and whether they're paid (Receive → My requests). */}
        <button onClick={() => navigate('/receive/requests')}
          style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 999, cursor: 'pointer',
            border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 700 }}>
          <ListChecks size={15} /> My requests
        </button>
      </div>

      {/* My QR | Request - the same switch as Business → Collect payment. */}
      <div className="px-4 pb-3 flex-shrink-0" style={isDesktop ? { padding: '0 24px 4px', maxWidth: 520 } : undefined}>
        <div className="flex p-1 rounded-2xl" role="tablist" aria-label="How to receive" style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
          {([['qr', 'My QR'], ['request', 'Request']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={`flex-1 rounded-xl text-[14px] font-semibold transition-colors ${tab === id ? 'bg-surface text-text-primary shadow-sm' : 'text-text-muted'}`}
              style={{ height: 36 }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {requesting ? (
        // The request fills the page like Business's Collect payment (its own
        // keypad and button at the bottom); a centred card on desktop.
        <div className="flex-1 min-h-0 flex flex-col" style={isDesktop ? { padding: '12px 24px 20px', alignItems: 'center' } : undefined}>
          <div className="flex-1 min-h-0 flex flex-col w-full" style={isDesktop ? { maxWidth: 460, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 24, boxShadow: 'var(--shadow-1)', overflow: 'hidden' } : undefined}>
            <RequestQrPanel initialCustomer={params.get('customer') ?? undefined} />
          </div>
        </div>
      ) : isDesktop ? (
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
