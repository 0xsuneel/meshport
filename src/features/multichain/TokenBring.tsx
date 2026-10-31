// ── Bring EURC / cirBTC to Arc (Circle CCTPx) ───────────────────────────────
// The Hub's Bring tab, personal accounts only, with EURC or cirBTC picked:
// the chains Circle's registry has the token on (and on Arc), the balance of
// it on each, and a one-chain flow - amount, passcode, then one kit.bridge()
// from that chain to Arc: approve, send, Circle attests, Circle's forwarder
// delivers on Arc.
//
// Unlike USDC Bring there is no MeshPort relayer here: the send is signed
// and paid on the source chain, so the wallet needs that chain's native gas
// (ETH / AVAX / POL) - and CCTPx's own fee is charged in that same native
// currency. Checked before anything is signed; the recipient gets exactly
// the amount sent.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/store'
import { PinSheet } from '@/components/ui/PinSheet'
import { getReadySigner, prepareSigner } from '@/lib/paymentReadiness'
import { isAccountLockedNow, ACCOUNT_LOCKED_MESSAGE } from '@/lib/accountLockRule'
import { EXTERNAL_CHAINS, SDK_CHAIN_RPCS, ARC_RPCS } from '@/blockchain/chains'
import { ARC_CHAIN_KEY, explorerTxUrl, arcExplorerTxUrl } from '@/lib/chainExplorers'
import { formatAmount, trimTrailingZeros } from '@/lib/utils'
import { bridgeTokenDecimals, bridgeTokenInfo, useTokenRouteChains, type CctpxToken } from '@/lib/tokenBridge'
import type { WalletAccount } from '@/wallet'

/** A CCTPx chain (kit id) → MeshPort's chain id, name and native currency. */
const CHAIN_INFO: Record<string, { id: string; label: string; native: string }> = {
  Ethereum_Sepolia:     { id: 'Ethereum_Sepolia', label: 'Ethereum', native: 'ETH' },
  Base_Sepolia:         { id: 'Base_Sepolia',     label: 'Base',     native: 'ETH' },
  Arbitrum_Sepolia:     { id: 'Arbitrum_Sepolia', label: 'Arbitrum', native: 'ETH' },
  Optimism_Sepolia:     { id: 'Optimism_Sepolia', label: 'OP Sepolia', native: 'ETH' },
  Avalanche_Fuji:       { id: 'Avalanche_Fuji',   label: 'Avalanche', native: 'AVAX' },
  Polygon_Amoy_Testnet: { id: 'Polygon_Sepolia',  label: 'Polygon',  native: 'POL' },
}
const chainInfo = (sdk: string) => CHAIN_INFO[sdk] ?? { id: sdk, label: sdk.replace(/_/g, ' '), native: 'ETH' }

export type TokenBringChain = { sdk: string; label: string; balance: number; tokenAddress: string }

const fmtToken = (token: CctpxToken, n: number) => token === 'cirBTC' ? trimTrailingZeros(n.toFixed(8)) || '0' : formatAmount(n)

// Each RPC in turn; the first that answers.
async function withRpc<T>(rpcs: string[], fn: (p: any) => Promise<T>): Promise<T> {
  const { JsonRpcProvider } = await import('ethers')
  let last: unknown
  for (const url of rpcs) {
    const p = new JsonRpcProvider(url, undefined, { staticNetwork: true })
    try { return await fn(p) } catch (e) { last = e } finally { p.destroy() }
  }
  throw last ?? new Error('No RPC')
}

const rpcsOf = (sdk: string) => EXTERNAL_CHAINS[chainInfo(sdk).id]?.rpcs ?? []

async function readTokenBalance(sdk: string, tokenAddress: string, owner: string, decimals: number): Promise<number> {
  const { Contract, formatUnits } = await import('ethers')
  return withRpc(rpcsOf(sdk), async p => {
    const raw: bigint = await new Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], p).balanceOf(owner)
    return Number(formatUnits(raw, decimals))
  })
}

async function readNativeBalance(sdk: string, owner: string): Promise<number> {
  const { formatEther } = await import('ethers')
  return withRpc(rpcsOf(sdk), async p => Number(formatEther(await p.getBalance(owner))))
}

// The wallet's adapter with plain RPC providers: everything is sent by the
// wallet itself (MeshPort's relayer only takes USDC's own calls).
const providerCache = new Map<string, any>()
async function buildDirectAdapter(signer: WalletAccount) {
  const { createWalletAdapter } = await import('@/wallet')
  return createWalletAdapter({
    account: signer,
    getProvider: async ({ chain }: { chain: any }) => {
      const rpcs = chain?.name === 'Arc Testnet' ? ARC_RPCS : (SDK_CHAIN_RPCS[chain?.name] ?? [])
      const key = rpcs.join('|')
      if (!providerCache.has(key)) {
        const { JsonRpcProvider, FallbackProvider } = await import('ethers')
        const ps = rpcs.map((url: string) => new JsonRpcProvider(url))
        providerCache.set(key, ps.length > 1
          ? new FallbackProvider(ps.map((p: any, i: number) => ({ provider: p, priority: i, weight: 1, stallTimeout: 2000 })), undefined, { quorum: 1 })
          : ps[0])
      }
      return providerCache.get(key)!
    },
  })
}

// ── The chain list ──────────────────────────────────────────────────────────
export function TokenBringList({ token, onPick }: { token: CctpxToken; onPick: (c: TokenBringChain) => void }) {
  const walletAddress = useAuthStore(s => s.walletAddress)
  const routes = useTokenRouteChains(token)
  const [balances, setBalances] = useState<Record<string, number | null>>({})
  const decimals = bridgeTokenDecimals(token)

  useEffect(() => {
    setBalances({})
    if (!walletAddress || !routes.chains || !routes.deployments) return
    let cancelled = false
    for (const sdk of routes.chains) {
      const addr = routes.deployments.get(sdk)
      if (!addr) continue
      readTokenBalance(sdk, addr, walletAddress, decimals)
        .then(b => { if (!cancelled) setBalances(prev => ({ ...prev, [sdk]: b })) })
        .catch(() => { if (!cancelled) setBalances(prev => ({ ...prev, [sdk]: null })) })
    }
    return () => { cancelled = true }
  }, [walletAddress, routes.chains, routes.deployments, decimals])

  const note = (text: string) => <div style={{ padding: 18, textAlign: 'center', fontSize: 13, color: 'var(--text-secondary)' }}>{text}</div>
  if (routes.loading) return note(`Finding chains that carry ${token}…`)
  if (routes.error) return note(`Couldn't load ${token} routes from Circle. Try again in a moment.`)
  if (!routes.chains?.length) return note(`${token} can't be brought to Arc from any chain right now.`)

  return (
    <>
      {routes.chains.map(sdk => {
        const info = chainInfo(sdk)
        const bal = balances[sdk]
        const has = (bal ?? 0) > 0
        return (
          <button key={sdk} disabled={!has}
            onClick={() => onPick({ sdk, label: info.label, balance: bal ?? 0, tokenAddress: routes.deployments!.get(sdk)! })}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 16, textAlign: 'left',
              cursor: has ? 'pointer' : 'default', opacity: has ? 1 : 0.55,
              background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
              border: has ? '1px solid color-mix(in srgb, var(--brand) 35%, transparent)' : '1px solid var(--border)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 'min(15px, 4.1vw)', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.25 }}>{info.label}</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                  color: 'var(--success-text)', background: 'color-mix(in srgb, var(--success) 14%, transparent)' }}>CCTPx</span>
              </div>
            </div>
            <span style={{ fontSize: 'min(16px, 4.2vw)', fontWeight: 800, color: has ? 'var(--text-primary)' : 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', flexShrink: 1, minWidth: 0, maxWidth: '58%', textAlign: 'right' }}>
              <span style={{ whiteSpace: 'nowrap' }}>{bal === undefined ? '…' : bal === null ? '-' : has ? fmtToken(token, bal) : '0'}</span> <span style={{ whiteSpace: 'nowrap' }}>{token}</span>
            </span>
          </button>
        )
      })}
      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)', padding: '2px 4px' }}>
        Sent from your wallet on that chain: it needs a little of the chain's own gas coin (ETH, AVAX or POL), which also pays Circle's fee.
      </div>
    </>
  )
}

// ── One bring ───────────────────────────────────────────────────────────────
type Phase = 'form' | 'sending' | 'done' | 'failed'
type Quote = { fee: number; gas: number; quote: unknown; native: number }
const STEPS = ['approve', 'transfer', 'fetchAttestation', 'forward'] as const
type StepKey = typeof STEPS[number]

export function TokenBringFlow({ token, chain, onClose, onDone }: {
  token: CctpxToken; chain: TokenBringChain; onClose: () => void; onDone?: () => void
}) {
  const walletAddress = useAuthStore(s => s.walletAddress)
  const storedPasscode = useAuthStore(s => s.passcode)
  const info = chainInfo(chain.sdk)
  const decimals = bridgeTokenDecimals(token)
  const [amount, setAmount] = useState('')
  const [phase, setPhase] = useState<Phase>('form')
  const [pinOpen, setPinOpen] = useState(false)
  const [pass, setPass] = useState('')
  const [passError, setPassError] = useState('')
  const [error, setError] = useState('')
  const [quote, setQuote] = useState<Quote | null>(null)
  const [steps, setSteps] = useState<Record<StepKey, 'pending' | 'active' | 'done' | 'error'>>({ approve: 'pending', transfer: 'pending', fetchAttestation: 'pending', forward: 'pending' })
  const [hashes, setHashes] = useState<{ send?: string; deliver?: string }>({})
  const busy = useRef(false)

  const num = parseFloat(amount) || 0
  const over = num > chain.balance
  const valid = num > 0 && !over

  useEffect(() => { prepareSigner() }, [])

  const params = useCallback((adapter: any) => ({
    from: { adapter, chain: chain.sdk },
    to: { chain: ARC_CHAIN_KEY, recipientAddress: walletAddress, useForwarder: true },
    amount: num.toFixed(decimals),
    token,
  }), [chain.sdk, walletAddress, num, decimals, token])

  // Circle's fee and the gas, both in the chain's native coin, against what the wallet has there.
  const estimate = useCallback(async (adapter: any): Promise<Quote> => {
    const { AppKit } = await import('@circle-fin/app-kit')
    const kit = new AppKit({ disableErrorReporting: true, disableAnalytics: true } as any)
    const [est, native]: [any, number] = await Promise.all([kit.estimateBridge(params(adapter) as any), readNativeBalance(chain.sdk, walletAddress!)])
    const feeRows: any[] = est?.fees ?? []
    if (feeRows.some(f => f.amount === null || f.error)) throw new Error('Circle fee unavailable for this route')
    const fee = feeRows.reduce((t, f) => t + (parseFloat(f.amount) || 0), 0)
    const gas = (est?.gasFees ?? []).reduce((t: number, g: any) => t + (parseFloat(g?.fees?.fee ?? g?.amount) || 0), 0)
    return { fee, gas, quote: est?.quote ?? null, native }
  }, [params, chain.sdk, walletAddress])

  // On Review, when the wallet is already open: the fee before the passcode.
  useEffect(() => {
    setQuote(null)
    if (!valid || !walletAddress) return
    let cancelled = false
    const t = setTimeout(async () => {
      const signer = await getReadySigner(undefined, { silent: true })
      if (!signer || cancelled) return
      try { const q = await estimate(await buildDirectAdapter(signer)); if (!cancelled) setQuote(q) } catch { /* shown after the passcode */ }
    }, 500)
    return () => { cancelled = true; clearTimeout(t) }
  }, [valid, walletAddress, estimate])

  const run = useCallback(async (passcode?: string) => {
    if (busy.current) return
    if (isAccountLockedNow()) { setPassError(ACCOUNT_LOCKED_MESSAGE); return }
    busy.current = true
    try {
      if (storedPasscode) {
        prepareSigner(passcode)
        const { verifyPasscode } = await import('@/lib/security')
        if (!passcode || !await verifyPasscode(passcode, storedPasscode)) { setPassError('Incorrect passcode. Try again.'); setPass(''); return }
      }
      const signer = await getReadySigner(passcode)
      if (!signer) { setPassError("Couldn't open your wallet. Try again."); setPass(''); return }
      setPinOpen(false); setPass(''); setPassError(''); setError('')
      setPhase('sending')
      const adapter = await buildDirectAdapter(signer)
      // Nothing is signed until the wallet can pay the gas and Circle's fee.
      const q = await estimate(adapter)
      setQuote(q)
      if (q.native < q.fee + q.gas) {
        throw new Error(`Needs about ${trimTrailingZeros((q.fee + q.gas).toFixed(6))} ${info.native} on ${info.label} for gas and Circle's fee - you have ${trimTrailingZeros(q.native.toFixed(6))} ${info.native}.`)
      }
      const { AppKit } = await import('@circle-fin/app-kit')
      const kit = new AppKit({ disableErrorReporting: true, disableAnalytics: true } as any)
      setSteps(s => ({ ...s, approve: 'active' }))
      for (const key of STEPS) {
        kit.on(`bridge.${key}` as any, (payload: any) => {
          const state = payload?.values?.state || 'success'
          const hash = payload?.values?.txHash || payload?.txHash || ''
          if (hash && key === 'transfer') setHashes(h => ({ ...h, send: hash }))
          if (hash && key === 'forward') setHashes(h => ({ ...h, deliver: hash }))
          setSteps(s => {
            const next = { ...s }
            const i = STEPS.indexOf(key)
            next[key] = state === 'error' ? 'error' : state === 'pending' ? 'active' : 'done'
            if (next[key] === 'done') {
              STEPS.slice(0, i).forEach(k => { next[k] = 'done' })
              if (STEPS[i + 1] && next[STEPS[i + 1]] === 'pending') next[STEPS[i + 1]] = 'active'
            }
            return next
          })
        })
      }
      const result: any = await Promise.race([
        kit.bridge({ ...params(adapter), ...(q.quote ? { quote: q.quote } : {}) } as any),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(
          `This is taking longer than expected. If it left ${info.label}, your ${token} will still arrive on Arc.`)), 12 * 60_000)),
      ])
      const stepHash = (name: string) => result?.steps?.find((x: any) => x.name === name)?.txHash || ''
      const send = stepHash('transfer'), deliver = stepHash('forward')
      setHashes({ send, deliver })
      if (result?.state === 'error') {
        const failed = result?.steps?.find((x: any) => x.state === 'error')
        throw new Error(failed?.errorMessage || failed?.error?.message || `The ${token} transfer didn't complete.`)
      }
      if (send) {
        const { user } = useAuthStore.getState()
        import('@/lib/ActivityService').then(({ Activity }) => Activity.claim({
          walletAddress: walletAddress!, userId: user?.id, txHash: send, amount: num, sourceChain: info.id, tokenSymbol: token,
        })).catch(() => {})
      }
      setSteps({ approve: 'done', transfer: 'done', fetchAttestation: 'done', forward: 'done' })
      setPhase('done')
      onDone?.()
    } catch (e: any) {
      setError(String(e?.shortMessage ?? e?.message ?? 'Bring failed').slice(0, 220))
      setSteps(s => {
        const next = { ...s }
        const active = STEPS.find(k => next[k] === 'active')
        if (active) next[active] = 'error'
        return next
      })
      setPhase('failed')
    } finally {
      busy.current = false
    }
  }, [storedPasscode, estimate, params, info, token, walletAddress, num, onDone])

  const tok = bridgeTokenInfo(token)
  const box = { padding: '14px 16px', borderRadius: 16, background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)', border: '1px solid var(--border)' } as const
  const primary = (enabled: boolean) => ({ width: '100%', padding: '15px 0', borderRadius: 16, border: 'none', fontSize: 15, fontWeight: 700,
    cursor: enabled ? 'pointer' : 'default', color: '#fff', background: 'var(--brand)', opacity: enabled ? 1 : 0.45 }) as const
  const LABEL: Record<StepKey, string> = { approve: `Approve ${token}`, transfer: `Send from ${info.label}`, fetchAttestation: 'Circle attestation', forward: 'Deliver on Arc' }
  const sendUrl = hashes.send ? explorerTxUrl(info.id, hashes.send) : null
  const deliverUrl = hashes.deliver ? arcExplorerTxUrl(hashes.deliver) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '8px 12px 24px' }}>
      <div style={{ ...box, display: 'flex', alignItems: 'center', gap: 12 }}>
        <img src={tok.logo} alt="" width={32} height={32} style={{ borderRadius: 16 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{token} from {info.label}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>Available: {fmtToken(token, chain.balance)} {token}</div>
        </div>
      </div>

      {phase === 'form' && (
        <>
          <div style={{ ...box, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input value={amount} inputMode="decimal" placeholder="0" aria-label={`Amount of ${token}`}
              onChange={e => {
                const v = e.target.value.replace(/[^0-9.]/g, '')
                const [w, f] = v.split('.')
                setAmount(f === undefined ? w : `${w}.${f.slice(0, decimals)}`)
              }}
              style={{ flex: 1, minWidth: 0, fontSize: 28, fontWeight: 800, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)' }} />
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-secondary)' }}>{token}</span>
            <button onClick={() => setAmount(trimTrailingZeros(chain.balance.toFixed(decimals)))}
              style={{ padding: '6px 10px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--brand-text)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Max</button>
          </div>
          {over && <div role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>More than you have on {info.label}.</div>}
          {valid && (
            <div style={{ ...box, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
              {([
                ['You receive on Arc', `${fmtToken(token, num)} ${token}`],
                ["Circle's fee", quote ? `${trimTrailingZeros(quote.fee.toFixed(6))} ${info.native}` : 'Shown after passcode'],
                ['Network gas', quote ? `~${trimTrailingZeros(quote.gas.toFixed(6))} ${info.native}` : `Paid in ${info.native}`],
              ] as const).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{k}</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 700, textAlign: 'right' }}>{v}</span>
                </div>
              ))}
              {quote && quote.native < quote.fee + quote.gas && (
                <div role="alert" style={{ color: 'var(--warning)' }}>
                  Your wallet has {trimTrailingZeros(quote.native.toFixed(6))} {info.native} on {info.label} - add some for gas and Circle's fee.
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Circle CCTPx · 20–90s · native {token} on Arc</div>
            </div>
          )}
          <button disabled={!valid} onClick={() => { setPass(''); setPassError(''); setPinOpen(true) }} style={primary(valid)}>
            Bring {valid ? `${fmtToken(token, num)} ` : ''}{token} to Arc
          </button>
          <button onClick={onClose} style={{ ...primary(true), background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>Back</button>
        </>
      )}

      {phase !== 'form' && (
        <div style={{ ...box, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>
            {phase === 'sending' ? `Bringing ${fmtToken(token, num)} ${token}…` : phase === 'done' ? `${fmtToken(token, num)} ${token} is on Arc` : "Bring didn't finish"}
          </div>
          {STEPS.map(k => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
              <span aria-hidden style={{ width: 10, height: 10, borderRadius: 5, flexShrink: 0,
                background: steps[k] === 'done' ? 'var(--success)' : steps[k] === 'error' ? 'var(--danger)' : steps[k] === 'active' ? 'var(--brand)' : 'var(--border)' }} />
              <span style={{ color: steps[k] === 'pending' ? 'var(--text-secondary)' : 'var(--text-primary)', fontWeight: steps[k] === 'active' ? 700 : 500 }}>{LABEL[k]}</span>
            </div>
          ))}
          {phase === 'sending' && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Keep this open until it's sent from {info.label}.</div>}
          {error && <div role="alert" style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--danger)' }}>{error}</div>}
          {phase === 'failed' && hashes.send && (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>It already left {info.label} - Circle will still deliver it to Arc.</div>
          )}
          {(sendUrl || deliverUrl) && (
            <div style={{ display: 'flex', gap: 14, fontSize: 13, fontWeight: 600 }}>
              {sendUrl && <a href={sendUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--brand-text)' }}>Sent on {info.label}</a>}
              {deliverUrl && <a href={deliverUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--brand-text)' }}>Delivered on Arc</a>}
            </div>
          )}
          {phase !== 'sending' && (
            <button onClick={phase === 'failed' && !hashes.send ? () => { setPhase('form'); setError('') } : onClose} style={primary(true)}>
              {phase === 'failed' && !hashes.send ? 'Try again' : 'Done'}
            </button>
          )}
        </div>
      )}

      <PinSheet open={pinOpen} id="token-bring-pass"
        onClose={() => { setPinOpen(false); setPass(''); setPassError('') }}
        title="Confirm bring" placement="panel"
        subtitle={`Bring ${fmtToken(token, num)} ${token} from ${info.label} to Arc`}
        amountLabel={`${fmtToken(token, num)} ${token}`}
        card={{ label: 'Bringing from', name: info.label, amount: fmtToken(token, num), unit: token }} bioVerb="Confirm"
        value={pass} onChange={v => { setPass(v); setPassError('') }} error={passError || undefined}
        fallbackConfirm={storedPasscode ? undefined : { label: 'Confirm', onConfirm: () => { void run() } }}
        onComplete={pin => { void run(pin) }} />
    </div>
  )
}
