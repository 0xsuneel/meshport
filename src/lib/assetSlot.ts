// Last EURC/cirBTC amounts per wallet, for instant first paint (USDC's lives
// in the wallet store). Testnet balances only - nothing sensitive.
export type AssetSlot = { eurc: number; cirbtc: number }
const assetSlotKey = (addr: string | null) => addr ? `meshport_assets_${addr.toLowerCase()}` : null
export function loadAssetSlot(addr: string | null): AssetSlot {
  const k = assetSlotKey(addr)
  try {
    const v = k ? JSON.parse(localStorage.getItem(k) || 'null') : null
    return { eurc: typeof v?.eurc === 'number' ? v.eurc : 0, cirbtc: typeof v?.cirbtc === 'number' ? v.cirbtc : 0 }
  } catch { return { eurc: 0, cirbtc: 0 } }
}
export function saveAssetSlot(addr: string | null, patch: Partial<AssetSlot>) {
  const k = assetSlotKey(addr)
  if (!k) return
  try { localStorage.setItem(k, JSON.stringify({ ...loadAssetSlot(addr), ...patch })) } catch {}
}
