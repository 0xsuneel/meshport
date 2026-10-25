import { useState, useEffect, useRef } from 'react'
import { Share2, ArrowLeft, Download, ListChecks } from 'lucide-react'
import { StorePicker, type PickerStore } from '@/features/merchant/StorePicker'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMerchant, useBusinessTab } from '@/lib/merchant'
import { listStores, type Store } from '@/lib/businessTeam'
import { arcAddressUri } from '@/lib/merchantQr'
import { personalPayLink, shopPayLink } from '@/lib/payLinks'
import { shopFrom } from '@/lib/orderLabels'
import { RequestQrPanel } from './RequestQrPanel'
import { useAuthStore, useUIStore } from '@/store'
import { shortenAddress, copyToClipboard, formatAmount } from '@/lib/utils'
import { SolanaReceiveCard } from './SolanaReceiveCard'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { drawMeshportQr } from '@/lib/qrLogo'
import { QrCard, QrInfoBox } from '@/features/business/ui/QrCard'
import { qrCardFile } from '@/lib/qrCardImage'
import { DesktopTwoColumn } from '@/components/layout/DesktopTwoColumn'
import { DesktopHistoryPanel, DesktopHistoryEmpty, DesktopHistorySkeleton } from '@/components/ui/DesktopHistoryPanel'
import { HistoryRow, HistoryIcon } from '@/components/ui/HistoryRow'
import { listMyIntents, isAskedOrder, subscribeMerchantPayments, orderLabel, orderKindOf, orderTitle, type MerchantIntent } from '@/lib/merchantPay'
import { requestBucket, requestStatus, statusLine } from './MyRequestsPage'

const APP_URL = 'https://meshport.xyz'

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
  // Desktop: My requests in the right-hand panel (like Pay / Swap's history),
  // live on payments to them, and refreshed when a new one is made.
  const [requests, setRequests] = useState<MerchantIntent[] | null>(null)
  useEffect(() => {
    if (!isDesktop) return
    const load = () => { listMyIntents(30).then(l => setRequests(l.filter(isAskedOrder))).catch(() => setRequests(prev => prev ?? [])) }
    load()
    const unsub = walletAddress ? subscribeMerchantPayments(walletAddress, load) : () => {}
    const iv = setInterval(load, 30_000)
    return () => { unsub(); clearInterval(iv) }
  }, [isDesktop, walletAddress, tab])
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

    drawMeshportQr(canvasRef.current, qrData, 232)
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
  // The QR card - on screen (QrCard) and as the image Download / Share save
  // (qrCardImage, its light version).
  const card = {
    title: shopQr ? (merchant.storeName || user.displayName || `${displayUsername}.arc`) : (user.displayName || (displayUsername ? `${displayUsername}.arc` : undefined)),
    subtitle: shopQr ? (store?.name ? `${store.name} · ${displayUsername}.arc` : `${displayUsername}.arc`) : displayUsername ? `${displayUsername}.arc` : shortenAddress(walletAddress ?? ''),
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

  // Over the QR, side by side, in place of the name (and of the copy rows /
  // link box that sat under the page): a personal QR's username and address,
  // a store's QR the store and its pay link - tap to copy.
  const copyBox = (label: string, value: string, full: string, key: string) => (
    <QrInfoBox label={label} value={value} onCopy={() => handleCopy(full, key)} copied={copied === key} />
  )
  const cardTop = shopQr ? (
    <div className="w-full flex gap-2">
      <QrInfoBox label="Store" value={store?.name || merchant.storeName || 'Shop'} mono={false} />
      <QrInfoBox label="Pay link" value={copied === 'link' ? 'Copied' : 'Tap to copy'} mono={false}
        onCopy={() => handleCopy(paymentLink, 'link')} copied={copied === 'link'} />
    </div>
  ) : displayUsername || walletAddress ? (
    <div className="w-full flex gap-2">
      {displayUsername && copyBox('Username', `${displayUsername}.arc`, `${displayUsername}.arc`, 'username')}
      {walletAddress && copyBox('Address', `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`, walletAddress, 'address')}
    </div>
  ) : undefined

  // Held in variables so mobile (single stacked column, unchanged order/
  // output) and desktop (left column: QR, right column: username/address +
  // share) never duplicate this JSX.
  const qrCardSection = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, width: '100%', boxSizing: 'border-box' }}>
      {business && qrOptions.length > 1 && (
        <div style={{ width: '100%', maxWidth: 340 }}>
          <StorePicker stores={qrOptions} value={qrPick} onChange={setQrPick} label="Showing QR for store" hint="Payments to this QR go to the store you pick" />
        </div>
      )}

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
        <QrCard title={card.title} subtitle={card.subtitle} tag={card.tag} caption={card.caption} top={cardTop}>
          <canvas ref={canvasRef} width={236} height={236} style={{ display: 'block', opacity: qrReady ? 1 : 0, transition: 'opacity 0.2s ease-out' }} />
        </QrCard>
      )}

      {/* Download / Share - under the card, like the payment apps' */}
      <div style={{ display: 'flex', width: '100%', maxWidth: 340, gap: 10, alignItems: 'stretch' }}>
        <button
          onClick={handleDownloadQr}
          disabled={!qrReady}
          style={{
            flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'clamp(5px, 1.6vw, 8px)',
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '12px 6px', whiteSpace: 'nowrap',
            color: qrReady ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontSize: 'clamp(12.5px, 3.8vw, 14px)', fontWeight: 600, cursor: qrReady ? 'pointer' : 'default',
          }}>
          <Download size={17} />
          Download QR
        </button>
        <button
          onClick={handleShareQr}
          disabled={!qrReady}
          style={{
            flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'clamp(5px, 1.6vw, 8px)',
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '12px 6px', whiteSpace: 'nowrap',
            color: qrReady ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontSize: 'clamp(12.5px, 3.8vw, 14px)', fontWeight: 600, cursor: qrReady ? 'pointer' : 'default',
          }}>
          <Share2 size={17} />
          Share QR
        </button>
      </div>
    </div>
  )

  // Username / address (personal) and the store's pay link are on the QR
  // card itself (cardTop); Share QR sends the link.
  const copyFieldsSection = null

  const shareButtonSection = shopQr ? null : (
    <button onClick={handleShare}
      className="w-full flex items-center justify-center gap-2 py-4 bg-brand text-white font-semibold rounded-2xl shadow-elevation-2 active:scale-95 transition-transform"
      style={{ border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
      <Share2 className="w-5 h-5" /> Share Payment Link
    </button>
  )

  const flow = (
    <div className={`flex flex-col h-full bg-bg overflow-hidden ${isDesktop ? '' : 'lg:max-w-[720px]'}`}>

      {/* Header */}
      <div className={`header-row sticky top-0 z-20 bg-bg flex-shrink-0 gap-3 ${isDesktop ? 'px-4 pt-0 pb-3' : 'px-5 pt-header pb-header'}`}>
        {!isDesktop && (
          <button onClick={() => navigate('/')} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="text-xl font-bold text-text-primary">Receive</h1>
        </div>
        {/* Requests you made and whether they're paid (Receive → My requests).
            Desktop: the right-hand panel. */}
        {!isDesktop && <button onClick={() => navigate('/receive/requests')}
          style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 999, cursor: 'pointer',
            border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 700 }}>
          <ListChecks size={15} /> My requests
        </button>}
      </div>

      {/* My QR | Request - the same switch as Business → Collect payment. */}
      <div className="px-4 pb-3 flex-shrink-0" style={isDesktop ? { padding: '0 16px 4px' } : undefined}>
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
        <div className="flex-1 min-h-0 flex flex-col" style={isDesktop ? { padding: '16px 16px 4px', alignItems: 'center' } : undefined}>
          <div className="flex-1 min-h-0 flex flex-col w-full" style={isDesktop ? { maxWidth: 460, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 24, boxShadow: 'var(--shadow-1)', overflow: 'hidden' } : undefined}>
            {/* A business picks the store here too (the same pick as My QR's). */}
            <RequestQrPanel initialCustomer={params.get('customer') ?? undefined}
              stores={business ? stores : undefined} storeId={store?.id ?? null} onStore={setQrPick} />
          </div>
        </div>
      ) : isDesktop ? (
        // The QR card with Share Payment Link right under it, centred in
        // the flow column (it used to float alone in a second column).
        <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: '16px 16px 24px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            {qrCardSection}
            {shareButtonSection && <div style={{ width: '100%', maxWidth: 340 }}>{shareButtonSection}</div>}
            {!shopQr && <SolanaReceiveCard />}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 space-y-4 pb-8">
            {qrCardSection}
            {copyFieldsSection}
            {shareButtonSection}
            {!shopQr && <div className="flex justify-center"><SolanaReceiveCard /></div>}
          </div>
        </div>
      )}
    </div>
  )

  if (!isDesktop) return flow

  // ── Desktop: flow (left) + My requests (right) - the same 65/35 split as
  // Pay, Swap and P2P (DesktopTwoColumn).
  return (
    <div style={{ height: '100%', minHeight: 0, background: 'var(--bg)' }}>
    <DesktopTwoColumn
      main={flow}
      side={
        <DesktopHistoryPanel title="My requests" onViewAll={() => navigate('/receive/requests')}>
          {requests === null ? <DesktopHistorySkeleton />
            : requests.length === 0 ? <DesktopHistoryEmpty label="Payment requests you make show up here" />
            : requests.map(i => {
              const bucket = requestBucket(i)
              const st = requestStatus(i)
              const line = statusLine(i)
              return (
                <HistoryRow key={i.id} inPanel onClick={() => navigate(`/receive/requests?open=${i.id}`)}
                  icon={<HistoryIcon tone={bucket === 'paid' ? 'in' : bucket === 'closed' ? 'muted' : st === 'partially_paid' ? 'out' : 'pending'} icon="receive" />}
                  title={orderTitle(orderKindOf(i), orderLabel(i), { short: true })}
                  meta={<span style={{ color: line.color }}>{line.text}</span>}
                  right={<div style={{ fontSize: 14, fontWeight: 700, color: bucket === 'paid' ? 'var(--success)' : bucket === 'closed' ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
                    {bucket === 'paid' ? '+' : ''}${formatAmount(bucket === 'paid' ? (i.received || i.amount) : i.amount)}
                  </div>} />
              )
            })}
        </DesktopHistoryPanel>
      }
    />
    </div>
  )
}
