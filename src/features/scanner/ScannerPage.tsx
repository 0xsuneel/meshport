import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {Zap, Camera, CheckCircle, AlertCircle, Loader2, Upload} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/Button'
import { Avatar } from '@/components/ui/Avatar'
import { UsernameDisplay } from '@/components/ui/UsernameDisplay'
import { useUIStore } from '@/store'
import { searchUsersDb, getUserByWalletAddress, type DbUser } from '@/lib/supabase'
import { isValidAddress } from '@/lib/arcService'
import { formatUnits } from 'viem'
import jsQR from 'jsqr'
import { useMediaQuery } from '@/hooks/useMediaQuery'

export function ScannerPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { setSendRecipient } = useUIStore()
  // mode=wallet → only accept EVM addresses, return to returnTo path
  const walletMode = searchParams.get('mode') === 'wallet'
  const returnTo   = searchParams.get('returnTo') || '/pay-send'
  // align=left → opened from a page with its own desktop 2-column layout
  // (e.g. Pay's search screen) where "column 1" sits at the left, not
  // centered across the full content width — pin the scanner to that same
  // left edge (24px, matching those pages' own column padding) instead of
  // centering it, so it visually stays "in column 1" rather than drifting
  // toward where column 2 (history panel) used to be.
  const alignLeft  = searchParams.get('align') === 'left'
  const [resolvedUser, setResolvedUser] = useState<DbUser | null>(null)
  // The requested amount, if the scanned QR encoded one — see MyQrCard's
  // "Collect USDC" flow in HomePage.tsx, which generates
  // `${APP_URL}/pay/<username>?amount=<amount>`. Previously this scanner
  // extracted only the recipient from that URL and silently dropped
  // `?amount=`, which is exactly why a "Collect USDC" QR scanned from
  // another phone landed on a normal, blank-amount Send screen instead of
  // one pre-filled with the requested amount.
  const [scannedAmount, setScannedAmount] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [manualInput, setManualInput] = useState('')
  const [showManual, setShowManual] = useState(false)
  const [cameraError, setCameraError] = useState(false)
  const [scanning, setScanning] = useState(true) // actively scanning frames

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const hasScannedRef = useRef(false) // prevent scanning after first decode

  // ── Start camera ──
  // `cancelled` guards against React 18 StrictMode's dev-only double-invoke
  // (mount → cleanup → mount again) racing the async getUserMedia/play()
  // calls below — without it, the first mount's camera stream could attach
  // to the video element AFTER the second mount already started its own,
  // producing a visible black-frame/attach flicker on every open. Checked
  // after each await so a stream started before cleanup never gets wired
  // up post-unmount.
  useEffect(() => {
    let cancelled = false
    startCamera(() => cancelled)
    return () => {
      cancelled = true
      stopCamera()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  const startCamera = async (isCancelled: () => boolean = () => false) => {
    // Timeout so device never hangs indefinitely
    const timeoutId = setTimeout(() => { if (!isCancelled()) { setCameraError(true); setShowManual(true) } }, 8000)

    // Try the rear camera first, but fall back to any camera if that
    // exact constraint can't be satisfied (common on laptops / some Androids)
    const constraintAttempts: MediaStreamConstraints[] = [
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
      { video: true },
    ]

    let stream: MediaStream | null = null
    let lastErr: unknown = null
    for (const constraints of constraintAttempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints)
        break
      } catch (err) {
        lastErr = err
      }
    }

    if (isCancelled()) {
      // This mount was already cleaned up (StrictMode's double-invoke, or a
      // fast unmount) while getUserMedia was pending — stop whatever we
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
      setShowManual(true)
      return
    }

    clearTimeout(timeoutId)
    streamRef.current = stream
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

  // ── jsqr decode loop ──
  // Two levers control detection latency:
  //   1) how many pixels jsQR has to scan per attempt (bigger = slower)
  //   2) how many frames we skip between attempts (more skipped = slower)
  // The old version tried to control cost by skipping 3 of every 4 frames
  // while still decoding the full 1280x720 capture — the expensive part.
  // Downscaling the working canvas cuts jsQR's per-attempt cost by ~4-6x,
  // which lets us scan nearly every frame instead and detect much faster
  // in wall-clock time, without spiking CPU/battery.
  const DECODE_MAX_DIM = 640      // long edge of the canvas jsQR actually scans
  const FRAME_SKIP = 1            // 1 = scan every frame, 2 = every other frame, etc.

  const startDecoding = useCallback(() => {
    let frameCount = 0
    const tick = () => {
      if (hasScannedRef.current) return
      frameCount++
      if (frameCount % FRAME_SKIP !== 0) { rafRef.current = requestAnimationFrame(tick); return }

      const video = videoRef.current
      const canvas = canvasRef.current
      // Require at least HAVE_CURRENT_DATA (readyState >= 2) AND real
      // dimensions — readyState alone can be HAVE_ENOUGH_DATA while
      // videoWidth/videoHeight are still 0 on some browsers right after
      // the stream attaches, which produces a 0x0 canvas and silently
      // fails every decode.
      if (
        !video ||
        !canvas ||
        video.readyState < video.HAVE_CURRENT_DATA ||
        video.videoWidth === 0 ||
        video.videoHeight === 0
      ) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) { rafRef.current = requestAnimationFrame(tick); return }

      // Downscale to DECODE_MAX_DIM on the long edge. drawImage does the
      // scaling for us in one call — this is much cheaper than decoding
      // the full-resolution frame, and a QR code that's actually readable
      // on camera doesn't need 720p worth of pixels to decode correctly.
      const srcW = video.videoWidth
      const srcH = video.videoHeight
      const scale = Math.min(1, DECODE_MAX_DIM / Math.max(srcW, srcH))
      const w = Math.max(1, Math.round(srcW * scale))
      const h = Math.max(1, Math.round(srcH * scale))

      canvas.width = w
      canvas.height = h
      ctx.drawImage(video, 0, 0, w, h)

      try {
        const imageData = ctx.getImageData(0, 0, w, h)
        // Use the same decode strategy as the upload path. The camera loop
        // previously used 'dontInvert', which skips jsQR's inverted-color
        // pass and misses QR codes that render as light-on-dark (dark
        // backgrounds, inverted/dark-mode screens, some printed codes).
        // That mismatch was the root cause of camera scans failing on
        // images that the upload path decoded fine.
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'attemptBoth',
        })

        if (code?.data) {
          hasScannedRef.current = true
          handleScan(code.data)
          return
        }
      } catch {}

      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  // ── Resolve scanned value → user profile ──
  const resolveScannedValue = async (raw: string) => {
    setResolving(true)
    setError(null)
    setResolvedUser(null)
    setScannedAmount(null)

    try {
      let value = raw.trim()

      // EIP-681 payment URI — ethereum:<address>@<chainId>?value=<wei>.
      // This is the format MyQrCard now generates for an amount-QR (see its
      // own comment on why): the real cross-wallet standard, not a
      // MeshPort-only link, so MetaMask/Rabby/Coinbase Wallet/OKX/Binance
      // all understand "pay this address this amount" directly from it.
      // Parsed here, BEFORE the generic prefix-stripping below (which only
      // ever extracts the address) — otherwise `value=` gets silently
      // dropped the exact same way the old MeshPort-URL `?amount=` param
      // used to.
      if (value.toLowerCase().startsWith('ethereum:')) {
        const eip681Match = value.match(/^ethereum:(0x[0-9a-fA-F]{40})(?:@\d+)?\??(.*)$/i)
        if (eip681Match) {
          const [, addr, queryStr] = eip681Match
          try {
            const params = new URLSearchParams(queryStr)
            const wei = params.get('value')
            if (wei && /^\d+$/.test(wei) && BigInt(wei) > 0n) {
              const human = formatUnits(BigInt(wei), 18)
              // Trim trailing zeros for a clean display amount —
              // formatUnits returns e.g. "25.000000000000000000" for a
              // whole-number amount.
              const trimmed = human.includes('.')
                ? human.replace(/0+$/, '').replace(/\.$/, '')
                : human
              setScannedAmount(trimmed)
            }
          } catch {}
          value = addr
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
      // e.g. meshportweb.vercel.app/pay/sunil OR /pay?to=username OR /pay?to=0x...
      if (value.includes('meshportweb') || value.includes('meshport') || value.includes('?to=')) {
        try {
          const urlObj = new URL(value.startsWith('http') ? value : 'https://' + value)
          const toParam = urlObj.searchParams.get('to')
          const addrParam = urlObj.searchParams.get('address') || urlObj.searchParams.get('wallet')
          const pathParts = urlObj.pathname.split('/').filter(Boolean)
          const pathUser = pathParts[pathParts.length - 1]
          // "Collect USDC" QR (MyQrCard) — /pay/<username>?amount=<amount>.
          // Read alongside the recipient below, not instead of it, so a
          // scan still resolves the recipient normally either way.
          const amountParam = urlObj.searchParams.get('amount')
          if (amountParam && Number(amountParam) > 0) setScannedAmount(amountParam)
          if (addrParam && isValidAddress(addrParam)) value = addrParam
          else if (toParam && isValidAddress(toParam)) value = toParam
          else if (pathUser && isValidAddress(pathUser)) value = pathUser
          else if (toParam) value = toParam
          else if (pathUser && pathUser !== 'pay' && pathUser !== 'send') value = pathUser
        } catch {}
      }

      // Re-extract address if embedded in value
      const addrMatch2 = value.match(/(0x[0-9a-fA-F]{40})/)
      if (addrMatch2) value = addrMatch2[1]
      value = value.trim()

      // Wallet-only mode (multichain send) — accept EVM addresses
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
          // External wallet — allow payment without profile
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

  const handleManualSubmit = () => {
    if (!manualInput.trim()) return
    handleScan(manualInput.trim())
    setShowManual(false)
  }

  const handlePay = () => {
    if (!resolvedUser) return
    stopCamera()

    if (walletMode) {
      // Wallet-only mode — navigate back to multichain send with address pre-filled
      navigate(`${returnTo}?scannedAddress=${encodeURIComponent(resolvedUser.wallet_address)}`)
      return
    }

    const compound = resolvedUser.username
      ? `${resolvedUser.username}|${resolvedUser.wallet_address}|${resolvedUser.display_name}|${resolvedUser.avatar_url || ''}`
      : resolvedUser.wallet_address

    if (scannedAmount) {
      // Route through the SAME `?to=&amount=` URL param path PayPage.tsx's
      // "Pay on Arc" links already use — PaySendPage already fully supports
      // it (parses `to` with the identical compound format, then applies
      // `amount` once the recipient resolves). The `sendRecipient` store
      // path below carries no amount slot at all, which is exactly why
      // this was previously lost.
      navigate(`/pay-send?to=${encodeURIComponent(compound)}&amount=${encodeURIComponent(scannedAmount)}`, { state: { returnTo: '/' } })
      return
    }

    setSendRecipient(compound)
    navigate('/pay-send', { state: { returnTo: '/' } })
  }

  const reset = () => {
    setResolvedUser(null)
    setScannedAmount(null)
    setError(null)
    setManualInput('')
    setScanning(true)
    hasScannedRef.current = false
    startDecoding()
  }

  const card = (
    <div className={`flex flex-col bg-black relative overflow-hidden ${isDesktop ? 'rounded-3xl' : 'h-screen'}`}
      style={isDesktop ? { height: '100%', width: alignLeft ? 640 : '100%', maxWidth: alignLeft ? 640 : undefined } : undefined}>
      {/* Camera viewfinder */}
      <div className="flex-1 relative flex items-center justify-center bg-black">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          autoPlay playsInline muted
        />
        {/* Hidden canvas used for frame capture — not visible */}
        <canvas ref={canvasRef} className="hidden" />

        <div className="absolute inset-0 bg-black/30" />

        {/* Header */}
        <div className="header-row absolute top-0 left-0 right-0 justify-between px-5 pt-header pb-header bg-gradient-to-b from-black/60 to-transparent z-10">
          <span className="text-white font-semibold">Scan QR Code</span>
          <button onClick={() => setShowManual(true)}
            className="px-3 py-1.5 rounded-xl bg-black/40 backdrop-blur-sm text-white text-xs font-medium">
            Manual
          </button>
        </div>

        {/* Scanner frame — only when actively scanning */}
        {scanning && !resolvedUser && !resolving && !error && (
          <div className="relative z-10">
            <div className="w-64 h-64 relative">
              {/* Corner brackets */}
              {(['tl','tr','bl','br'] as const).map(corner => (
                <div key={corner} className={`absolute w-8 h-8 border-white border-4
                  ${corner === 'tl' ? 'top-0 left-0 border-r-0 border-b-0 rounded-tl-lg' : ''}
                  ${corner === 'tr' ? 'top-0 right-0 border-l-0 border-b-0 rounded-tr-lg' : ''}
                  ${corner === 'bl' ? 'bottom-0 left-0 border-r-0 border-t-0 rounded-bl-lg' : ''}
                  ${corner === 'br' ? 'bottom-0 right-0 border-l-0 border-t-0 rounded-br-lg' : ''}
                `} />
              ))}
              {/* Scan line animation */}
              <motion.div
                animate={{ y: [0, 240, 0] }}
                transition={{ duration: 2.5, repeat: Infinity, ease: 'linear' }}
                className="absolute left-2 right-2 h-0.5 bg-brand"
              />
            </div>
            <p className="text-white/70 text-sm text-center mt-6">Point at an MeshPort QR code</p>
          </div>
        )}

        {/* Camera unavailable */}
        {cameraError && !showManual && !resolvedUser && (
          <div className="relative z-10 text-center px-8">
            <Camera className="w-12 h-12 text-white/40 mx-auto mb-3" />
            <p className="text-white/70 text-sm">Camera not available</p>
            <button onClick={() => setShowManual(true)}
              className="mt-3 px-4 py-2 bg-brand text-white rounded-xl text-sm font-medium">
              Enter Manually
            </button>
          </div>
        )}

        {/* Resolving */}
        {resolving && (
          <div className="absolute inset-0 flex items-center justify-center z-20 bg-black/60">
            <div className="bg-surface rounded-3xl p-6 flex flex-col items-center gap-3 mx-8 shadow-elevation-3">
              <Loader2 className="w-10 h-10 text-brand animate-spin" />
              <p className="text-text-primary font-medium">Looking up user...</p>
            </div>
          </div>
        )}

        {/* Error */}
        {error && !resolvedUser && (
          <div className="absolute inset-0 flex items-center justify-center z-20 bg-black/60">
            <div className="bg-surface rounded-3xl p-6 mx-8 space-y-4 text-center shadow-elevation-3">
              <AlertCircle className="w-10 h-10 text-danger mx-auto" />
              <p className="text-text-primary font-medium">{error}</p>
              <Button onClick={reset} fullWidth>Try Again</Button>
            </div>
          </div>
        )}
      </div>

      {/* Resolved user bottom sheet */}
      <AnimatePresence>
        {resolvedUser && (
          <motion.div
            initial={{ y: 300, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 300, opacity: 0 }}
            className="absolute bottom-0 left-0 right-0 bg-bg rounded-t-3xl p-6 space-y-5 z-30 border-t border-border shadow-elevation-3"
          >
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
                {!resolvedUser.username && (
                  <div className="flex items-center gap-1 mt-1">
                    <AlertCircle className="w-3.5 h-3.5 text-warning" />
                    <p className="text-xs text-warning">External wallet — payment still works</p>
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
                {walletMode ? 'Use this address' : scannedAmount ? `Pay $${scannedAmount}` : 'Pay'}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Manual input modal / dialog */}
      <AnimatePresence>
        {showManual && (() => {
          const closeManual = () => { setShowManual(false); setUploadError(null) }
          const manualContent = (
            <>
              <p className="text-text-primary font-bold text-lg text-center">Upload QR Code</p>
              <p className="text-text-secondary text-sm text-center">Upload an image containing a QR code</p>

              {uploadError && (
                <p className="text-danger text-sm text-center bg-danger/10 rounded-xl px-4 py-2">{uploadError}</p>
              )}

              <label className="flex flex-col items-center justify-center w-full h-40 border-2 border-dashed border-border rounded-2xl cursor-pointer bg-surface hover:border-brand transition-colors">
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    setUploadError(null)

                    const reader = new FileReader()
                    reader.onload = async (ev) => {
                      const dataUrl = ev.target?.result as string
                      if (!dataUrl) return

                      const img = new Image()
                      img.onload = () => {
                        const W = img.naturalWidth || img.width
                        const H = img.naturalHeight || img.height

                        const decode = (w: number, h: number, sx = 0, sy = 0, sw = W, sh = H) => {
                          try {
                            const c = document.createElement('canvas')
                            c.width = w; c.height = h
                            const cx = c.getContext('2d', { willReadFrequently: true })
                            if (!cx) return null
                            cx.imageSmoothingEnabled = true
                            cx.imageSmoothingQuality = 'high'
                            cx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h)
                            const d = cx.getImageData(0, 0, w, h)
                            return jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' })
                          } catch { return null }
                        }

                        // Try full image at different sizes
                        const sizes = [512, 1024, 768, 256]
                        for (const size of sizes) {
                          const r = decode(size, Math.round(size * H / W))
                          if (r?.data) { setShowManual(false); handleScan(r.data); return }
                        }

                        // Try 4x4 grid regions at 512px each
                        for (let row = 0; row < 4; row++) {
                          for (let col = 0; col < 4; col++) {
                            const sw2 = Math.floor(W / 4), sh2 = Math.floor(H / 4)
                            const r = decode(512, 512, col * sw2, row * sh2, sw2, sh2)
                            if (r?.data) { setShowManual(false); handleScan(r.data); return }
                          }
                        }

                        setUploadError('No QR code found. Try a clearer image or move closer to the QR.')
                      }
                      img.onerror = () => setUploadError('Could not load image.')
                      img.src = dataUrl
                    }
                    reader.readAsDataURL(file)
                  }}
                />
                <Upload className="w-10 h-10 text-text-secondary/70 mb-2" />
                <p className="text-text-secondary text-sm">Tap to select image</p>
                <p className="text-text-secondary/60 text-xs mt-1">JPG, PNG, WebP supported</p>
              </label>

              <Button variant="secondary" fullWidth onClick={() => setShowManual(false)}>Cancel</Button>
            </>
          )
          return isDesktop ? (
            // Rendered as an overlay bounded to the scanner card itself
            // (root is `relative`) rather than DesktopDialogFrame's
            // viewport-level centered dialog — that put it in a different
            // spot than the card whenever the card was left-pinned or
            // narrower than the viewport, instead of "the same marked box".
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="absolute inset-0 flex items-center justify-center z-40 rounded-3xl"
              style={{ background: 'rgba(0,0,0,0.7)' }}
              onClick={closeManual}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                onClick={e => e.stopPropagation()}
                className="w-full mx-6 space-y-4 rounded-3xl p-6 shadow-elevation-3"
                style={{ maxWidth: 380, background: 'var(--surface)', border: '1px solid var(--border)' }}
              >
                {manualContent}
              </motion.div>
            </motion.div>
          ) : (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/80 flex items-end z-40"
              onClick={closeManual}
            >
              <motion.div
                initial={{ y: 200 }} animate={{ y: 0 }} exit={{ y: 200 }}
                onClick={e => e.stopPropagation()}
                className="w-full bg-bg rounded-t-3xl p-6 space-y-4 shadow-elevation-3"
              >
                {manualContent}
              </motion.div>
            </motion.div>
          )
        })()}
      </AnimatePresence>
    </div>
  )

  // Desktop: the card is inset within the same padded content area every
  // other desktop page uses (20/24/14px), bounded to that area's actual
  // height instead of stretching h-full past the viewport — that mismatch
  // was why the black viewfinder previously overflowed above the header
  // and below the fold. alignLeft (opened from a page with its own 2-column
  // layout, e.g. Pay's search screen) keeps the card pinned to the left
  // edge at a fixed width instead of stretching full-bleed.
  if (isDesktop) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '20px 24px 14px', alignItems: alignLeft ? 'flex-start' : 'stretch', minHeight: 0 }}>
        {card}
      </div>
    )
  }
  return card
}
