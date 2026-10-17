/**
 * BillItemsEditor — editable line-item table for invoices/bills.
 * Rows: name (flex), qty (narrow), unit price; remove button; Add item; total strip.
 */
import React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Divider } from './primitives'

export interface BillItem {
  name: string
  qty: number
  price: string  // pre-formatted like "120.00"
}

export interface BillItemsEditorProps {
  rows: BillItem[]
  onChange: (rows: BillItem[]) => void
  total: string  // pre-formatted like "$240.00"
}

function ItemRow({
  row,
  index,
  onChange,
  onRemove,
}: {
  row: BillItem
  index: number
  onChange: (r: BillItem) => void
  onRemove: () => void
}) {
  return (
    <div className="flex items-center gap-2 py-3">
      {/* Name */}
      <input
        type="text"
        value={row.name}
        onChange={(e) => onChange({ ...row, name: e.target.value })}
        placeholder="Item name"
        aria-label={`Item ${index + 1} name`}
        className="flex-1 min-w-0 bg-transparent text-sm text-text-primary placeholder:text-text-muted outline-none border-b border-border focus:border-brand-text transition-colors pb-1"
      />
      {/* Qty */}
      <input
        type="number"
        inputMode="numeric"
        value={row.qty}
        min={1}
        onChange={(e) => onChange({ ...row, qty: Math.max(1, parseInt(e.target.value) || 1) })}
        aria-label={`Item ${index + 1} quantity`}
        className="w-12 text-center bg-surface border border-border rounded-xl text-sm text-text-primary tabular-nums outline-none focus:border-brand-text transition-colors py-1.5"
      />
      {/* Price */}
      <input
        type="text"
        inputMode="decimal"
        value={row.price}
        onChange={(e) => onChange({ ...row, price: e.target.value.replace(/[^0-9.]/g, '') })}
        placeholder="0.00"
        aria-label={`Item ${index + 1} price`}
        className="w-20 text-right bg-transparent text-sm tabular-nums text-text-primary placeholder:text-text-muted outline-none border-b border-border focus:border-brand-text transition-colors pb-1"
      />
      {/* Remove */}
      <button
        type="button"
        aria-label={`Remove item ${index + 1}`}
        onClick={onRemove}
        className="size-8 flex items-center justify-center rounded-xl text-text-muted hover:text-danger hover:bg-danger/10 active:scale-95 transition-all shrink-0"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
}

export function BillItemsEditor({ rows, onChange, total }: BillItemsEditorProps) {
  function updateRow(i: number, r: BillItem) {
    const next = [...rows]; next[i] = r; onChange(next)
  }
  function removeRow(i: number) {
    onChange(rows.filter((_, idx) => idx !== i))
  }
  function addRow() {
    onChange([...rows, { name: '', qty: 1, price: '' }])
  }

  return (
    <div className="rounded-2xl bg-surface border border-border overflow-hidden">
      {/* Column headers */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-bg/60 border-b border-border">
        <span className="flex-1 text-[10px] font-semibold text-text-muted uppercase tracking-wider">Item</span>
        <span className="w-12 text-center text-[10px] font-semibold text-text-muted uppercase tracking-wider">Qty</span>
        <span className="w-20 text-right text-[10px] font-semibold text-text-muted uppercase tracking-wider">Price</span>
        <span className="w-8" />
      </div>

      {/* Item rows */}
      <div className="px-4">
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-muted">No items yet — add one below</p>
        ) : (
          rows.map((row, i) => (
            <React.Fragment key={i}>
              {i > 0 && <Divider />}
              <ItemRow
                row={row}
                index={i}
                onChange={(r) => updateRow(i, r)}
                onRemove={() => removeRow(i)}
              />
            </React.Fragment>
          ))
        )}
      </div>

      {/* Add item */}
      <div className="border-t border-border px-4 py-2">
        <button
          type="button"
          onClick={addRow}
          className="flex items-center gap-2 text-sm font-medium text-brand-text hover:opacity-80 active:scale-95 transition-all min-h-[44px]"
        >
          <Plus className="size-4" />
          Add item
        </button>
      </div>

      {/* Total strip */}
      <div className="flex items-center justify-between px-4 py-3 bg-brand/5 border-t border-brand/15">
        <span className="text-sm font-semibold text-text-secondary">Total</span>
        <span className="text-lg font-bold tabular-nums text-text-primary display">{total}</span>
      </div>
    </div>
  )
}
