// A bill as a document (27 Nov): what "Save PDF" prints - the business, its
// address and tax ID, the bill number and dates, who it's for, the items,
// Subtotal / Discount / Tax / Total, the footer note and how to pay (the
// link and its QR). Printed on white (printArea), so its colours are fixed.
import { billLines, displayOrderNumber, type BillDetails, type MerchantIntent } from '@/lib/merchantPay'

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`
const day = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

export function BillDocument({ intent, details, business, taxId, link, qr, paid }: {
  intent: MerchantIntent
  details?: BillDetails | null
  business: string
  taxId?: string | null
  link: string
  qr?: string
  paid?: boolean
}) {
  const items = intent.items ?? []
  const d = details ?? intent.bill ?? null
  const lines = billLines(items, intent.amount, intent.taxPercent, d)
  const num = intent.orderNumber ? displayOrderNumber(intent.orderNumber) : ''
  const billTo = intent.customerUsername ? `${intent.customerUsername.replace(/\.arc$/i, '')}.arc` : intent.billToName ?? d?.billToName ?? null
  const muted = '#6b7280'
  const cell: React.CSSProperties = { padding: '8px 0', borderBottom: '1px solid #e5e7eb', fontSize: 13 }
  return (
    <div style={{ fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif', color: '#111827', padding: 36, maxWidth: 720, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{business}</div>
          {d?.storeAddress && <div style={{ fontSize: 12.5, color: muted, marginTop: 4 }}>{d.storeAddress}</div>}
          {taxId && <div style={{ fontSize: 12.5, color: muted, marginTop: 2 }}>Tax ID {taxId}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.5 }}>{paid ? 'RECEIPT' : 'BILL'} {num}</div>
          <div style={{ fontSize: 12.5, color: muted, marginTop: 4 }}>{day(intent.createdAt)}</div>
          {intent.dueDate && !paid && <div style={{ fontSize: 12.5, color: muted }}>Due {day(intent.dueDate)}</div>}
          {paid && intent.paidAt && <div style={{ fontSize: 12.5, color: '#047857', fontWeight: 700 }}>Paid {day(intent.paidAt)}</div>}
        </div>
      </div>

      {billTo && (
        <div style={{ marginTop: 22, fontSize: 13 }}>
          <div style={{ color: muted, fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6 }}>Bill to</div>
          <div style={{ fontWeight: 700, marginTop: 3 }}>{billTo}{intent.billToContact ? <span style={{ fontWeight: 400, color: muted }}> · {intent.billToContact}</span> : null}</div>
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 22 }}>
        <thead>
          <tr style={{ color: muted, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            <th style={{ ...cell, textAlign: 'left', fontSize: 11.5 }}>Item</th>
            <th style={{ ...cell, textAlign: 'right', fontSize: 11.5 }}>Qty</th>
            <th style={{ ...cell, textAlign: 'right', fontSize: 11.5 }}>Price</th>
            <th style={{ ...cell, textAlign: 'right', fontSize: 11.5 }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i, k) => (
            <tr key={k}>
              <td style={cell}>{i.name}</td>
              <td style={{ ...cell, textAlign: 'right' }}>{Number(i.qty)}</td>
              <td style={{ ...cell, textAlign: 'right' }}>{usd(Number(i.price))}</td>
              <td style={{ ...cell, textAlign: 'right', fontWeight: 600 }}>{usd(Number(i.total ?? i.qty * i.price))}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginLeft: 'auto', width: 280, marginTop: 12, fontSize: 13 }}>
        {lines.map((l, k) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0',
            ...(l.kind === 'total' ? { fontWeight: 800, fontSize: 16, borderTop: '2px solid #111827', marginTop: 6, paddingTop: 8 } : { color: l.kind === 'discount' ? '#047857' : muted }) }}>
            <span>{l.kind === 'total' ? 'Total (USDC)' : `${l.label}${l.note ? ` (${l.note})` : ''}`}</span>
            <span>{l.kind === 'discount' ? `−${usd(-l.amount)}` : usd(l.amount)}</span>
          </div>
        ))}
      </div>

      {intent.note && <div style={{ marginTop: 22, fontSize: 13 }}>{intent.note}</div>}
      {d?.footer && <div style={{ marginTop: 10, fontSize: 12.5, color: muted }}>{d.footer}</div>}

      {!paid && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 28, padding: 16, border: '1px solid #e5e7eb', borderRadius: 14 }}>
          {qr && <img src={qr} alt="" style={{ width: 110, height: 110 }} />}
          <div style={{ fontSize: 12.5 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Pay {usd(intent.amount)} in USDC</div>
            <div style={{ color: muted, marginTop: 4 }}>Scan the QR or open the link - any wallet, any network.</div>
            <div style={{ marginTop: 6, wordBreak: 'break-all' }}>{link}</div>
          </div>
        </div>
      )}
      <div style={{ marginTop: 26, fontSize: 11, color: muted, textAlign: 'center' }}>Made with MeshPort · meshport.xyz</div>
    </div>
  )
}
