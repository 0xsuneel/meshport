// Admin Panel → P2P Trades → Instructions: who can do what in the P2P
// escrow, and the steps for each situation. The rules mirror
// contracts/P2PMeshportEscrowV3.sol (onlyPauser / onlyInvestigator /
// onlyAdmin / the 2-of-3 role-manager multisig, SELLER_RELEASE_TIMEOUT,
// whenNotPaused) and the app-level actions in P2PAdminPage.
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { AdminCard } from '@/components/admin/AdminCard'
import { Pill } from '@/components/admin/AdminUi'
import { ADMIN_PATH } from '@/lib/adminPath'

const ROLES: Array<{ who: string; how: string; money: boolean; can: string[] }> = [
  { who: 'Your admin login', how: 'No wallet needed', money: false,
    can: ['Turn the P2P marketplace on or off', 'Cancel a trade before the buyer pays (after that: freeze or dispute first)', 'Cancel an offer with no escrow left', 'Ban a user from P2P', 'Message both sides during a dispute'] },
  { who: 'Pauser wallet', how: 'Connected on P2P Trades', money: false,
    can: ['Emergency pause / resume the whole escrow', 'Freeze / unfreeze a trade (unfreeze only before it’s investigated)', 'Freeze / unfreeze a sell offer', 'Force-freeze a paid trade the seller left for 24h+'] },
  { who: 'Investigator wallet', how: 'A different wallet from whoever froze the trade', money: false,
    can: ['Decide a frozen trade: release to the buyer, or refund the seller'] },
  { who: 'Admin wallet', how: 'Different from the freezer and the investigator', money: true,
    can: ['Carry out the investigator’s decision - this is the step that moves the USDC'] },
  { who: 'Role managers', how: '3 fixed signers - 2 must agree, then a 2-hour wait', money: false,
    can: ['Add or remove Pausers and Investigators', 'Hand over the Admin role'] },
]

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <AdminCard padding={16} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>{title}</h2>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{children}</div>
    </AdminCard>
  )
}

const Steps = ({ items }: { items: ReactNode[] }) => (
  <ol style={{ margin: 0, paddingLeft: 20, listStyle: 'decimal', display: 'flex', flexDirection: 'column', gap: 4 }}>
    {items.map((s, i) => <li key={i}>{s}</li>)}
  </ol>
)

export function P2PGuidePage() {
  const navigate = useNavigate()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <button onClick={() => navigate(`${ADMIN_PATH}/p2p`)}
        style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
        <ArrowLeft size={14} /> Back to P2P Trades
      </button>

      <Section title="Who can do what">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {ROLES.map(r => (
            <div key={r.who} style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{r.who}</span>
                <Pill color={r.money ? 'var(--warning-text)' : 'var(--text-secondary)'}>{r.money ? 'Moves the USDC' : 'Never moves USDC'}</Pill>
              </div>
              <div style={{ fontSize: 12, marginTop: 2 }}>{r.how}</div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, listStyle: 'disc' }}>{r.can.map(c => <li key={c}>{c}</li>)}</ul>
            </div>
          ))}
          <div style={{ fontSize: 12 }}>
            Every on-chain step is signed by a browser wallet that holds the role - never by this admin login. Pauser and Investigator can never be the same wallet, so no single person can freeze, decide and pay out a trade alone.
          </div>
        </div>
      </Section>

      <Section title="Two ways to stop P2P">
        <b style={{ color: 'var(--text-primary)' }}>Marketplace switch</b> (admin login) - the soft stop, for maintenance. P2P disappears for users: no new offers or trades. Trades already running can still finish. Nothing changes on-chain.
        <br /><br />
        <b style={{ color: 'var(--text-primary)' }}>Emergency pause</b> (Pauser wallet) - the hard stop, for an incident such as a suspected exploit. The escrow contract refuses deposits, marking paid, releases, cancels and withdrawals for everyone, trades in progress included. Freezing, investigating and admin resolution still work, so disputes can be handled while paused. Resume with the same Pauser wallet.
      </Section>

      <Section title="Handling a dispute">
        <Steps items={[
          <>Open the trade on P2P Trades → <b>Dispute</b>. Read the chat and any payment proof; message both sides if you need more.</>,
          <><b>Pauser</b> freezes the trade, with a reason. Nothing can be released or cancelled while it’s frozen.</>,
          <><b>Investigator</b> (a different wallet) records the decision: release to the buyer, or refund the seller - with a reason.</>,
          <><b>Admin</b> (different from both) carries it out. This is the only step that moves the USDC.</>,
        ]} />
        <div style={{ marginTop: 6 }}>After each step the connected wallet is disconnected, so the next person connects their own.</div>
      </Section>

      <Section title="Buyer paid, seller went silent">
        If a buyer marked a trade paid more than 24 hours ago and the seller hasn’t released, the trade card says so. A Pauser can force-freeze it, which starts the dispute steps above - the buyer is never stuck waiting forever.
      </Section>

      <Section title="Cancelling">
        <Steps items={[
          <><b>Before the buyer pays</b>: Cancel trade (admin login). The escrowed USDC goes back to the seller’s offer.</>,
          <><b>After the buyer says they paid</b>: cancelling could cost them money, so freeze it or open a dispute first.</>,
          <><b>An offer</b>: Cancel offer works only when no escrow is left in it - only the seller’s own wallet can withdraw escrow. To stop new trades on a suspicious sell offer, freeze it instead (Pauser).</>,
        ]} />
      </Section>

      <Section title="Banning">
        Ban buyer / Ban seller (admin login) blocks that person from P2P with your reason. It doesn’t touch trades already running - freeze those if needed.
      </Section>

      <Section title="Changing who holds a role">
        Only the three role-manager signers can add or remove Pausers and Investigators or hand over Admin. One proposes, a second confirms, then there’s a 2-hour wait before it can be carried out. Use the Role Managers panel on P2P Trades. Admin can’t change roles alone.
      </Section>

      <Section title="Connecting a wallet">
        Use a browser wallet such as MetaMask on a computer. On a phone, open this admin page inside the wallet app’s own browser. The card on P2P Trades shows which roles the connected wallet holds; a button that needs a role you don’t have will fail, so check the tag on each button (Pauser, Admin login…).
      </Section>
    </div>
  )
}
