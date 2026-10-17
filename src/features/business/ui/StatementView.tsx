/**
 * StatementView + PrintableStatement — period summary with CSV / PDF actions.
 */
import React from 'react'
import { Download, Share2 } from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────────────────

export type StatementRange = 'today' | 'week' | 'month'

export type StatementTone = 'default' | 'success' | 'danger' | 'warning'

export interface StatementRow {
  label: string
  value: string
  tone?: StatementTone
}

export interface StatementPaymentRow {
  time: string      // ISO
  from: string
  order?: string
  chain: string
  amount: string
  status: string
}

export interface StatementViewProps {
  range: StatementRange
  onRange: (r: StatementRange) => void
  loading: boolean
  rows: StatementRow[]
  periodLabel: string   // e.g. "17 Oct 2026"
  onCsv: () => void
  onPdf: () => void
}

export interface PrintableStatementProps {
  storeName: string
  handle: string
  periodLabel: string
  rows: StatementRow[]
  payments: StatementPaymentRow[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RANGES: { id: StatementRange; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'week',  label: 'This week' },
  { id: 'month', label: 'This month' },
]

const TONE_CLS: Record<StatementTone, string> = {
  default: 'text-text-primary',
  success: 'text-success',
  danger:  'text-danger',
  warning: 'text-warning',
}

// ─── StatementView ────────────────────────────────────────────────────────────

export function StatementView({
  range,
  onRange,
  loading,
  rows,
  periodLabel,
  onCsv,
  onPdf,
}: StatementViewProps) {
  return (
    <div className="flex flex-col gap-5 pb-8">

      {/* Range chips */}
      <div className="flex gap-2 px-5 pt-6">
        {RANGES.map(({ id, label }) => {
          const active = range === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => onRange(id)}
              className={`flex-1 rounded-full py-2.5 text-xs font-semibold transition-colors min-h-[44px] ${
                active
                  ? 'bg-brand text-white'
                  : 'bg-surface border border-border text-text-secondary hover:border-text-muted'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>

      {/* Period label */}
      <p className="px-5 text-xs text-text-muted">{periodLabel}</p>

      {/* Summary card */}
      <div className="mx-5 rounded-3xl bg-card border border-border overflow-hidden">
        {loading ? (
          <div className="flex flex-col gap-0">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center justify-between px-5 py-4 border-b border-border last:border-0">
                <div className="h-3 w-32 rounded bg-border/60 animate-pulse" />
                <div className="h-3 w-16 rounded bg-border/60 animate-pulse" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center py-12 text-center px-6">
            <p className="text-sm font-medium text-text-secondary">No data for this period</p>
          </div>
        ) : (
          <div className="flex flex-col gap-0">
            {rows.map((row, i) => (
              <div
                key={i}
                className="flex items-center justify-between px-5 py-4 border-b border-border last:border-0"
              >
                <span className="text-sm text-text-secondary">{row.label}</span>
                <span className={`text-sm font-semibold tabular-nums ${TONE_CLS[row.tone ?? 'default']}`}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 px-5">
        <button
          type="button"
          onClick={onCsv}
          className="flex-1 flex items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-medium border border-border text-text-secondary hover:border-text-muted active:scale-[0.98] transition-all min-h-[48px]"
        >
          <Download className="size-4" />
          Download CSV
        </button>
        <button
          type="button"
          onClick={onPdf}
          className="flex-1 flex items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-semibold bg-brand text-white hover:bg-brand/90 active:scale-[0.98] transition-all min-h-[48px]"
        >
          <Share2 className="size-4" />
          Share PDF
        </button>
      </div>
    </div>
  )
}

// ─── PrintableStatement — A4 black-on-white, class=print-only-area ────────────

export function PrintableStatement({
  storeName,
  handle,
  periodLabel,
  rows,
  payments,
}: PrintableStatementProps) {
  return (
    <div
      className="print-only-area flex flex-col w-full max-w-2xl mx-auto p-10 bg-white text-black font-sans text-sm"
      style={{ fontFamily: 'DM Sans, sans-serif' }}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-8 border-b border-black/20 pb-6">
        <div>
          <p className="text-xl font-bold">{storeName}</p>
          <p className="text-xs text-gray-500">{handle}</p>
        </div>
        <div className="text-right">
          <p className="font-semibold">Business Statement</p>
          <p className="text-xs text-gray-500">{periodLabel}</p>
        </div>
      </div>

      {/* Summary table */}
      <p className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">Summary</p>
      <table className="w-full mb-8 text-sm">
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-gray-100">
              <td className="py-2 text-gray-700">{row.label}</td>
              <td className="py-2 text-right font-semibold tabular-nums">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Payments table */}
      <p className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">Payments</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-300">
            <th className="py-2 text-left font-semibold text-gray-500">Time</th>
            <th className="py-2 text-left font-semibold text-gray-500">From</th>
            <th className="py-2 text-left font-semibold text-gray-500">Order</th>
            <th className="py-2 text-left font-semibold text-gray-500">Chain</th>
            <th className="py-2 text-right font-semibold text-gray-500">Amount</th>
            <th className="py-2 text-right font-semibold text-gray-500">Status</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p, i) => (
            <tr key={i} className="border-b border-gray-100">
              <td className="py-1.5 text-gray-600">{new Date(p.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
              <td className="py-1.5 font-mono text-[10px]">{p.from}</td>
              <td className="py-1.5 text-gray-600">{p.order ?? '—'}</td>
              <td className="py-1.5 text-gray-600">{p.chain}</td>
              <td className="py-1.5 text-right tabular-nums font-medium">{p.amount}</td>
              <td className="py-1.5 text-right capitalize text-gray-600">{p.status}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Footer */}
      <div className="mt-8 pt-6 border-t border-gray-200 text-center text-[10px] text-gray-400">
        Generated by MeshPort · Powered by USDC on Arc
      </div>
    </div>
  )
}
