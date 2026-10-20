import { useState, useEffect, useRef } from 'react'
import { Copy, Share2, CheckCircle, ArrowLeft, Lightbulb, Download, ListChecks } from 'lucide-react'
import { StorePicker, type PickerStore } from '@/features/merchant/StorePicker'
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
import { QrCard } from '@/features/business/ui/QrCard'
import { qrCardFile } from '@/lib/qrCardImage'

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
  // The QR scales to the screen, like payment apps' receive screens: it takes
  // whatever height is left once the header, card and buttons are laid out
  // (150-260px, and never wider than the card), so My QR fits on one screen
  // on any phone or browser size - re-fitted whenever that size changes.
  const shortScreen = useMediaQuery('(max-height: 700px)')
  const fitRef = useRef<HTMLDivElement>(null)
  const [qrSize, setQrSize] = useState(232)
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
  useEffect(() => {
    if (!business) return
    listStores().then(list => setStores([...list].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)))).catch(() => {})
  }, [business])
  const store = stores.find(s => s.id === qrPick) ?? null
  // No stores yet: the business itself is the one shop.
  const shopQr = business && qrPick !== 'personal'
  // Which QR (Switch store): Personal first, then each store (main first).
  const qrOptions: PickerStore[] = business ? [
    { id: 'personal', name: 'Personal', personal: true },
    ...(stores.length ? stores.map(st => ({ id: st.id, name: st.name, isDefault: st.isDefault })) : [{ id: 'shop', name: merchant.storeName || 'Shop QR', isDefault: true }]),
  ] : []
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

  // Fit the QR to the space left (see qrSize).
  useEffect(() => {
    const box = fitRef.current
    const column = box?.firstElementChild as HTMLElement | null
    if (!box || !column || isDesktop) return
    let raf = 0
    const fit = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const spare = box.clientHeight - column.offsetHeight
        // Page padding, card padding and the QR's white tile.
        const byWidth = Math.min(box.clientWidth, 372) - 32 - 32 - 20
        setQrSize(s => {
          const next = Math.round(Math.max(150, Math.min(260, byWidth, s + spare)))
          return Math.abs(next - s) >= 2 ? next : s
        })
      })
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(box); ro.observe(column)
    return () => { ro.disconnect(); cancelAnimationFrame(raf) }
  }, [isDesktop, requesting])

  // Generate QR
  const drawnFor = useRef('')
  const drawSeq = useRef(0)
  useEffect(() => {
    if (!qrData || !canvasRef.current) return
    // A new QR fades in; the same QR re-drawn at a new size just swaps.
    if (drawnFor.current !== qrData) setQrReady(false)
    drawnFor.current = qrData
    setQrError(false)

    // Drawn off screen, then copied in - only if it's still the latest draw:
    // while the size settles an older, slower draw could otherwise land last
    // and leave the QR at the wrong size (cut off, or small in its tile).
    const id = ++drawSeq.current
    const off = document.createElement('canvas')
    drawMeshportQr(off, qrData, qrSize)
      .then(() => {
        const cv = canvasRef.current
        if (id !== drawSeq.current || !cv) return
        cv.width = off.width; cv.height = off.height
        // Fill the card's QR tile exactly (the drawing rounds down to whole
        // pixels per module, which left a gap on some sizes).
        cv.style.width = `${qrSize}px`; cv.style.height = `${qrSize}px`
        cv.getContext('2d')?.drawImage(off, 0, 0)
        setQrReady(true)
      })
      .catch(() => { if (id === drawSeq.current) setQrError(true) })
    // Redraw when My QR comes back into view (after Request payment) - the
    // canvas is a fresh, empty element then.
  }, [qrData, requesting, qrSize])

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
  // The QR card - on screen (QrCard) and as the image Download / Share save
  // (qrCardImage, its light version).
  const card = {
    title: shopQr ? (merchant.storeName || user.displayName || `${displayUsername}.arc`) : (user.displayName || (displayUsername ? `${displayUsername}.arc` : undefined)),
    subtitle: shopQr ? (store?.name ? `${store.name} · ${displayUsername}.arc` : `${displayUsername}.arc`)
      : `${business ? 'Personal · ' : ''}${displayUsername ? `${displayUsername}.arc` : shortenAddress(walletAddress ?? '')}`,
    tag: shopQr ? 'USDC · any network' : 'USDC · EURC · cirBTC',
    caption: shopQr ? 'Scan, type the amount and pay' : undefined,
  }
  const cardFile = (name: string) => qrCardFile({ data: qrData, ...card }, name)

  const handleDownloadQr = async () => {
    if (!qrData) return
    try {
      const link = document.createElement('a')
      link.download = `meshport-qr-${walletAddress?.slice(0, 8)}.png`
      const file = await cardFile(link.download)
      if (!file) throw new Error('no image')
      link.href = URL.createObjectURL(file)
      link.click()
      setTimeout(() => URL.revokeObjectURL(link.href), 1000)
    } catch {
      showToastMessage('Could not download QR', 'error')
    }
  }

  const handleShareQr = async () => {
    if (!qrData || !walletAddress) return
    try {
      const file = await cardFile('meshport-qr.png')
      if (!file) { showToastMessage('Could not share QR', 'error'); return }
      const shareText = shopQr ? `Pay ${shopName} on MeshPort - ${paymentLink}` : `Pay me on MeshPort - ${paymentLink}`
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'My QR', text: shareText })
      } else if (navigator.share) {
        await navigator.share({ title: 'My QR', text: shareText })
      } else {
        await navigator.clipboard.writeText(shareText)
        showToastMessage('Copied to clipboard', 'success')
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') showToastMessage('Could not share QR', 'error')
    }
  }

  // Held in variables so mobile (single stacked column, unchanged order/
  // output) and desktop (left column: QR, right column: username/address +
  // share) never duplicate this JSX.
  const qrCardSection = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, width: '100%', boxSizing: 'border-box' }}>

      {/* The app's one QR style (QrCard), holding this page's own canvas - the
          one Download / Share save. Captioned with whose QR it is. */}
      {!qrData ? (
        <p className="text-text-secondary text-xs text-center px-4">No wallet connected</p>
      ) : qrError ? (
        <div role="alert" className="flex flex-col items-center gap-2 py-6">
          <p className="text-danger text-xs text-center px-2">QR generation failed</p>
          <button onClick={() => { setQrError(false); setQrReady(false) }} className="text-brand text-xs underline">Retry</button>
        </div>
      ) : (
        <QrCard title={card.title} subtitle={card.subtitle} tag={card.tag} caption={card.caption} size={qrSize} compact={shortScreen}
          // Business: switch Personal / store right here (no extra row).
          extra={business && qrOptions.length > 1
            ? <StorePicker variant="chip" stores={qrOptions} value={qrPick} onChange={setQrPick} hint="Payments to this QR go to the store you pick" />
            : undefined}>
          <canvas ref={canvasRef} width={236} height={236} style={{ display: 'block', opacity: qrReady ? 1 : 0, transition: 'opacity 0.2s ease-out' }} />
        </QrCard>
      )}

      {/* Download · Share · Copy link - one row under the card (the old
          Share Payment Link button and the store's link box were the same
          link, and pushed the page below small screens). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', width: '100%', maxWidth: 340, gap: 8 }}>
        {([
          { label: 'Download', icon: <Download size={18} />, onClick: handleDownloadQr, off: !qrReady },
          { label: 'Share', icon: <Share2 size={18} />, onClick: handleShareQr, off: !qrReady },
          { label: copied === 'link' ? 'Copied' : 'Copy link', icon: copied === 'link' ? <CheckCircle size={18} /> : <Copy size={18} />, onClick: () => handleCopy(paymentLink, 'link'), off: false },
        ]).map(b => (
          <button key={b.label} onClick={b.onClick} disabled={b.off}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 56,
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '8px 4px',
              color: b.off ? 'var(--text-secondary)' : 'var(--text-primary)', fontSize: 12.5, fontWeight: 600, cursor: b.off ? 'default' : 'pointer' }}>
            {b.icon}{b.label}
          </button>
        ))}
      </div>

      {/* Personal: username and address to copy, in one small line. */}
      {!shopQr && !isDesktop && (displayUsername || walletAddress) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-secondary)' }}>
          {displayUsername && (
            <button onClick={() => handleCopy(displayUsername + '.arc', 'username')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: '4px 6px', color: 'inherit', cursor: 'pointer', fontFamily: 'ui-monospace, monospace' }}>
              {displayUsername}.arc {copied === 'username' ? <CheckCircle size={13} className="text-success" /> : <Copy size={13} />}
            </button>
          )}
          {walletAddress && (
            <button onClick={() => handleCopy(walletAddress, 'address')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: '4px 6px', color: 'inherit', cursor: 'pointer', fontFamily: 'ui-monospace, monospace' }}>
              {shortenAddress(walletAddress)} {copied === 'address' ? <CheckCircle size={13} className="text-success" /> : <Copy size={13} />}
            </button>
          )}
        </div>
      )}
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
    <div className={`flex flex-col h-full bg-bg overflow-hidden ${isDesktop ? '' : 'lg:max-w-[720px]'}`}>

      {/* Header */}
      <div className="header-row sticky top-0 z-20 backdrop-blur-md bg-bg/95 flex-shrink-0 gap-3 px-5 pt-header pb-header">
        {!isDesktop && (
          <button onClick={() => navigate('/')} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="text-xl font-bold text-text-primary">Receive</h1>
          {isDesktop && <p className="text-text-secondary text-xs mt-0.5">One QR for USDC, EURC and cirBTC</p>}
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
            {/* A business picks the store here too (the same pick as My QR's). */}
            <RequestQrPanel initialCustomer={params.get('customer') ?? undefined}
              stores={business ? stores : undefined} storeId={store?.id ?? null} onStore={setQrPick} />
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
        <div ref={fitRef} className="flex-1 overflow-y-auto">
          <div className="px-4 pb-6">
            {qrCardSection}
          </div>
        </div>
      )}
    </div>
  )
}
