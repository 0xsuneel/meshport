// Small spinner with the logo of the chain being checked right now inside
// it - shown next to "Available To Bring" while the all-chains scan runs.
import { useEffect, useState } from 'react'
import { EXTERNAL_SCAN_PROGRESS_EVENT, currentScanningChain } from '@/blockchain/BlockchainManager'
import { chainLogoSrc } from '@/lib/chainLogos'

export function ChainScanSpinner({ chain, size = 18 }: { chain: string | null; size?: number }) {
  const logo = Math.round(size * 0.62)
  const inset = (size - logo) / 2
  return (
    <span aria-label="Loading balances" style={{ position: 'relative', width: size, height: size, flexShrink: 0, display: 'inline-block' }}>
      <style>{'@keyframes chainScanSpin{to{transform:rotate(360deg)}}'}</style>
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.25)',
        borderTopColor: '#fff', animation: 'chainScanSpin 0.8s linear infinite' }} />
      {chain && (
        <img key={chain} src={chainLogoSrc(chain)} alt="" width={logo} height={logo}
          style={{ position: 'absolute', top: inset, left: inset, borderRadius: '50%', display: 'block' }}
          onError={e => { (e.currentTarget as HTMLImageElement).src = '/logos/chains/_fallback.svg' }} />
      )}
    </span>
  )
}

/** The chain this wallet's scan has been waiting on longest, while `active`. */
export function useScanningChain(walletAddress: string | null | undefined, active: boolean): string | null {
  const [chain, setChain] = useState<string | null>(null)
  useEffect(() => {
    if (!active || !walletAddress) { setChain(null); return }
    const update = () => setChain(currentScanningChain(walletAddress))
    update()
    window.addEventListener(EXTERNAL_SCAN_PROGRESS_EVENT, update)
    return () => window.removeEventListener(EXTERNAL_SCAN_PROGRESS_EVENT, update)
  }, [walletAddress, active])
  return chain
}
