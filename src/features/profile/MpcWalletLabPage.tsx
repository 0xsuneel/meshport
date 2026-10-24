import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Copy, ExternalLink, KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { createPublicClient, formatEther, isAddress, parseEther, verifyMessage, type Hex } from 'viem'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { copyToClipboard } from '@/lib/utils'
import { arcTestnet } from '@/lib/chain'
import { arcRpcJson, arcTransport, ARC_EXPLORER } from '@/lib/arc'
import { relaySend } from '@/lib/arcService'
import { createMpcWallet, getMpcWallet, mpcWalletAccount, walletStatus, withMpcTiming, type MpcTiming } from '@/wallet'

// ── Keyless wallet (testnet) ──────────────────────────────────────────────────
// Profile → Support → Keyless wallet (testnet). A place to try the MPC wallet
// (docs/MPC_WALLET.md) before it replaces anything: create one, sign a test
// message, send a test payment. It is a separate wallet from the user's main
// one and only ever touches Arc testnet.

type Phase = 'loading' | 'none' | 'elsewhere' | 'ready' | 'creating'

const secs = (ms: number) => (ms / 1000).toFixed(1)
const timingParts = (t: MpcTiming) => 'this phone ' + secs(t.phone) + ' s · MeshPort ' + secs(t.server) + ' s · network & loading ' + secs(t.other) + ' s'
const timingText = (label: string, t: MpcTiming) => label + ' in ' + secs(t.total) + ' s - ' + timingParts(t)

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong') || 'Something went wrong'

export function MpcWalletLabPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const [phase, setPhase] = useState<Phase>('loading')
  const [address, setAddress] = useState<Hex | null>(null)
  const [balance, setBalance] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'sign' | 'send' | null>(null)
  const [signResult, setSignResult] = useState<string | null>(null)
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('0.01')
  const [txHash, setTxHash] = useState<Hex | null>(null)
  const [timing, setTiming] = useState<MpcTiming | null>(null)
  const [sendResult, setSendResult] = useState<string | null>(null)

  const refreshBalance = useCallback(async (a: Hex) => {
    try {
      const client = createPublicClient({ chain: arcTestnet, transport: arcTransport() })
      setBalance(formatEther(await client.getBalance({ address: a })))
    } catch { setBalance(null) }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const a = await getMpcWallet()
        if (cancelled) return
        if (!a) { setPhase('none'); return }
        setAddress(a)
        // The account has one; does this device hold its share?
        const here = await walletStatus(a).then(s => s.mpc).catch(() => false)
        if (cancelled) return
        setPhase(here ? 'ready' : 'elsewhere')
        if (here) refreshBalance(a)
      } catch (e) {
        if (!cancelled) { setError(errorText(e)); setPhase('none') }
      }
    })()
    return () => { cancelled = true }
  }, [refreshBalance])

  async function create() {
    setError(null); setPhase('creating')
    try {
      const { account, timing: t } = await createMpcWallet()
      setTiming(t)
      setAddress(account.address)
      setPhase('ready')
      refreshBalance(account.address)
    } catch (e) {
      setError(errorText(e)); setPhase('none')
    }
  }

  async function signTest() {
    if (!address) return
    setError(null); setSignResult(null); setBusy('sign')
    try {
      const message = `MeshPort keyless wallet test ${new Date().toISOString()}`
      const { value: signature, timing: t } = await withMpcTiming(() => mpcWalletAccount(address).signMessage({ message }))
      const ok = await verifyMessage({ address, message, signature })
      setSignResult(ok ? `Signature checks out: it was made by this wallet. ${timingText('Signed', t)}` : 'The signature did not verify.')
    } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }

  async function send() {
    if (!address) return
    setError(null); setTxHash(null); setSendResult(null)
    if (!isAddress(to)) { setError('Enter a valid 0x address to send to'); return }
    let value: bigint
    try { value = parseEther(amount) } catch { setError('Enter an amount like 0.01'); return }
    if (value <= 0n) { setError('Enter an amount above 0'); return }
    setBusy('send')
    try {
      // MeshPort's fast path (as Pay uses it): fixed Arc fees, then one request
      // that broadcasts to every Arc node and waits for the receipt server-side.
      const started = performance.now()
      const nonce = Number(BigInt((await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [address, 'pending'] })).result))
      let signing: MpcTiming | null = null
      const account = mpcWalletAccount(address)
      const signed = {
        ...account,
        signTransaction: async (tx: Parameters<typeof account.signTransaction>[0]) => {
          const { value: raw, timing: t } = await withMpcTiming(() => account.signTransaction(tx))
          signing = t
          return raw
        },
      } as typeof account
      const sent = await relaySend(signed, { to: to as Hex, value, gas: 21_000n, nonce }, h => setTxHash(h))
      setTxHash(sent.txHash)
      const total = (performance.now() - started) / 1000
      const outcome = sent.state === 'success' ? 'Confirmed' : sent.state === 'failed' ? 'Failed on-chain' : 'Sent'
      const s = signing as MpcTiming | null
      setSendResult(`${outcome} in ${total.toFixed(1)} s` + (s ? ` - signing ${secs(s.total)} s (${timingParts(s)})` : ''))
      refreshBalance(address)
    } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="header-row sticky top-0 z-20 bg-bg justify-between px-5 pt-header pb-header">
        <div className="flex items-center gap-3">
          {!isDesktop && (
            <button onClick={() => navigate(-1)} className="back-btn" aria-label="Back">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <h1 className="text-xl font-bold text-text-primary">Keyless wallet</h1>
          <span className="text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-warning/20 text-warning">Testnet</span>
        </div>
      </div>

      <div className="px-5 pb-8 pt-2 space-y-4 lg:max-w-[760px] lg:mx-auto">
        <div className="bg-surface border border-border rounded-3xl p-5 flex gap-4">
          <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center flex-shrink-0">
            <KeyRound className="w-5 h-5 text-accent-text" />
          </div>
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-semibold text-text-primary">No single key, anywhere</p>
            <p className="text-sm text-text-secondary leading-relaxed">
              This wallet&apos;s key is split three ways - this phone, MeshPort and a backup - and is never put back
              together, not even to sign. Any two sign together; MeshPort alone can&apos;t move your money.
            </p>
            <p className="text-xs text-text-secondary leading-relaxed">
              A preview on Arc testnet, separate from your main wallet. For now the backup share stays on this
              device, so this phone can still sign without MeshPort - moving it to your Google Drive or behind a
              passkey is the next step.
            </p>
          </div>
        </div>

        {error && <p role="alert" className="text-sm text-danger px-1">{error}</p>}

        {phase === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-text-secondary px-1"><Loader2 className="w-4 h-4 animate-spin" /> Checking for your keyless wallet…</div>
        )}

        {(phase === 'none' || phase === 'creating') && (
          <div className="bg-surface border border-border rounded-3xl p-5 space-y-3">
            <p className="text-sm text-text-secondary">
              Creating it takes up to a minute: this phone and MeshPort build the key together, and neither ever sees all of it.
            </p>
            <button className="btn-primary w-full py-3.5 flex items-center justify-center gap-2" disabled={phase === 'creating'} onClick={create}>
              {phase === 'creating' ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating your wallet…</> : 'Create keyless wallet'}
            </button>
          </div>
        )}

        {phase === 'elsewhere' && address && (
          <div className="bg-surface border border-border rounded-3xl p-5 space-y-2">
            <p className="text-sm font-semibold text-text-primary">Your keyless wallet is on another device</p>
            <p className="text-sm text-text-secondary font-mono break-all">{address}</p>
            <p className="text-sm text-text-secondary">Restoring it on this phone from your backup comes with the backup step.</p>
          </div>
        )}

        {phase === 'ready' && address && (
          <>
            <div className="bg-surface border border-border rounded-3xl p-5 space-y-3">
              <div className="flex items-center gap-2 text-success text-sm font-semibold"><ShieldCheck className="w-4 h-4" /> Keyless wallet ready</div>
              {timing && (
                <p className="text-xs text-text-secondary">
                  {timingText('Created', timing)}
                </p>
              )}
              <div className="flex items-start gap-2">
                <p className="text-sm text-text-primary font-mono break-all flex-1">{address}</p>
                <button className="back-btn" aria-label="Copy address" onClick={() => copyToClipboard(address)}><Copy className="w-4 h-4 text-text-secondary" /></button>
              </div>
              <p className="text-sm text-text-secondary">Balance: <span className="text-text-primary font-semibold">{balance ?? '…'} USDC</span> <span className="text-xs">(Arc testnet)</span></p>
              <p className="text-xs text-text-secondary">To test a payment, first send a little testnet USDC to this address from your main wallet.</p>
            </div>

            <div className="bg-surface border border-border rounded-3xl p-5 space-y-3">
              <p className="text-sm font-semibold text-text-primary">1. Sign a test message</p>
              <button className="btn-secondary w-full py-3 flex items-center justify-center gap-2" disabled={busy !== null} onClick={signTest}>
                {busy === 'sign' ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing with MeshPort…</> : 'Sign test message'}
              </button>
              {signResult && <p className="text-sm text-success">{signResult}</p>}
            </div>

            <div className="bg-surface border border-border rounded-3xl p-5 space-y-3">
              <p className="text-sm font-semibold text-text-primary">2. Send a test payment</p>
              <input value={to} onChange={e => setTo(e.target.value.trim())} placeholder="Send to 0x…" spellCheck={false}
                className="w-full bg-bg border border-border rounded-2xl px-4 py-3 text-sm text-text-primary font-mono outline-none focus:border-accent" />
              <input value={amount} onChange={e => setAmount(e.target.value.trim())} inputMode="decimal" placeholder="Amount in USDC"
                className="w-full bg-bg border border-border rounded-2xl px-4 py-3 text-sm text-text-primary outline-none focus:border-accent" />
              <button className="btn-primary w-full py-3.5 flex items-center justify-center gap-2" disabled={busy !== null} onClick={send}>
                {busy === 'send' ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</> : `Send ${amount || '0'} USDC`}
              </button>
              {txHash && (
                <a href={`${ARC_EXPLORER}/tx/${txHash}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-sm text-accent-text break-all">
                  View on ArcScan <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
                </a>
              )}
              {sendResult && <p className="text-xs text-text-secondary">{sendResult}</p>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
