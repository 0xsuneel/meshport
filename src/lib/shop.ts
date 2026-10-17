// A business's public shop identity, for Shop QR links (/paylink/<username>).
// shop_info returns nothing for personal accounts.
import { supabase } from '@/lib/supabase'

export type ShopInfo = {
  businessName: string; username: string; storeId: string | null; storeName: string | null
  avatarUrl: string | null; verified: boolean
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
    avatarUrl: r.avatar_url ?? null, verified: !!r.verified } : null
  shopCache.set(key, info)
  return info
}

