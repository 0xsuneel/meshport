// Business → saved items: products and prices tapped into an itemised bill.
// Items used in a bill are remembered (business_items_remember).
import { supabase } from '@/lib/supabase'

export type SavedItem = { id: string; name: string; price: number }

export async function listItems(): Promise<SavedItem[]> {
  const { data, error } = await supabase.from('business_items').select('id, name, price')
    .order('used_count', { ascending: false }).order('name').limit(100)
  if (error) throw new Error(error.message)
  return (data ?? []).map((r: any) => ({ id: r.id, name: r.name, price: Number(r.price) }))
}

export async function rememberItems(items: { name: string; price: number }[]): Promise<void> {
  const list = items.filter(i => i.name.trim()).map(i => ({ name: i.name.trim(), price: i.price }))
  if (!list.length) return
  await supabase.rpc('business_items_remember', { p_items: list })
}

export async function deleteItem(id: string): Promise<void> {
  const { error } = await supabase.from('business_items').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
