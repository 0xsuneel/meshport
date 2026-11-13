// Business → saved items: products and prices tapped into an itemised bill.
// Items used in a bill are remembered (business_items_remember). A product
// can carry its barcode: scanning it at the counter adds it to the bill.
import { supabase } from '@/lib/supabase'

export type SavedItem = { id: string; name: string; price: number; barcode?: string | null }

export async function listItems(): Promise<SavedItem[]> {
  const { data, error } = await supabase.from('business_items').select('id, name, price, barcode')
    .order('used_count', { ascending: false }).order('name').limit(500)
  if (error) throw new Error(error.message)
  return (data ?? []).map((r: any) => ({ id: r.id, name: r.name, price: Number(r.price), barcode: r.barcode ?? null }))
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

/** A scanned code as stored: trimmed, at most 64 characters of what barcodes use. */
export function cleanBarcode(raw: string): string | null {
  const code = raw.trim()
  return /^[0-9A-Za-z\-.$/+% ]{3,64}$/.test(code) ? code : null
}

/** The saved item with this barcode, if any. */
export function itemForBarcode(items: SavedItem[], code: string): SavedItem | null {
  return items.find(i => i.barcode && i.barcode === code) ?? null
}

/** Saves a scanned product (a known name gets the barcode and new price). */
export async function saveBarcodeItem(name: string, price: number, barcode: string): Promise<SavedItem> {
  const { data, error } = await supabase.rpc('business_item_save_barcode', { p_name: name, p_price: price, p_barcode: barcode })
  if (error) throw new Error(error.message)
  const r = Array.isArray(data) ? data[0] : data
  if (!r) throw new Error('Could not save the item')
  return { id: r.id, name: r.name, price: Number(r.price), barcode: r.barcode ?? null }
}
