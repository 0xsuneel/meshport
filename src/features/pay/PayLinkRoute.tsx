// A business's payment link (/l/<shop>/<slug>, 28 Nov): what it sells and
// its price (or any amount), paid like the Shop QR - the payment is tagged
// with the link, so the business sees which link brought it in.
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getShopInfo, type ShopInfo } from '@/lib/shop'
import { getPublicPayLink, type PublicPayLink } from '@/lib/businessCounters'
import { supabase } from '@/lib/supabase'
import { MeshLoader } from '@/components/ui/MeshLoader'
import { ShopPayPage } from './ShopPayPage'

export function PayLinkRoute() {
  const { username = '', slug = '' } = useParams<{ username: string; slug: string }>()
  const navigate = useNavigate()
  const [state, setState] = useState<{ shop: ShopInfo; link: PublicPayLink; wallet: string | null } | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void (async () => {
      const link = await getPublicPayLink(username, slug)
      const shop = link ? await getShopInfo(username, link.storeId).catch(() => null) : null
      if (!live) return
      setState(link && shop ? { shop, link, wallet: null } : null)
      // The business's wallet, so a signed-in payer goes straight to Review
      // (looked up after the page shows - Pay works without it, a step longer).
      if (link && shop) {
        const { data } = await supabase.from('users').select('wallet_address').eq('username', shop.username.toLowerCase()).maybeSingle()
        const wallet = (data as { wallet_address?: string } | null)?.wallet_address ?? null
        if (live && wallet) setState(s => s ? { ...s, wallet } : s)
      }
    })()
    return () => { live = false }
  }, [username, slug])

  if (state === undefined) return <div className="h-full flex items-center justify-center bg-bg"><MeshLoader /></div>
  if (!state) return (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-8 text-center bg-bg">
      <p className="text-lg font-bold text-text-primary">This link doesn't exist</p>
      <p className="text-sm text-text-muted">Check the link with the business, or pay them from their shop page.</p>
      <button type="button" onClick={() => navigate(`/paylink/${username}`)} className="mt-2 h-11 px-5 rounded-2xl bg-brand text-white font-semibold">Go to the shop</button>
    </div>
  )
  return <ShopPayPage shop={state.shop} wallet={state.wallet} link={{ slug, info: state.link }} />
}
