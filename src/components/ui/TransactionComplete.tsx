/**
 * TransactionComplete — Unified success/fail screen used by:
 *   - PaySendPage (Pay on Arc)
 *   - SwapPage
 *   - MultichainTransferPage (Transfer)
 *   - MultichainClaimPage (Claim)
 *
 * All final screens share identical layout, sizing and visual language.
 */
import { CheckCircle, XCircle, ExternalLink, Copy, Check } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { copyToClipboard } from '@/lib/utils'
import { useUIStore } from '@/store'

export interface TxRow { label: string; value: string; color?: string }

interface Props {
  status: 'success' | 'failed'
  title: string
  subtitle: string
  rows: TxRow[]
  txHash?: string
  primaryLabel?: string       // button text
  primaryAction?: () => void  // if omitted, goes to /
  secondaryLabel?: string
  secondaryAction?: () => void
  /** Steps shown with green checkmarks (for CCTP bridging flow) */
  steps?: Array<{ label: string; done: boolean; active?: boolean; time?: string }>
}

export function TransactionComplete({
  status, title, subtitle, rows, txHash,
  primaryLabel = 'Done',
  primaryAction,
  secondaryLabel,
  secondaryAction,
  steps,
}: Props) {
  const navigate = useNavigate()
  const [copied, setCopied] = useState(false)
  const { showToastMessage } = useUIStore()

  const copyHash = async () => {
    if (!txHash) return
    const ok = await copyToClipboard(txHash)
    setCopied(true)
    showToastMessage(ok ? 'Transaction hash copied' : 'Could not copy hash', ok ? 'success' : 'error')
    setTimeout(() => setCopied(false), 1500)
  }

  const handlePrimary = () => {
    if (primaryAction) primaryAction()
    else navigate('/')
  }

  const statusColor = status === 'success' ? 'var(--success)' : 'var(--danger)'
  const StatusIcon = status === 'success' ? CheckCircle : XCircle

  // Sequential reveal — icon springs in first, then each block fades up in
  // turn, CTA buttons last. Respects prefers-reduced-motion via the global
  // CSS override in index.css (collapses every duration to ~0).
  const container = {
    hidden: {},
    show: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } },
  }
  const item = {
    hidden: { opacity: 0, y: 10 },
    show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: 'easeOut' } },
  }

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      style={{
        height: '100%', background: 'var(--bg)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'flex-start',
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 48px)',
        paddingLeft: 20, paddingRight: 20, paddingBottom: 40,
        boxSizing: 'border-box',
        overflowY: 'auto',
      }}>

      {/* ── Icon ── */}
      <motion.div
        variants={item}
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', damping: 14, stiffness: 220, delay: 0.05 }}
        style={{
          width: 80, height: 80, borderRadius: '50%', marginBottom: 20,
          background: `color-mix(in srgb, ${statusColor} 15%, transparent)`,
          border: `2px solid color-mix(in srgb, ${statusColor} 30%, transparent)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
        <StatusIcon size={42} color={statusColor} strokeWidth={2}/>
      </motion.div>

      {/* ── Title ── */}
      <motion.div variants={item} style={{ textAlign: 'center', marginBottom: 24, width: '100%' }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', margin: 0, letterSpacing: '-0.3px' }}>{title}</h2>
        {/* BUG FIX: a raw error message can be one long, space-free string
            (e.g. "0xaa3e079c0000...", a hex revert payload) that has no
            natural word boundaries — without wordBreak this overflowed
            straight past the edge of its box on both mobile and desktop
            instead of wrapping onto multiple lines. */}
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 6, wordBreak: 'break-word', overflowWrap: 'break-word' }}>{subtitle}</p>
      </motion.div>

      {/* ── Steps (optional — multichain bridging) ── */}
      {steps && steps.length > 0 && (
        <motion.div variants={item} style={{
          width: '100%', background: 'var(--surface)',
          borderRadius: 20, border: '1px solid var(--border)',
          padding: '14px 16px', marginBottom: 12,
        }}>
          {steps.map((s, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '8px 0',
              borderBottom: i < steps.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              <div style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: s.done ? 'var(--success)' : s.active ? 'var(--brand)' : 'color-mix(in srgb, var(--text-primary) 8%, transparent)',
              }}>
                {s.done
                  ? <Check size={13} color="#fff" strokeWidth={2.5}/>
                  : <span style={{ fontSize: 11, fontWeight: 700, color: s.active ? '#fff' : 'var(--text-secondary)' }}>{i + 1}</span>
                }
              </div>
              <span style={{ fontSize: 13, fontWeight: 500, color: (s.done || s.active) ? 'var(--text-primary)' : 'var(--text-secondary)', flex: 1 }}>
                {s.label}
              </span>
              {s.time && (
                <span style={{ fontSize: 11, color: 'var(--success)' }}>{s.time}</span>
              )}
            </div>
          ))}
        </motion.div>
      )}

      {/* ── Detail rows ── */}
      <motion.div variants={item} style={{
        width: '100%', background: 'var(--surface)',
        borderRadius: 20, border: '1px solid var(--border)',
        padding: '4px 0', marginBottom: 16,
      }}>
        {rows.map((row, i) => (
          <div key={i} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '12px 16px',
            borderTop: i > 0 ? '1px solid var(--border)' : 'none',
          }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{row.label}</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: row.color || 'var(--text-primary)' }}>{row.value}</span>
          </div>
        ))}

        {/* Tx Hash row */}
        {txHash && (
          <div style={{
            padding: '12px 16px',
            borderTop: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Tx Hash</span>
              <button onClick={copyHash} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              }}>
                {copied
                  ? <Check size={14} color="var(--success)"/>
                  : <Copy size={14} color="var(--text-secondary)"/>
                }
              </button>
            </div>
            <p style={{
              fontSize: 11, fontFamily: 'monospace', color: 'var(--text-primary)',
              wordBreak: 'break-all', margin: 0, lineHeight: 1.5,
            }}>{txHash}</p>
          </div>
        )}
      </motion.div>

      {/* ── ArcScan link ── */}
      {txHash && (
        <motion.a
          variants={item}
          href={`https://testnet.arcscan.app/tx/${txHash}`}
          target="_blank" rel="noreferrer"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 14, color: 'var(--link)', fontWeight: 500,
            textDecoration: 'none', marginBottom: 24,
          }}>
          <ExternalLink size={15}/>
          View on ArcScan
        </motion.a>
      )}

      {/* ── Buttons — CTA appears last ── */}
      <motion.div variants={item} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, marginTop: txHash ? 0 : 8 }}>
        <motion.button
          onClick={handlePrimary}
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.98 }}
          style={{
            width: '100%', padding: '15px 0', borderRadius: 16,
            fontSize: 15, fontWeight: 600, color: '#fff',
            background: 'var(--brand)', border: 'none', cursor: 'pointer',
            boxShadow: 'var(--shadow-2)',
            fontFamily: '-apple-system,sans-serif',
          }}>
          {primaryLabel}
        </motion.button>
        {secondaryLabel && secondaryAction && (
          <motion.button
            onClick={secondaryAction}
            whileTap={{ scale: 0.98 }}
            style={{
              width: '100%', padding: '14px 0', borderRadius: 16,
              fontSize: 14, fontWeight: 500, color: 'var(--text-secondary)',
              background: 'var(--surface)', border: '1px solid var(--border)',
              cursor: 'pointer', fontFamily: '-apple-system,sans-serif',
            }}>
            {secondaryLabel}
          </motion.button>
        )}
      </motion.div>
    </motion.div>
  )
}
