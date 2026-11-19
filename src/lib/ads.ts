// Ads (19 Nov 2026): the Home banner's slides and the success screens' "For
// you" card, from public.app_ads (Admin → Ads). MeshPort's own features
// (sponsor null, "From MeshPort") and partners ("Sponsored · <sponsor>").
// Loaded once per session (kept in this tab for the next open) - the app's
// built-in list shows until then, so nothing waits on the network.
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useSettingsStore } from '@/store/settingsStore'

export type AdIcon = 'hub' | 'p2p' | 'swap' | 'chat' | 'bulk'
export interface Ad {
  id: string
  title: string
  body: string
  /** An app page ("/swap") or a website (https://…). */
  link: string
  image_url: string | null
  icon: AdIcon | null
  /** null: MeshPort's own. */
  sponsor: string | null
  on_home: boolean
  on_success: boolean
  active: boolean
  feature_flag: string | null
  sort: number
}

// The ads the app showed before Admin → Ads (used until the list loads, or if it can't).
const BUILT_IN: Ad[] = [
  { id: 'b-hub', title: 'Multichain Hub', body: 'Your USDC across 20+ chains', link: '/multichain', image_url: null, icon: 'hub', sponsor: null, on_home: true, on_success: true, active: true, feature_flag: null, sort: 10 },
  { id: 'b-p2p', title: 'P2P Marketplace', body: 'Buy & sell USDC safely with escrow', link: '/p2p', image_url: null, icon: 'p2p', sponsor: null, on_home: true, on_success: true, active: true, feature_flag: 'p2p_enabled', sort: 20 },
  { id: 'b-swap', title: 'Instant Swap', body: 'Change currency in seconds on Arc', link: '/swap', image_url: null, icon: 'swap', sponsor: null, on_home: true, on_success: true, active: true, feature_flag: null, sort: 30 },
  { id: 'b-chat', title: 'Pay in Chat', body: 'Send money as you chat', link: '/chat', image_url: null, icon: 'chat', sponsor: null, on_home: true, on_success: true, active: true, feature_flag: null, sort: 40 },
  { id: 'b-bulk', title: 'Bulk Payout', body: 'Pay many people at once', link: '/bulk-payout', image_url: null, icon: 'bulk', sponsor: null, on_home: true, on_success: true, active: true, feature_flag: null, sort: 50 },
]

const CACHE_KEY = 'mp-ads-v1'
let loaded: Ad[] | null = null
let loading: Promise<Ad[]> | null = null
const listeners = new Set<(ads: Ad[]) => void>()

function readCache(): Ad[] | null {
  try { const v = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); return Array.isArray(v) ? v : null } catch { return null }
}

/** The ads that are on, newest list (fetched once per session). */
export function loadAds(force = false): Promise<Ad[]> {
  if (loaded && !force) return Promise.resolve(loaded)
  if (loading && !force) return loading
  loading = (async () => {
    const { data, error } = await supabase.from('app_ads')
      .select('id,title,body,link,image_url,icon,sponsor,on_home,on_success,active,feature_flag,sort')
      .eq('active', true).order('sort', { ascending: true }).order('created_at', { ascending: true })
    if (error || !data) throw error ?? new Error('No ads')
    loaded = data as Ad[]
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(loaded)) } catch { /* private mode */ }
    listeners.forEach(f => f(loaded!))
    return loaded
  })().finally(() => { loading = null })
  return loading
}

/** A website (opens in a new tab), not an app page. */
export const isExternalAd = (ad: Pick<Ad, 'link'>) => /^https:\/\//i.test(ad.link)

/** Opens the ad: an app page in the app, a website in a new tab. */
export function openAd(ad: Pick<Ad, 'link'>, navigate: (path: string) => void): void {
  if (isExternalAd(ad)) window.open(ad.link, '_blank', 'noopener,noreferrer')
  else navigate(ad.link)
}

/** The site's name for a partner link ("portal.arc.io"). */
export const adHost = (link: string) => { try { return new URL(link).host } catch { return link } }

/** The ads for one place - Home's banner or the success screens - that this account can open. */
export function useAds(where: 'home' | 'success'): Ad[] {
  const [all, setAll] = useState<Ad[]>(() => loaded ?? readCache() ?? BUILT_IN)
  useEffect(() => {
    listeners.add(setAll)
    void loadAds().then(setAll).catch(() => { /* keep what's shown */ })
    return () => { listeners.delete(setAll) }
  }, [])
  const settings = useSettingsStore(s => s.settings)
  return all.filter(a => a.active && (where === 'home' ? a.on_home : a.on_success)
    && (!a.feature_flag || settings[a.feature_flag]?.enabled !== false))
}
