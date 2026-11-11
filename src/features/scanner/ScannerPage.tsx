import { useState, useEffect, useRef, useCallback } from 'react'
import { getShopInfo } from '@/lib/shop'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {Zap, Camera, CheckCircle, AlertCircle, Loader2, Image as ImageIcon, Flashlight, X} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { Button } from '@/components/ui/Button'
import { Avatar } from '@/components/ui/Avatar'
import { UsernameDisplay } from '@/components/ui/UsernameDisplay'
import { useUIStore } from '@/store'
import { searchUsersDb, getUserByWalletAddress, type DbUser } from '@/lib/supabase'
import { isValidAddress } from '@/lib/arcService'
import { ARC } from '@/blockchain/chains'
import { isSolanaAddress } from '@/lib/solana'
import { parseEip681, classifyForeignQr, chainNameOf } from '@/lib/qrPayload'
import { nativeQrDetector, detectNative, decodeJsqr, centreSquare } from '@/lib/qrDecode'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { takePrewarmedCamera, openCameraStream } from '@/lib/scannerPrewarm'

/** Opened inside a panel (Pay / Transfer on desktop) instead of as its own
 *  page: the result goes back through these callbacks, no navigation. */
export interface EmbeddedScan {
  wallet: boolean
  onClose: () => void
  onWallet?: (address: string) => void
  onPay?: (compound: string, amount: string | null, token: string | null) => void
}

export function ScannerPage({ embedded }: { embedded?: EmbeddedScan } = {}) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { setSendRecipient } = useUIStore()
  // mode=wallet → only accept EVM addresses, return to returnTo path
  const walletMode = embedded ? embedded.wallet : searchParams.get('mode') === 'wallet'
  // Only our own in-app pages - never a value that could leave the app
  // (e.g. "/\\evil.com" resolves to another site).
  const returnTo   = ['/pay', '/multichain'].includes(searchParams.get('returnTo') || '') ? searchParams.get('returnTo')! : '/pay'
  // align=left → opened from a page with its own desktop 2-column layout
  // (e.g. Pay's search screen) where "column 1" sits at the left, not
  // centered across the full content width - pin the scanner to that same
  // left edge (24px, matching those pages' own column padding) instead of
  // centering it, so it visually stays "in column 1" rather than drifting
  // toward where column 2 (history panel) used to be.
  const alignLeft  = searchParams.get('align') === 'left'
  const [resolvedUser, setResolvedUser] = useState<DbUser | null>(null)
  // The requested amount, if the scanned QR encoded one - see MyQrCard's
  // "Collect USDC" flow in HomePage.tsx, which generates
  // `${APP_URL}/paylink/<username>?amount=<amount>`. Previously this scanner
  // extracted only the recipient from that URL and silently dropped
  // `?amount=`, which is exactly why a "Collect USDC" QR scanned from
  // another phone landed on a normal, blank-amount Send screen instead of
  // one pre-filled with the requested amount.
  const [scannedAmount, setScannedAmount] = useState<string | null>(null)
  // The token a Receive QR asks for (?token=EURC|cirBTC), carried into Pay.
  const [scannedToken, setScannedToken] = useState<string | null>(null)
  // The network a wallet QR names, when it isn't Arc ("Base", "Solana").
  const [scannedChain, setScannedChain] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [torchSupported, setTorchSupported] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [cameraError, setCameraError] = useState(false)
  const [scanning, setScanning] = useState(true) // actively scanning frames
  const [cameraReady, setCameraReady] = useState(false) // first live frame is showing

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const hasScannedRef = useRef(false) // prevent scanning after first decode
  // The scanner was closed: a read still in flight (the native reader
  // answers asynchronously) must not act on it.
  const closedRef = useRef(false)

  // ── Start camera ──
  // `cancelled` guards against React 18 StrictMode's dev-only double-invoke
  // (mount → cleanup → mount again) racing the async getUserMedia/play()
  // calls below - without it, the first mount's camera stream could attach
  // to the video element AFTER the second mount already started its own,
  // producing a visible black-frame/attach flicker on every open. Checked
  // after each await so a stream started before cleanup never gets wired
  // up post-unmount.
  useEffect(() => {
    let cancelled = false
    closedRef.current = false
    startCamera(() => cancelled)
    return () => {
      cancelled = true
      closedRef.current = true
      stopCamera()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately re-runs only on the listed values
  }, [])

  const startCamera = async (isCancelled: () => boolean = () => false) => {
    // Timeout so device never hangs indefinitely
    const timeoutId = setTimeout(() => { if (!isCancelled()) setCameraError(true) }, 8000)

    // Use the camera already started by the tap that opened this page, if
    // any (see scannerPrewarm.ts); otherwise open it now. Rear camera first,
    // any camera as a fallback (common on laptops / some Androids).
    const prewarmed = takePrewarmedCamera()
    let stream: MediaStream | null = prewarmed ? await prewarmed : null
    let lastErr: unknown = null
    if (!stream) ({ stream, error: lastErr } = await openCameraStream())

    if (isCancelled()) {
      // This mount was already cleaned up (StrictMode's double-invoke, or a
      // fast unmount) while getUserMedia was pending - stop whatever we
      // just got instead of wiring it up to a video element that a second,
      // newer effect run may already be using.
      stream?.getTracks().forEach(t => t.stop())
      clearTimeout(timeoutId)
      return
    }

    if (!stream) {
      clearTimeout(timeoutId)
      console.error('Camera permission/getUserMedia error:', lastErr)
      setCameraError(true)
      return
    }

    clearTimeout(timeoutId)
    streamRef.current = stream
    // Torch (flashlight) - Android Chrome exposes it on the camera track;
    // iOS Safari doesn't, so the button is shown dimmed there.
    try {
      const caps = (stream.getVideoTracks()[0]?.getCapabilities?.() ?? {}) as { torch?: boolean }
      setTorchSupported(!!caps.torch)
    } catch { /* no capabilities API */ }
    const video = videoRef.current
    if (!video) return

    video.srcObject = stream

    // Attach listeners BEFORE calling play() so we never miss the event,
    // and guard against starting the decode loop twice.
    let started = false
    const beginDecodingOnce = () => {
      if (started) return
      started = true
      startDecoding()
    }

    // onloadedmetadata gives us videoWidth/videoHeight, but on some mobile
    // browsers readyState hasn't reached HAVE_CURRENT_DATA yet at that point.
    // onloadeddata (readyState >= HAVE_CURRENT_DATA) is a more reliable signal
    // that frames are actually available to draw, so listen for both and
    // start on whichever fires first.
    video.onloadedmetadata = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) beginDecodingOnce()
    }
    video.onloadeddata = () => {
      beginDecodingOnce()
    }

    try {
      await video.play()
    } catch (err) {
      // Autoplay/play() can reject (e.g. user gesture policies); the
      // loadedmetadata/loadeddata listeners above will still fire once the
      // stream is attached, so we only surface an error if nothing loads.
      console.error('video.play() error:', err)
    }
  }

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }

  // ── Decode loop ──
  // The browser's own QR reader where there is one (Android: Google Play
  // services' barcode scanner - reads small, far, tilted and blurry codes
  // from the full camera frame, off the main thread); one read at a time,
  // as fast as it answers. Elsewhere (iPhone) jsQR, alternating between the
  // whole frame shrunk to DECODE_MAX_DIM and the square under the viewfinder
  // at full detail - a small or far QR has too few pixels left once the
  // whole frame is shrunk.
  const DECODE_MAX_DIM = 640      // long edge of the canvas jsQR actually scans

  const startDecoding = useCallback(() => {
    let frame = 0
    let busy = false
    // undefined: still asking whether the browser has a reader (jsQR meanwhile).
    let detector: Awaited<ReturnType<typeof nativeQrDetector>> | undefined
    nativeQrDetector().then(d => { detector = d })
    const found = (data: string) => {
      if (hasScannedRef.current || closedRef.current) return
      hasScannedRef.current = true
      handleScan(data)
    }
    const tick = () => {
      if (hasScannedRef.current || closedRef.current) return
      rafRef.current = requestAnimationFrame(tick)

      const video = videoRef.current
      const canvas = canvasRef.current
      // Require at least HAVE_CURRENT_DATA (readyState >= 2) AND real
      // dimensions - readyState alone can be HAVE_ENOUGH_DATA while
      // videoWidth/videoHeight are still 0 on some browsers right after
      // the stream attaches, which produces a 0x0 canvas and silently
      // fails every decode.
      if (!video || !canvas || video.readyState < video.HAVE_CURRENT_DATA || video.videoWidth === 0 || video.videoHeight === 0) return

      if (detector) {
        if (busy) return
        busy = true
        detectNative(detector, video)
          .then(v => { if (v) found(v) })
          .catch(() => { detector = null }) // reader broke: jsQR from now on
          .finally(() => { busy = false })
        return
      }

      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      frame++
      try {
        const srcW = video.videoWidth, srcH = video.videoHeight
        const v = decodeJsqr(ctx, video, srcW, srcH, DECODE_MAX_DIM, frame % 2 === 0 ? centreSquare(srcW, srcH) : undefined)
        if (v) found(v)
      } catch { /* a bad frame - try the next one */ }
    }
    rafRef.current = requestAnimationFrame(tick)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately re-runs only on the listed values
  }, [])

  // ── Resolve scanned value → user profile ──
  const resolveScannedValue = async (raw: string) => {
    setResolving(true)
    setError(null)
    setResolvedUser(null)
    setScannedAmount(null)
    setScannedToken(null)
    setScannedChain(null)

    try {
      let value = raw.trim()

      // MeshPort payment request / order QR (…/paylink/r/<code>?order=ORD-…, or older …/pay/r/…):
      // open the order - amount and order number are fixed for the payer.
      if (!walletMode) {
        // Also inside a wallet QR (ethereum:…&link=<encoded pay link>).
        let decoded = value
        try { decoded = decodeURIComponent(value) } catch { /* keep raw */ }
        const orderCode = /\/pay(?:link)?\/r\/([a-z0-9]{6,32})/i.exec(decoded)?.[1]
        if (orderCode) { setResolving(false); navigate(`/paylink/r/${orderCode.toLowerCase()}`); return }
      }

      // EIP-681 payment URI (or a MetaMask send link) - the cross-wallet
      // standard MyQrCard, merchant QRs, MetaMask, OKX, Trust, Coinbase
      // Wallet… generate: recipient, network and amount (see qrPayload).
      // Read BEFORE the generic prefix-stripping below, which only keeps the
      // address and would drop the amount.
      const eip = parseEip681(value)
      if (eip) {
        // A token transfer naming no recipient: the address in it is the
        // token contract - paying that loses the money.
        if (!eip.to) { setError('This payment QR doesn\'t say who to pay.'); setResolving(false); return }
        if (eip.amount) setScannedAmount(eip.amount)
        if (eip.chainId !== null && eip.chainId !== ARC.chainId) setScannedChain(chainNameOf(eip.chainId) ?? `network ${eip.chainId}`)
        value = eip.to
        // A MeshPort request QR is just address + amount + network: open the
        // matching open order (amount and order fixed), like a pay link.
        if (!walletMode && eip.amount) {
          const { findOpenOrder } = await import('@/lib/merchantPay')
          const hit = await findOpenOrder(value, Number(eip.amount))
          if (hit?.code) { setResolving(false); navigate(`/paylink/r/${hit.code}`); return }
        }
      } else {
        // Not EVM: a Solana wallet (Phantom, Solflare… - sent to with
        // Transfer), or a code MeshPort can't pay (Bitcoin, Tron, UPI,
        // WalletConnect, a web link) - said plainly instead of being looked
        // up as a username.
        const foreign = classifyForeignQr(value)
        if (foreign?.kind === 'unsupported') { setError(foreign.message); setResolving(false); return }
        if (foreign?.kind === 'solana') {
          setScannedChain('Solana')
          setResolvedUser({
            id: foreign.address, username: '', display_name: 'Solana Wallet',
            wallet_address: foreign.address, email: '', avatar_url: null, created_at: '',
          })
          setResolving(false)
          return
        }
      }

      // Strip known URI prefixes
      const prefixes = ['ethereum:', 'meshport:', 'wallet:', 'metamask:', 'trust:', 'wc:']
      for (const prefix of prefixes) {
        if (value.toLowerCase().startsWith(prefix)) {
          value = value.slice(prefix.length).split('?')[0].split('@')[0].split('/')[0]
          break
        }
      }
      if (value.includes('@2?')) value = value.split('@2?')[0]
      const addrMatch = value.match(/(0x[0-9a-fA-F]{40})/)
      if (addrMatch) value = addrMatch[1]
      value = value.trim()

      // Try to extract wallet address from MeshPort QR URL format
      // e.g. meshport.xyz/paylink/sunil (older: /pay/sunil) OR /pay?to=username OR /pay?to=0x...
      let shopLink: { username: string; store: string | null; amount: string | null } | null = null
      if (value.includes('meshportweb') || value.includes('meshport') || value.includes('?to=')) {
        try {
          const urlObj = new URL(value.startsWith('http') ? value : 'https://' + value)
          // A business's Shop QR (/paylink/<username>[?store=]) - checked below.
          const seg = urlObj.pathname.split('/').filter(Boolean)
          // A business's Personal QR (?personal=1) is a normal payment, not the shop.
          if (seg.length === 2 && (seg[0] === 'paylink' || seg[0] === 'pay') && !isValidAddress(seg[1]) && !urlObj.searchParams.get('token') && urlObj.searchParams.get('personal') !== '1') {
            shopLink = { username: seg[1], store: urlObj.searchParams.get('store'), amount: urlObj.searchParams.get('amount') }
          }
          const toParam = urlObj.searchParams.get('to')
          const addrParam = urlObj.searchParams.get('address') || urlObj.searchParams.get('wallet')
          const pathParts = urlObj.pathname.split('/').filter(Boolean)
          const pathUser = pathParts[pathParts.length - 1]
          // "Collect USDC" QR (MyQrCard) - /paylink/<username>?amount=<amount>.
          // Read alongside the recipient below, not instead of it, so a
          // scan still resolves the recipient normally either way.
          const amountParam = urlObj.searchParams.get('amount')
          if (amountParam && Number(amountParam) > 0) setScannedAmount(amountParam)
          const tokenParam = urlObj.searchParams.get('token')
          if (tokenParam === 'EURC' || tokenParam === 'cirBTC') setScannedToken(tokenParam)
          if (addrParam && isValidAddress(addrParam)) value = addrParam
          else if (toParam && isValidAddress(toParam)) value = toParam
          else if (pathUser && isValidAddress(pathUser)) value = pathUser
          else if (toParam) value = toParam
          else if (pathUser && pathUser !== 'pay' && pathUser !== 'paylink' && pathUser !== 'send') value = pathUser
        } catch {}
      }

      // Business Shop QR → the shop's amount page, so the payment is
      // recorded as an order for that store (see ShopPayPage).
      if (shopLink && !walletMode) {
        const shop = await getShopInfo(shopLink.username, shopLink.store).catch(() => null)
        if (shop) {
          const q = new URLSearchParams()
          if (shopLink.store) q.set('store', shopLink.store)
          if (shopLink.amount && Number(shopLink.amount) > 0) q.set('amount', shopLink.amount)
          setResolving(false)
          navigate(`/paylink/${shop.username}${q.toString() ? `?${q}` : ''}`)
          return
        }
      }

      // Re-extract address if embedded in value
      const addrMatch2 = value.match(/(0x[0-9a-fA-F]{40})/)
      if (addrMatch2) value = addrMatch2[1]
      value = value.trim()

      // Wallet-only mode (multichain send) - accept EVM addresses
      if (walletMode) {
        if (isValidAddress(value)) {
          setResolvedUser({
            id: value, username: '', display_name: value,
            wallet_address: value, email: '', avatar_url: null, created_at: '',
          })
        } else if (value) {
          // Try username lookup to get wallet address
          const normalized = value.toLowerCase().replace(/^@/, '').replace(/\.arc$/, '') + '.arc'
          const results = await searchUsersDb(normalized)
          const found = results[0]
          if (found?.wallet_address) {
            setResolvedUser(found)
          } else {
            setError('No valid wallet address found in QR code')
          }
        } else {
          setError('No valid wallet address found in QR code')
        }
        setResolving(false)
        return
      }

      // Also try to extract ?username= from original raw
      let hintUsername: string | null = null
      const usernameMatch = raw.match(/[?&]username=([^&]+)/)
      if (usernameMatch) hintUsername = usernameMatch[1].endsWith('.arc') ? usernameMatch[1] : usernameMatch[1] + '.arc'

      let user: DbUser | null = null

      if (isValidAddress(value)) {
        // Parallel: lookup by wallet address + hint username at same time
        const [walletUser, hintUser] = await Promise.all([
          getUserByWalletAddress(value).catch(() => null),
          hintUsername ? searchUsersDb(hintUsername).then(r => r[0] || null).catch(() => null) : Promise.resolve(null),
        ])
        user = walletUser || hintUser
        if (!user) {
          // External wallet - allow payment without profile
          setResolvedUser({
            id: value, username: '', display_name: 'External Wallet',
            wallet_address: value, email: '', avatar_url: null, created_at: '',
          })
          setResolving(false)
          return
        }
      } else {
        // Username lookup
        const normalized = value.trim().toLowerCase().replace(/^@/, '')
        const withArc = normalized.endsWith('.arc') ? normalized : normalized + '.arc'
        const results = await searchUsersDb(withArc)
        user = results[0] || null
      }

      if (user) setResolvedUser(user)
      else setError(`No MeshPort user found for "${value}"`)
    } catch {
      setError('Could not resolve user. Try again.')
    }
    setResolving(false)
  }

  const handleScan = (value: string) => {
    setScanning(false)
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    resolveScannedValue(value)
  }

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track || !torchSupported) return
    const next = !torchOn
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      setTorchOn(next)
    } catch { setTorchSupported(false) }
  }

  // Upload QR - decode a QR from a picked image (several sizes, then a 4×4
  // grid of regions for a small QR inside a big photo).
  const handleUploadFile = (file: File) => {
    setUploadError(null)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string
      if (!dataUrl) return
      const img = new Image()
      img.onload = async () => {
        const W = img.naturalWidth || img.width
        const H = img.naturalHeight || img.height
        const done = (v: string) => { hasScannedRef.current = true; handleScan(v) }
        // The browser's own reader on the whole picture first (it finds a
        // small QR anywhere in a photo by itself).
        const detector = await nativeQrDetector()
        if (detector) {
          try { const v = await detectNative(detector, img); if (v) { done(v); return } } catch { /* jsQR below */ }
        }
        const c = document.createElement('canvas')
        const cx = c.getContext('2d', { willReadFrequently: true })
        if (!cx) { setUploadError('No QR code found in that image.'); return }
        const decode = (size: number, region?: { x: number; y: number; w: number; h: number }) => {
          try { return decodeJsqr(cx, img, W, H, size, region) } catch { return null }
        }
        for (const size of [512, 1024, 768, 256]) {
          const v = decode(size)
          if (v) { done(v); return }
        }
        for (let row = 0; row < 4; row++) {
          for (let col = 0; col < 4; col++) {
            const sw2 = Math.floor(W / 4), sh2 = Math.floor(H / 4)
            const v = decode(512, { x: col * sw2, y: row * sh2, w: sw2, h: sh2 })
            if (v) { done(v); return }
          }
        }
        setUploadError('No QR code found in that image.')
      }
      img.onerror = () => setUploadError('Could not load image.')
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }

  const handlePay = () => {
    if (!resolvedUser) return
    stopCamera()

    // A Solana wallet is paid with Transfer (USDC to Solana over CCTP) - Pay
    // only sends on Arc. Transfer reads the address and switches to Solana.
    if (!walletMode && isSolanaAddress(resolvedUser.wallet_address)) {
      embedded?.onClose()
      navigate(`/multichain?scannedAddress=${encodeURIComponent(resolvedUser.wallet_address)}`)
      return
    }

    if (embedded) {
      if (walletMode) embedded.onWallet?.(resolvedUser.wallet_address)
      else embedded.onPay?.(resolvedUser.username
        ? `${resolvedUser.username}|${resolvedUser.wallet_address}|${resolvedUser.display_name}|${resolvedUser.avatar_url || ''}`
        : resolvedUser.wallet_address, scannedAmount, scannedToken)
      return
    }

    if (walletMode) {
      // Wallet-only mode - navigate back to multichain send with address pre-filled
      navigate(`${returnTo}?scannedAddress=${encodeURIComponent(resolvedUser.wallet_address)}`)
      return
    }

    const compound = resolvedUser.username
      ? `${resolvedUser.username}|${resolvedUser.wallet_address}|${resolvedUser.display_name}|${resolvedUser.avatar_url || ''}`
      : resolvedUser.wallet_address

    if (scannedAmount || scannedToken) {
      // Route through the SAME `?to=&amount=` URL param path PayPage.tsx's
      // "Pay on Arc" links already use - PaySendPage already fully supports
      // it (parses `to` with the identical compound format, then applies
      // `amount` once the recipient resolves). The `sendRecipient` store
      // path below carries no amount slot at all, which is exactly why
      // this was previously lost.
      navigate(`/pay?to=${encodeURIComponent(compound)}${scannedAmount ? `&amount=${encodeURIComponent(scannedAmount)}` : ''}${scannedToken ? `&token=${scannedToken}` : ''}`, { state: { returnTo: '/' } })
      return
    }

    setSendRecipient(compound)
    navigate('/pay', { state: { returnTo: '/' } })
  }

  const reset = () => {
    setResolvedUser(null)
    setScannedAmount(null)
    setScannedToken(null)
    setScannedChain(null)
    setError(null)
    setUploadError(null)
    setScanning(true)
    hasScannedRef.current = false
    startDecoding()
  }

  const card = (
    <div className={`flex flex-col bg-black relative overflow-hidden ${isDesktop || embedded ? 'rounded-3xl' : 'h-dvh'}`}
      style={embedded ? { height: '100%', width: '100%' } : isDesktop ? { height: '100%', width: alignLeft ? 640 : '100%', maxWidth: alignLeft ? 640 : undefined } : undefined}>
      {/* Camera viewfinder */}
      <div className="flex-1 relative flex items-center justify-center bg-black">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          style={{ opacity: cameraReady ? 1 : 0, transition: 'opacity 160ms ease-out' }}
          onPlaying={() => setCameraReady(true)}
          autoPlay playsInline muted
        />
        {/* Hidden canvas used for frame capture - not visible */}
        <canvas ref={canvasRef} className="hidden" />

        <div className="absolute inset-0 bg-black/30" />

        {/* Header */}
        <div className="header-row absolute top-0 left-0 right-0 justify-between px-5 pt-header pb-header bg-gradient-to-b from-black/60 to-transparent z-10">
          <span className="text-white font-semibold">Scan QR Code</span>
          {embedded && (
            <button onClick={() => { stopCamera(); embedded.onClose() }} aria-label="Close scanner"
              className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.14)' }}>
              <X className="w-5 h-5 text-white" />
            </button>
          )}
        </div>

        {/* Scanner frame + Upload QR / Torch - only when actively scanning */}
        {scanning && !resolvedUser && !resolving && !error && (
          <div className="relative z-10 flex flex-col items-center">
            <div className="w-64 h-64 relative rounded-[28px]"
              style={{ border: '1px solid rgba(255,255,255,0.14)', background: cameraReady ? 'transparent' : 'rgba(255,255,255,0.06)' }}>
              {/* Corner brackets */}
              {(['tl','tr','bl','br'] as const).map(corner => (
                <div key={corner} className={`absolute w-10 h-10 border-brand border-[3px]
                  ${corner === 'tl' ? 'top-4 left-4 border-r-0 border-b-0 rounded-tl-2xl' : ''}
                  ${corner === 'tr' ? 'top-4 right-4 border-l-0 border-b-0 rounded-tr-2xl' : ''}
                  ${corner === 'bl' ? 'bottom-4 left-4 border-r-0 border-t-0 rounded-bl-2xl' : ''}
                  ${corner === 'br' ? 'bottom-4 right-4 border-l-0 border-t-0 rounded-br-2xl' : ''}
                `} />
              ))}
              {cameraError ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8">
                  <Camera className="w-10 h-10 text-white/40 mb-2" />
                  <p className="text-white/70 text-sm">Camera not available.<br />Upload a QR instead.</p>
                </div>
              ) : (
                /* Scan line animation */
                <motion.div
                  animate={{ y: [24, 230, 24] }}
                  transition={{ duration: 2.5, repeat: Infinity, ease: 'linear' }}
                  className="absolute left-6 right-6 h-0.5 bg-brand"
                />
              )}
            </div>
            <p className="text-white/70 text-sm text-center mt-5">
              {cameraError ? '\u00a0' : cameraReady ? 'Point at a MeshPort or wallet QR code' : 'Starting camera…'}
            </p>

            <div className="flex items-start justify-center gap-14 mt-6">
              <button onClick={() => fileInputRef.current?.click()} aria-label="Upload QR"
                className="flex flex-col items-center gap-2 text-white active:scale-95 transition-transform">
                <span className="w-14 h-14 rounded-full flex items-center justify-center"
                  style={{ background: 'rgba(255,255,255,0.16)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
                  <ImageIcon className="w-6 h-6" />
                </span>
                <span className="text-sm font-medium">Upload QR</span>
              </button>
              <button onClick={toggleTorch} aria-label="Torch" aria-pressed={torchOn} disabled={!torchSupported}
                className="flex flex-col items-center gap-2 text-white active:scale-95 transition-transform disabled:opacity-40">
                <span className="w-14 h-14 rounded-full flex items-center justify-center"
                  style={{ background: torchOn ? 'var(--brand)' : 'rgba(255,255,255,0.16)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
                  <Flashlight className="w-6 h-6" />
                </span>
                <span className="text-sm font-medium">Torch</span>
              </button>
            </div>
            {uploadError && (
              <p role="alert" className="text-white text-sm text-center mt-4 px-4 py-2 rounded-xl" style={{ background: 'rgba(220,38,38,0.85)' }}>{uploadError}</p>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleUploadFile(f) }} />
          </div>
        )}

        {/* Resolving */}
        {resolving && (
          <div className="absolute inset-0 flex items-center justify-center z-20 bg-black/60">
            <div className="bg-surface rounded-3xl p-6 flex flex-col items-center gap-3 mx-8 shadow-elevation-3">
              <Loader2 className="w-10 h-10 text-brand-text animate-spin" />
              <p className="text-text-primary font-medium">Looking up user...</p>
            </div>
          </div>
        )}

        {/* Error */}
        {error && !resolvedUser && (
          <div className="absolute inset-0 flex items-center justify-center z-20 bg-black/60">
            <div className="bg-surface rounded-3xl p-6 mx-8 space-y-4 text-center shadow-elevation-3">
              <AlertCircle className="w-10 h-10 text-danger mx-auto" />
              <p role="alert" className="text-text-primary font-medium">{error}</p>
              <Button onClick={reset} fullWidth>Try Again</Button>
            </div>
          </div>
        )}
      </div>

      {/* Resolved user - the app's centred popup. Tap outside, Esc or Back
          does what Scan Again does. */}
      <AnimatePresence>
        {resolvedUser && (
          <DesktopDialogFrame key="resolved" onClose={reset} maxWidth={420}>
          <div className="p-6 space-y-5">
            <div className="flex items-center gap-4">
              <Avatar name={resolvedUser.display_name} src={resolvedUser.avatar_url} size="xl" />
              <div className="flex-1 min-w-0">
                <p className="text-text-primary font-bold text-lg truncate">{resolvedUser.display_name}</p>
                {resolvedUser.username ? (
                  <UsernameDisplay username={resolvedUser.username} size="md" />
                ) : (
                  <p className="text-xs font-mono text-text-secondary">{resolvedUser.wallet_address.slice(0,14)}...</p>
                )}
                {resolvedUser.username && (
                  <div className="flex items-center gap-1 mt-1">
                    <CheckCircle className="w-3.5 h-3.5 text-success" />
                    <p className="text-xs text-success">Verified MeshPort User</p>
                  </div>
                )}
                {!resolvedUser.username && scannedChain !== 'Solana' && (
                  <div className="flex items-center gap-1 mt-1">
                    <AlertCircle className="w-3.5 h-3.5 text-warning" />
                    <p className="text-xs text-warning">External wallet - payment still works</p>
                  </div>
                )}
                {/* The network the QR names when it isn't Arc: Pay sends on
                    Arc, Transfer lets them pick that network. */}
                {scannedChain && (
                  <div className="flex items-start gap-1 mt-1">
                    <AlertCircle className="w-3.5 h-3.5 text-warning flex-shrink-0 mt-px" />
                    <p className="text-xs text-warning">
                      {scannedChain === 'Solana'
                        ? (walletMode ? 'Solana wallet - receives on Solana' : 'Solana wallet - sent with Transfer')
                        : walletMode ? `QR is for ${scannedChain} - pick it as the network` : `QR is for ${scannedChain} - MeshPort pays on Arc`}
                    </p>
                  </div>
                )}
                {scannedAmount && (
                  <div className="flex items-center gap-1 mt-1.5">
                    <CheckCircle className="w-3.5 h-3.5 text-success" />
                    <p className="text-xs text-success font-medium">Requesting ${scannedAmount}</p>
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-3">
              <Button variant="secondary" fullWidth onClick={reset}>Scan Again</Button>
              <Button fullWidth onClick={handlePay}>
                <Zap className="w-4 h-4 mr-1.5" />
                {walletMode ? 'Use this address' : scannedChain === 'Solana' ? 'Send on Solana' : scannedAmount ? `Pay $${scannedAmount}` : 'Pay'}
              </Button>
            </div>
          </div>
          </DesktopDialogFrame>
        )}
      </AnimatePresence>

    </div>
  )

  // Desktop: the card is inset within the same padded content area every
  // other desktop page uses (20/24/14px), bounded to that area's actual
  // height instead of stretching h-full past the viewport - that mismatch
  // was why the black viewfinder previously overflowed above the header
  // and below the fold. alignLeft (opened from a page with its own 2-column
  // layout, e.g. Pay's search screen) keeps the card pinned to the left
  // edge at a fixed width instead of stretching full-bleed.
  if (embedded) return card
  if (isDesktop) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '20px 24px 14px', alignItems: alignLeft ? 'flex-start' : 'stretch', minHeight: 0 }}>
        {card}
      </div>
    )
  }
  return card
}
