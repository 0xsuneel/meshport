/**
 * ExportButton — compact outline button with a Download icon.
 */
import React from 'react'
import { Download } from 'lucide-react'

export interface ExportButtonProps {
  onClick: () => void
  label?: string
}

export function ExportButton({ onClick, label = 'Export CSV' }: ExportButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="shrink-0 inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:border-text-muted hover:text-text-primary active:scale-95 transition min-h-[44px]"
    >
      <Download className="size-3.5" />
      {label}
    </button>
  )
}
