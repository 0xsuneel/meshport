/**
 * TrackDetails.tsx — collapsible "View details" panel under Track Progress
 * (CCTP and Unified Balance claims). Collapsed by default so the screen
 * stays the same compact size as the tracker; tapping "View details"
 * slides the rows open.
 */
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Copy, Check } from 'lucide-react'
import { copyToClipboard } from '@/lib/utils'

export type TrackDetailRow = { label: string; value: string; copy?: string; href?: string | null }

export function TrackDetails({ rows }: { rows: TrackDetailRow[] }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  return (
    <div style={{ background: 'color-mix(in srgb, var(--text-primary) 3%, transparent)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden' }}>
      <button onClick={() => setOpen(v => !v)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '12px 0', background: 'none', border: 'none', cursor: 'pointer' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{open ? 'Hide details' : 'View details'}</span>
        <ChevronDown style={{ width: 16, height: 16, color: 'var(--text-secondary)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }} style={{ overflow: 'hidden' }}>
            <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px 14px', display: 'flex', flexDirection: 'column', gap: 11 }}>
              {rows.map(r => (
                <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', flexShrink: 0 }}>{r.label}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    {r.href ? (
                      <a href={r.href} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 13, fontWeight: 600, color: 'var(--brand)', textDecoration: 'none', fontFamily: r.copy ? 'monospace' : undefined, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {r.value}
                      </a>
                    ) : (
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: r.copy ? 'monospace' : undefined, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.value}</span>
                    )}
                    {r.copy && (
                      <button onClick={() => { copyToClipboard(r.copy!); setCopied(r.label); setTimeout(() => setCopied(c => (c === r.label ? null : c)), 1500) }}
                        style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: copied === r.label ? 'var(--success)' : 'var(--text-secondary)', display: 'flex' }}>
                        {copied === r.label ? <Check style={{ width: 14, height: 14 }} /> : <Copy style={{ width: 14, height: 14 }} />}
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
