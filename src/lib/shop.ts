// A business's public shop identity, for Shop QR links (/paylink/<username>).
// shop_info returns nothing for personal accounts.
import { supabase } from '@/lib/supabase'

export type ShopInfo = {
  businessName: string; username: string; storeId: string | null; storeName: string | null
  avatarUrl: string | null; verified: boolean
  /** What kind of business it is ("Restaurant / Café") - the store's own type, else the business's. */
  category: string | null
  /** The store's address, when the business added one. */
  address: string | null
  /** Merchant category code (ISO 18245) for that category, e.g. "5812". */
  mcc: string | null
}

/** The line under a shop's name on its pay page: "Restaurant / Café · Andheri branch". Never the username. */
export function shopSubline(s: Pick<ShopInfo, 'businessName' | 'storeName' | 'category'>): string {
  const store = s.storeName && s.storeName.trim().toLowerCase() !== s.businessName.trim().toLowerCase() ? s.storeName.trim() : ''
  return [s.category?.trim() || '', store].filter(Boolean).join(' · ')
}

const shopCache = new Map<string, ShopInfo | null>()

/** The business behind a username (null for personal accounts). */
export async function getShopInfo(username: string, storeId: string | null): Promise<ShopInfo | null> {
  const key = `${username}|${storeId ?? ''}`
  if (shopCache.has(key)) return shopCache.get(key)!
  const { data, error } = await supabase.rpc('shop_info', { p_username: username, p_store: storeId })
  if (error) throw new Error(error.message)
  const r = Array.isArray(data) ? data[0] : data
  const info = r ? { businessName: r.business_name, username: r.username, storeId: r.store_id ?? null, storeName: r.store_name ?? null,
    avatarUrl: r.avatar_url ?? null, verified: !!r.verified, category: r.category ?? null, address: r.address ?? null, mcc: r.mcc ?? null } : null
  shopCache.set(key, info)
  return info
}


export type ShopLimits = { min: number | null; max: number | null }

/** The smallest / largest amount a customer may type on this shop's page. */
export async function getShopLimits(username: string): Promise<ShopLimits> {
  const { data } = await supabase.rpc('shop_limits', { p_username: username })
  const r = Array.isArray(data) ? data[0] : data
  return { min: r?.min_amount != null ? Number(r.min_amount) : null, max: r?.max_amount != null ? Number(r.max_amount) : null }
}

/** Owner: set (or clear with null) the limits for the Shop QR and payment link. */
export async function setShopLimits(min: number | null, max: number | null): Promise<void> {
  const { error } = await supabase.rpc('set_shop_limits', { p_min: min, p_max: max })
  if (error) throw new Error(error.message)
}
