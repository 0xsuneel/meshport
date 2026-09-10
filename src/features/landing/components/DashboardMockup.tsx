import { motion } from 'framer-motion'
import { ArrowUpRight, ArrowDownLeft, Repeat, Users, TrendingUp } from 'lucide-react'

// Purely presentational recreations of MeshPort's own real UI — same brand
// tokens, same card language (rounded-20px, soft shadow, flat brand fills,
// no glow) as the actual app, not a generic stock dashboard illustration.
// Static, deterministic figures for layout only (not fetched data).

const assets = [
  { symbol: 'USDC', name: 'USD Coin', value: '2,481.50', change: '+2.4%', up: true },
  { symbol: 'EURC', name: 'Euro Coin', value: '640.10',  change: '+0.3%', up: true },
  { symbol: 'cirBTC', name: 'Circle BTC', value: '412.90', change: '-1.1%', up: false },
]

const activity = [
  { icon: ArrowUpRight, label: 'Paid to sarah.arc', amount: '-45.00', color: 'var(--danger)' },
  { icon: ArrowDownLeft, label: 'Received from raj.arc', amount: '+120.00', color: 'var(--success)' },
  { icon: Repeat, label: 'Swapped USDC → EURC', amount: '200.00', color: 'var(--text-primary)' },
]

function CardShell({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 20,
        boxShadow: '0 20px 60px -20px rgba(0,0,0,0.18)',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export function DesktopDashboardMockup() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.7, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
      style={{ width: '100%', maxWidth: 560 }}
    >
      <motion.div
        animate={{ y: [0, -8, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
      >
        <CardShell style={{ padding: 20 }}>
          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <img src="/favicon.svg" alt="" style={{ width: 28, height: 28, borderRadius: 8 }} />
              <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>MeshPort</span>
            </div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999,
              background: 'color-mix(in srgb, var(--success) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--success) 25%, transparent)',
              fontSize: 11, fontWeight: 600, color: 'var(--success)',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)' }} />
              Arc Network
            </div>
          </div>

          {/* Balance */}
          <div style={{ marginBottom: 18 }}>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>Total Balance</p>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 34, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>$3,534.50</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 12, fontWeight: 700, color: 'var(--success)' }}>
                <TrendingUp size={13} /> 4.8%
              </span>
            </div>
          </div>

          {/* Quick actions */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 18 }}>
            {[
              { icon: ArrowUpRight, label: 'Pay' },
              { icon: ArrowDownLeft, label: 'Receive' },
              { icon: Repeat, label: 'Swap' },
              { icon: Users, label: 'P2P' },
            ].map(a => (
              <div key={a.label} style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '10px 4px',
                borderRadius: 14, background: 'var(--bg)', border: '1px solid var(--border)',
              }}>
                <a.icon size={16} color="var(--brand)" />
                <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{a.label}</span>
              </div>
            ))}
          </div>

          {/* Assets */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
            {assets.map(a => (
              <div key={a.symbol} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderRadius: 12, background: 'var(--bg)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'color-mix(in srgb, var(--brand) 16%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: 'var(--brand)' }}>
                    {a.symbol.slice(0, 2)}
                  </div>
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{a.symbol}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>{a.name}</div>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>${a.value}</div>
                  <div style={{ fontSize: 10.5, fontWeight: 600, color: a.up ? 'var(--success)' : 'var(--danger)' }}>{a.change}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Recent activity */}
          <div>
            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 8 }}>Recent Activity</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {activity.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 22, height: 22, borderRadius: 8, background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <a.icon size={12} color={a.color} />
                  </div>
                  <span style={{ flex: 1, fontSize: 11.5, color: 'var(--text-primary)' }}>{a.label}</span>
                </div>
              ))}
            </div>
          </div>
        </CardShell>
      </motion.div>

      {/* Floating accent chip — swap confirmation, offset top-right */}
      <motion.div
        initial={{ opacity: 0, x: 12, y: -8 }}
        animate={{ opacity: 1, x: 0, y: [0, -6, 0] }}
        transition={{ opacity: { delay: 0.6, duration: 0.5 }, x: { delay: 0.6, duration: 0.5 }, y: { delay: 1.1, duration: 5, repeat: Infinity, ease: 'easeInOut' } }}
        style={{ position: 'relative', marginTop: -40, marginLeft: 'auto', width: 190, zIndex: 2 }}
      >
        <CardShell style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'color-mix(in srgb, var(--success) 15%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ArrowDownLeft size={15} color="var(--success)" />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>Payment received</div>
            <div style={{ fontSize: 11, color: 'var(--success)', fontWeight: 600 }}>+120.00 USDC</div>
          </div>
        </CardShell>
      </motion.div>
    </motion.div>
  )
}

export function MobileDashboardMockup() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      style={{ width: 240, flexShrink: 0 }}
    >
      <div style={{
        borderRadius: 32, border: '8px solid var(--surface)', background: 'var(--bg)',
        boxShadow: '0 24px 60px -20px rgba(0,0,0,0.25)', overflow: 'hidden',
      }}>
        <div style={{ padding: '18px 14px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <img src="/favicon.svg" alt="" style={{ width: 22, height: 22, borderRadius: 6 }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>MeshPort</span>
          </div>
          <p style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginBottom: 2 }}>Total Balance</p>
          <p style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 14, letterSpacing: '-0.4px' }}>$3,534.50</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 14 }}>
            {[ArrowUpRight, ArrowDownLeft, Repeat, Users].map((Icon, i) => (
              <div key={i} style={{ aspectRatio: '1', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon size={13} color="var(--brand)" />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {activity.slice(0, 3).map((a, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 10, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <a.icon size={11} color={a.color} />
                <span style={{ fontSize: 9.5, color: 'var(--text-primary)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.label}</span>
              </div>
            ))}
          </div>
        </div>
        {/* bottom nav bar */}
        <div style={{ display: 'flex', justifyContent: 'space-around', padding: '10px 8px', borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
          {[0, 1, 2, 3, 4].map(i => (
            <div key={i} style={{ width: 16, height: 16, borderRadius: 4, background: i === 0 ? 'var(--brand)' : 'var(--border)' }} />
          ))}
        </div>
      </div>
    </motion.div>
  )
}
