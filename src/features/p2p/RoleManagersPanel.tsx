// features/p2p/RoleManagersPanel.tsx
//
// The "Role Managers" section of the P2P admin console — the UI for the
// 2-of-3 role-manager multisig on P2PMeshportEscrowV2.sol.
//
// ── Key handling ──────────────────────────────────────────────────────────
// SECURITY FIX: this used to ask each role manager signer to paste their
// private key directly into a browser input field. That was flagged and
// removed — the fix isn't a safer way to handle a pasted key, it's not
// asking for one at all. Every action here goes through the browser's
// injected wallet extension (MetaMask or any EIP-1193 provider): the
// signer connects their own wallet, reviews the transaction inside their
// OWN extension, and approves it there. The private key never enters this
// page's JavaScript, is never held in any React state, and is never
// transmitted anywhere by this app — there is nothing here for
// localStorage/sessionStorage/Supabase/an API request/a log line to leak,
// because this code never possesses the key in the first place. See
// connectInjectedWallet()/sendContractTxViaInjectedWallet() in
// p2pEscrowContract.ts for the implementation.

import { useState, useEffect, useCallback } from 'react'
import { Shield, CheckCircle2, XCircle, Wallet, Users, RefreshCw, AlertTriangle, LogOut } from 'lucide-react'
import { useUIStore } from '@/store'
import { AddressChip } from './AddressChip'
import { ARC } from '@/blockchain/chains'

// Friendlier labels + a semantic color per raw event name — the contract
// emits precise Solidity-style names (PauserAdded, RoleProposalApproved,
// etc.); this is purely a display layer, the underlying event/args are
// unchanged and still shown in full below.
const EVENT_META: Record<string, { label: string; color: keyof typeof COLORS }> = {
  PauserAdded: { label: 'Pauser Added', color: 'success' },
  PauserRemoved: { label: 'Pauser Removed', color: 'error' },
  InvestigatorAdded: { label: 'Investigator Added', color: 'success' },
  InvestigatorRemoved: { label: 'Investigator Removed', color: 'error' },
  AdminTransferInitiated: { label: 'Admin Transfer Proposed', color: 'warning' },
  AdminTransferred: { label: 'Admin Transferred', color: 'primary' },
  SignerRotated: { label: 'Signer Rotated', color: 'primary' },
  RoleProposalCreated: { label: 'Proposal Created', color: 'muted' },
  RoleProposalConfirmed: { label: 'Proposal Confirmed', color: 'muted' },
  RoleProposalApproved: { label: 'Timelock Started (2-of-3 reached)', color: 'warning' },
  RoleProposalCancelled: { label: 'Proposal Cancelled', color: 'error' },
  RoleProposalExecuted: { label: 'Proposal Executed', color: 'success' },
}

function isAddressLike(v: unknown): v is string {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)
}
import {
  proposeRoleChangeViaWallet, confirmRoleChangeViaWallet, cancelRoleProposalViaWallet, proposeSignerRotationViaWallet,
  proposeAdminRotationViaWallet, proposeCancelPendingAdminViaWallet, acceptAdminViaWallet, executeRoleProposalViaWallet,
  getRoleProposalOnChain, getRoleProposalCount, checkIsRoleManagerSigner, getRoleManagerSigners,
  getEscrowAdminAddress, getPendingAdmin, getRecentGovernanceEvents,
  connectInjectedWallet, getConnectedInjectedWalletAddress, hasInjectedWallet, disconnectInjectedWallet,
  getCurrentRoleHolders, getAddressRoles,
  type RoleAction, type OnChainRoleProposal, type GovernanceEvent, type RoleHolders, type AddressRoles,
} from '@/lib/p2pEscrowContract'


const COLORS = {
  bg: 'var(--bg)', surface: 'var(--surface)',
  primary: 'var(--brand)', success: 'var(--success)', error: 'var(--danger)', warning: 'var(--warning)',
  text: 'var(--text-primary)', muted: 'var(--text-secondary)', border: 'var(--border)',
}

const ROLE_ACTIONS: { value: RoleAction; label: string; needsTarget: boolean }[] = [
  { value: 'AddPauser', label: 'Add Pauser', needsTarget: true },
  { value: 'RemovePauser', label: 'Remove Pauser', needsTarget: true },
  { value: 'AddInvestigator', label: 'Add Investigator', needsTarget: true },
  { value: 'RemoveInvestigator', label: 'Remove Investigator', needsTarget: true },
  { value: 'TransferAdmin', label: 'Transfer Admin', needsTarget: true },
  { value: 'CancelAdminTransfer', label: 'Cancel Pending Admin Transfer', needsTarget: false },
]

function shortAddr(a: string) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''
}

export function RoleManagersPanel() {
  const { showToastMessage } = useUIStore()
  const [signerAddresses, setSignerAddresses] = useState<string[]>([])
  const [loadingSigners, setLoadingSigners] = useState(true)

  const [proposals, setProposals] = useState<Array<{ id: bigint } & OnChainRoleProposal>>([])
  const [loadingProposals, setLoadingProposals] = useState(true)

  const [connectedWallet, setConnectedWallet] = useState<string | null>(null)
  const [connectedWalletRoles, setConnectedWalletRoles] = useState<AddressRoles | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)

  // ── Current Pauser(s) / Investigator(s) ──────────────────────────────
  // Derived live from on-chain events + on-chain role checks — see
  // getCurrentRoleHolders(). There's no on-chain array to read directly,
  // so this is the only accurate way to answer "who holds these roles
  // right now" without trusting a database record.
  const [roleHolders, setRoleHolders] = useState<RoleHolders>({ pausers: [], investigators: [] })
  const [loadingRoleHolders, setLoadingRoleHolders] = useState(true)
  // Live-ish clock for rendering "execution available in Xh Ym" countdowns.
  // Purely a UI display aid — every actual execute attempt is checked
  // on-chain regardless of what this shows; see executeRoleProposalViaWallet.
  const [nowMs, setNowMs] = useState(Date.now())
  const [connecting, setConnecting] = useState(false)

  const [action, setAction] = useState<RoleAction>('AddPauser')
  const [target, setTarget] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Admin, Pauser, Investigator, and Role Manager Signer are mutually
  // exclusive ON-CHAIN now (see P2PMeshportEscrowV2.sol's role-hierarchy
  // note) — a proposal granting any one of them to an address that
  // already holds another is guaranteed to revert at executeRoleProposal,
  // AFTER the 2-of-3 confirmations and the full 2-hour timelock have
  // already been spent. This client-side check catches that BEFORE a
  // signature is even requested, so it's a hard block, not a dismissible
  // warning — there is no "propose anyway" that could actually succeed.
  const [overlapWarning, setOverlapWarning] = useState<string | null>(null)

  // Any edit to the action or target invalidates whatever overlap check was showing.
  useEffect(() => { setOverlapWarning(null) }, [action, target])

  // ── Rotation form ────────────────────────────────────────────────────
  const [rotateIndex, setRotateIndex] = useState(0)
  const [rotateTarget, setRotateTarget] = useState('')
  const [rotating, setRotating] = useState(false)

  // ── Admin rotation (compromise recovery) ─────────────────────────────
  const [currentAdmin, setCurrentAdmin] = useState<string | null>(null)
  const [pendingAdminAddr, setPendingAdminAddr] = useState<string | null>(null)
  const [loadingAdmin, setLoadingAdmin] = useState(true)
  const [newAdminInput, setNewAdminInput] = useState('')
  const [proposingAdmin, setProposingAdmin] = useState(false)
  const [acceptingAdmin, setAcceptingAdmin] = useState(false)

  const loadAdminState = useCallback(async () => {
    setLoadingAdmin(true)
    const [a, p] = await Promise.all([getEscrowAdminAddress(), getPendingAdmin()])
    setCurrentAdmin(a)
    setPendingAdminAddr(p && p !== '0x0000000000000000000000000000000000000000' ? p : null)
    setLoadingAdmin(false)
  }, [])

  // ── Security notifications — derived from on-chain events only ────────
  const [events, setEvents] = useState<GovernanceEvent[]>([])
  const [loadingEvents, setLoadingEvents] = useState(true)
  const loadEvents = useCallback(async () => {
    setLoadingEvents(true)
    setEvents(await getRecentGovernanceEvents())
    setLoadingEvents(false)
  }, [])

  const loadSigners = useCallback(async () => {
    setLoadingSigners(true)
    setSignerAddresses(await getRoleManagerSigners())
    setLoadingSigners(false)
  }, [])

  const loadRoleHolders = useCallback(async () => {
    setLoadingRoleHolders(true)
    setRoleHolders(await getCurrentRoleHolders())
    setLoadingRoleHolders(false)
  }, [])

  const refreshConnectedWalletRoles = useCallback(async (addr: string | null) => {
    if (!addr) { setConnectedWalletRoles(null); return }
    setConnectedWalletRoles(await getAddressRoles(addr))
  }, [])

  const loadProposals = useCallback(async () => {
    setLoadingProposals(true)
    const count = await getRoleProposalCount()
    const ids = []
    for (let i = Math.max(0, count - 10); i < count; i++) ids.push(BigInt(i))
    const rows = await Promise.all(ids.map(async id => {
      const p = await getRoleProposalOnChain(id)
      return p ? { id, ...p } : null
    }))
    setProposals(rows.filter((r): r is { id: bigint } & OnChainRoleProposal => r !== null).reverse())
    setLoadingProposals(false)
  }, [])

  useEffect(() => {
    loadSigners(); loadProposals(); loadAdminState(); loadEvents(); loadRoleHolders()
    getConnectedInjectedWalletAddress().then(addr => { setConnectedWallet(addr); refreshConnectedWalletRoles(addr) })
  }, [loadSigners, loadProposals, loadAdminState, loadEvents, loadRoleHolders, refreshConnectedWalletRoles])

  // Ticks the countdown display every 30s — display-only, never consulted
  // for any actual authorization decision (the contract's own
  // isRoleProposalExecutable / executeRoleProposal are the real checks).
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])

  const isConnectedWalletASigner = connectedWallet ? signerAddresses.some(s => s.toLowerCase() === connectedWallet.toLowerCase()) : false

  // GAP FIX: the proposal list only ever showed a raw "X/2 approvals"
  // count — no signer could tell from the UI alone whether THEY were one
  // of the ones who'd already confirmed, short of clicking Confirm and
  // either succeeding or getting a revert ("already confirmed by this
  // signer"). The contract already emits a RoleProposalConfirmed(
  // proposalId, signer, confirmations) event for every confirmation
  // (including the proposer's own, since proposing counts as the first
  // one) — reuse the SAME events feed already fetched for Security
  // Notifications rather than adding a second RPC round-trip per proposal.
  const confirmedByForProposal = useCallback((proposalId: bigint): string[] => {
    const seen = new Set<string>()
    for (const e of events) {
      if (e.name !== 'RoleProposalConfirmed') continue
      const pid = e.args?.proposalId as string | number | bigint | undefined
      if (pid === undefined || BigInt(pid) !== proposalId) continue
      const signer = e.args?.signer as string | undefined
      if (signer) seen.add(signer.toLowerCase())
    }
    return [...seen]
  }, [events])

  const handleConnect = async () => {
    if (!hasInjectedWallet()) {
      showToastMessage('No browser wallet extension detected. Install MetaMask (or similar) to act as a role manager signer.', 'error')
      return
    }
    setConnecting(true)
    const addr = await connectInjectedWallet()
    setConnecting(false)
    if (!addr) { showToastMessage('Wallet connection was rejected or failed.', 'error'); return }
    setConnectedWallet(addr)
    await refreshConnectedWalletRoles(addr)
    const isSigner = await checkIsRoleManagerSigner(addr)
    if (!isSigner) showToastMessage(`Connected to ${shortAddr(addr)}, but this address is not one of the 3 role manager signers.`, 'warning')
  }

  const handleDisconnect = async () => {
    setDisconnecting(true)
    try {
      await disconnectInjectedWallet()
    } finally {
      // Always forget the address on this app's side, even if the wallet
      // extension itself doesn't support a real revoke — see
      // disconnectInjectedWallet()'s own comment on why this half is the
      // part that's actually guaranteed.
      setConnectedWallet(null)
      setConnectedWalletRoles(null)
      setDisconnecting(false)
      showToastMessage('Wallet disconnected from this page. If your extension supports it, its own permission was revoked too — otherwise switch/lock accounts there to fully disconnect.', 'success')
    }
  }

  const describeOverlap = async (proposedAction: RoleAction, targetAddr: string): Promise<string | null> => {
    if (proposedAction !== 'AddPauser' && proposedAction !== 'AddInvestigator' && proposedAction !== 'TransferAdmin') return null
    const roles = await getAddressRoles(targetAddr)
    // Admin, Pauser, Investigator, and Role Manager Signer are mutually
    // exclusive — this address must hold NONE of the other three
    // categories before this specific grant. (isAdmin/isRoleManagerSigner
    // are always dangerous; for AddPauser the other tier is Investigator,
    // for AddInvestigator it's Pauser, for TransferAdmin it's both.)
    const dangerous: string[] = []
    if (roles.isAdmin) dangerous.push('Admin')
    if (roles.isRoleManagerSigner) dangerous.push('a Role Manager Signer')
    if (proposedAction !== 'AddPauser' && roles.isPauser) dangerous.push('Pauser')
    if (proposedAction !== 'AddInvestigator' && roles.isInvestigator) dangerous.push('Investigator')
    if (dangerous.length === 0) return null
    return `${shortAddr(targetAddr)} is already ${dangerous.join(' and ')}. This proposal would revert on-chain at execution — Admin, Pauser, Investigator, and Role Manager Signer are mutually exclusive; no address may ever hold more than one.`
  }

  const handlePropose = async () => {
    if (!connectedWallet) return
    const needsTarget = ROLE_ACTIONS.find(a => a.value === action)?.needsTarget
    if (needsTarget && !/^0x[0-9a-fA-F]{40}$/.test(target.trim())) {
      showToastMessage('Enter a valid target address.', 'error'); return
    }
    if (needsTarget) {
      const warning = await describeOverlap(action, target.trim())
      if (warning) { setOverlapWarning(warning); return }
    }
    setOverlapWarning(null)
    setSubmitting(true)
    try {
      const targetAddr = (needsTarget ? target.trim() : '0x0000000000000000000000000000000000000000') as `0x${string}`
      await proposeRoleChangeViaWallet(action, targetAddr)
      showToastMessage('Proposed and signed — 1 of 2 confirmations. A DIFFERENT role manager signer must connect their own wallet to confirm.', 'success')
      setTarget('')
      await Promise.all([loadProposals(), loadEvents()])
    } catch (e: any) {
      showToastMessage(e?.shortMessage || e?.message || 'Could not submit the proposal.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleConfirm = async (proposalId: bigint) => {
    if (!connectedWallet) { showToastMessage('Connect your wallet first.', 'error'); return }
    setSubmitting(true)
    try {
      await confirmRoleChangeViaWallet(proposalId)
      showToastMessage('Confirmed — if this reached 2-of-3, a 2-hour timelock has now started. It will need a separate Execute step once that elapses.', 'success')
      await Promise.all([loadProposals(), loadSigners(), loadAdminState(), loadEvents(), loadRoleHolders(), refreshConnectedWalletRoles(connectedWallet)])
    } catch (e: any) {
      showToastMessage(e?.shortMessage || e?.message || 'Could not confirm — make sure you\'re a different signer from whoever proposed this.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleExecute = async (proposalId: bigint) => {
    if (!connectedWallet) { showToastMessage('Connect your wallet first.', 'error'); return }
    setSubmitting(true)
    try {
      await executeRoleProposalViaWallet(proposalId)
      showToastMessage('Executed — the role/governance change is now live.', 'success')
      await Promise.all([loadProposals(), loadSigners(), loadAdminState(), loadEvents(), loadRoleHolders(), refreshConnectedWalletRoles(connectedWallet)])
    } catch (e: any) {
      showToastMessage(e?.shortMessage || e?.message || 'Could not execute — the 2-hour timelock may not have elapsed yet.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = async (proposalId: bigint) => {
    if (!connectedWallet) { showToastMessage('Connect your wallet first.', 'error'); return }
    setSubmitting(true)
    try {
      await cancelRoleProposalViaWallet(proposalId)
      showToastMessage('Proposal cancelled.', 'success')
      await Promise.all([loadProposals(), loadEvents()])
    } catch (e: any) {
      showToastMessage(e?.shortMessage || e?.message || 'Could not cancel.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRotate = async () => {
    if (!connectedWallet) return
    if (!/^0x[0-9a-fA-F]{40}$/.test(rotateTarget.trim())) {
      showToastMessage('Enter a valid new signer address.', 'error'); return
    }
    setRotating(true)
    try {
      await proposeSignerRotationViaWallet(rotateIndex, rotateTarget.trim() as `0x${string}`)
      showToastMessage(`Rotation proposed for slot ${rotateIndex + 1} — 1 of 2 confirmations needed from a DIFFERENT signer.`, 'success')
      setRotateTarget('')
      await Promise.all([loadProposals(), loadEvents()])
    } catch (e: any) {
      showToastMessage(e?.shortMessage || e?.message || 'Could not propose rotation.', 'error')
    } finally {
      setRotating(false)
    }
  }

  // ── Admin rotation (compromise recovery) ─────────────────────────────
  // The current Admin has NO ability to block, veto, or delay any of
  // these three actions — proposeRoleChange/confirmRoleChange/
  // cancelRoleProposal are gated by onlyRoleManagerSigner ONLY, never
  // onlyAdmin. This is what makes recovery from a compromised Admin
  // actually work: 2 of the 3 role manager signers are enough, and the
  // (possibly compromised) current Admin's cooperation is never required
  // or even consulted.
  const handleProposeAdminRotation = async () => {
    if (!connectedWallet) return
    if (!/^0x[0-9a-fA-F]{40}$/.test(newAdminInput.trim())) {
      showToastMessage('Enter a valid new admin address.', 'error'); return
    }
    setProposingAdmin(true)
    try {
      const roles = await getAddressRoles(newAdminInput.trim())
      if (roles.isPauser || roles.isInvestigator || roles.isRoleManagerSigner) {
        showToastMessage('That address already holds a Pauser, Investigator, or Role Manager Signer role — Admin must be a genuinely separate address. This proposal would revert on-chain at execution.', 'error')
        setProposingAdmin(false)
        return
      }
      await proposeAdminRotationViaWallet(newAdminInput.trim() as `0x${string}`)
      showToastMessage('Admin replacement proposed — 1 of 2 confirmations needed from a DIFFERENT signer. The current Admin cannot block this.', 'success')
      setNewAdminInput('')
      await Promise.all([loadProposals(), loadAdminState(), loadEvents()])
    } catch (e: any) {
      showToastMessage(e?.shortMessage || e?.message || 'Could not propose admin replacement.', 'error')
    } finally {
      setProposingAdmin(false)
    }
  }

  const handleCancelPendingAdmin = async () => {
    if (!connectedWallet) return
    setProposingAdmin(true)
    try {
      await proposeCancelPendingAdminViaWallet()
      showToastMessage('Cancellation of the pending admin nomination proposed — needs a 2nd confirmation from a different signer.', 'success')
      await Promise.all([loadProposals(), loadAdminState(), loadEvents()])
    } catch (e: any) {
      showToastMessage(e?.shortMessage || e?.message || 'Could not propose cancellation.', 'error')
    } finally {
      setProposingAdmin(false)
    }
  }

  const handleAcceptAdmin = async () => {
    if (!connectedWallet) return
    setAcceptingAdmin(true)
    try {
      await acceptAdminViaWallet()
      showToastMessage('You are now Admin.', 'success')
      await Promise.all([loadAdminState(), refreshConnectedWalletRoles(connectedWallet)])
    } catch (e: any) {
      showToastMessage(e?.shortMessage || e?.message || 'Could not accept — you may no longer be the pending admin, or you now hold a Pauser/Investigator role.', 'error')
    } finally {
      setAcceptingAdmin(false)
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Shield size={18} color={COLORS.primary} />
        <h2 style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, margin: 0 }}>Role Managers</h2>
      </div>
      <p style={{ fontSize: 12.5, color: COLORS.muted, marginBottom: 16, lineHeight: 1.5 }}>
        2-of-3 multisig, signed through your own wallet extension — no private key ever entered into this page.
        Every Pauser/Investigator/Admin change, and any rotation of the 3 signers themselves, needs two of these
        three signers to confirm.
      </p>

      {/* ── Wallet connection ────────────────────────────────────────────── */}
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: 14, marginBottom: 16 }}>
        {connectedWallet ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <Wallet size={14} color={COLORS.success} style={{ flexShrink: 0 }} />
                <AddressChip address={connectedWallet} size={13} />
              </div>
              <button onClick={handleDisconnect} disabled={disconnecting}
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: COLORS.muted, background: 'transparent', border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '5px 10px', cursor: 'pointer', opacity: disconnecting ? 0.6 : 1 }}>
                <LogOut size={12} /> {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
            <div style={{ fontSize: 11.5, marginTop: 4, color: isConnectedWalletASigner ? COLORS.success : COLORS.warning }}>
              {isConnectedWalletASigner ? '✓ This is a role manager signer' : 'Not a role manager signer — connect the right wallet to act'}
            </div>
            {/* ── Which privileged roles this address holds, checked live on-chain ── */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {connectedWalletRoles === null ? (
                <span style={{ fontSize: 11, color: COLORS.muted }}>Checking roles…</span>
              ) : (() => {
                const badges: { label: string; on: boolean }[] = [
                  { label: 'Admin', on: connectedWalletRoles.isAdmin },
                  { label: 'Pending Admin', on: connectedWalletRoles.isPendingAdmin },
                  { label: 'Role Manager Signer', on: connectedWalletRoles.isRoleManagerSigner },
                  { label: 'Pauser', on: connectedWalletRoles.isPauser },
                  { label: 'Investigator', on: connectedWalletRoles.isInvestigator },
                ]
                const active = badges.filter(b => b.on)
                if (active.length === 0) {
                  return <span style={{ fontSize: 11, color: COLORS.muted }}>This address holds no privileged role on this contract.</span>
                }
                return active.map(b => (
                  <span key={b.label} style={{
                    fontSize: 10.5, fontWeight: 700, color: COLORS.primary,
                    background: 'color-mix(in srgb, var(--brand) 12%, transparent)',
                    border: `1px solid color-mix(in srgb, var(--brand) 35%, transparent)`,
                    borderRadius: 999, padding: '3px 9px',
                  }}>
                    {b.label}
                  </span>
                ))
              })()}
            </div>
          </div>
        ) : (
          <button onClick={handleConnect} disabled={connecting}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '11px 0', borderRadius: 12, border: 'none', background: COLORS.primary, color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', opacity: connecting ? 0.7 : 1 }}>
            <Wallet size={16} /> {connecting ? 'Connecting…' : 'Connect Wallet'}
          </button>
        )}
      </div>

      {/* ── The 3 fixed signers ─────────────────────────────────────────── */}
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: 14, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <Users size={14} color={COLORS.muted} />
          <span style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.3 }}>Current signers</span>
        </div>
        {loadingSigners ? (
          <span style={{ fontSize: 13, color: COLORS.muted }}>Loading…</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {signerAddresses.map((addr, i) => (
              <div key={addr} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ flexShrink: 0, width: 18, height: 18, borderRadius: 9, background: 'color-mix(in srgb, var(--brand) 15%, transparent)', color: COLORS.primary, fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
                <AddressChip address={addr} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Current Pauser(s) / Investigator(s) ──────────────────────────── */}
      {/* There is no on-chain array for these roles (see getCurrentRoleHolders'
          own comment) — this list is derived from every PauserAdded/
          PauserRemoved/InvestigatorAdded/InvestigatorRemoved event this
          contract has ever emitted, then double-checked against the live
          isPauser()/isInvestigator() mappings, so it always reflects
          current on-chain reality rather than event ordering alone. */}
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: 14, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <Shield size={14} color={COLORS.muted} />
          <span style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.3 }}>Current Pausers &amp; Investigators</span>
        </div>
        {loadingRoleHolders ? (
          <span style={{ fontSize: 13, color: COLORS.muted }}>Loading…</span>
        ) : (
          <>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 4 }}>Pauser(s)</div>
              {roleHolders.pausers.length === 0 ? (
                <span style={{ fontSize: 13, color: COLORS.muted }}>None currently set.</span>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {roleHolders.pausers.map(addr => (
                    <AddressChip key={addr} address={addr} size={13} />
                  ))}
                </div>
              )}
            </div>
            <div>
              <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 4 }}>Investigator(s)</div>
              {roleHolders.investigators.length === 0 ? (
                <span style={{ fontSize: 13, color: COLORS.muted }}>None currently set.</span>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {roleHolders.investigators.map(addr => (
                    <AddressChip key={addr} address={addr} size={13} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Admin Rotation (compromise recovery) ─────────────────────────── */}
      <div style={{ background: COLORS.surface, border: `1px solid color-mix(in srgb, var(--warning) 40%, transparent)`, borderRadius: 14, padding: 14, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <AlertTriangle size={14} color={COLORS.warning} />
          <span style={{ fontSize: 13.5, fontWeight: 700, color: COLORS.text }}>Admin Rotation — Compromise Recovery</span>
        </div>
        <p style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 10, lineHeight: 1.4 }}>
          If the Admin wallet is compromised, 2 of these 3 role manager signers can replace it — the current
          Admin has no way to block, veto, or delay this. The new address must NOT already hold Pauser,
          Investigator, or Role Manager Signer status — Admin must be a genuinely separate address.
          <strong style={{ color: COLORS.warning }}> Once executed and accepted, replacement is irreversible</strong> unless
          another valid 2-of-3 rotation is performed afterward.
        </p>

        {loadingAdmin ? (
          <span style={{ fontSize: 13, color: COLORS.muted }}>Loading…</span>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 2 }}>Current Admin</div>
            <div style={{ marginBottom: 8 }}>{currentAdmin ? <AddressChip address={currentAdmin} size={13} /> : <span style={{ fontSize: 13, color: COLORS.muted }}>—</span>}</div>
            <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 2 }}>Pending Admin</div>
            <div>
              {pendingAdminAddr ? <AddressChip address={pendingAdminAddr} size={13} color={COLORS.warning} /> : <span style={{ fontSize: 13, color: COLORS.muted }}>None — no rotation in progress</span>}
            </div>
          </div>
        )}

        {pendingAdminAddr && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {connectedWallet?.toLowerCase() === pendingAdminAddr.toLowerCase() && (
              <button onClick={handleAcceptAdmin} disabled={!connectedWallet || acceptingAdmin}
                style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', background: COLORS.success, color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', opacity: acceptingAdmin ? 0.6 : 1 }}>
                {acceptingAdmin ? 'Accepting…' : 'Accept Admin Role (I am the pending admin)'}
              </button>
            )}
            <button onClick={handleCancelPendingAdmin} disabled={!connectedWallet || proposingAdmin}
              style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'transparent', color: COLORS.text, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', opacity: proposingAdmin ? 0.6 : 1 }}>
              Propose Cancelling This Nomination
            </button>
          </div>
        )}

        <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.text, marginBottom: 6 }}>Propose a new Admin</div>
        <input value={newAdminInput} onChange={e => setNewAdminInput(e.target.value)} placeholder="New admin address 0x…"
          style={{ width: '100%', background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 13.5, fontFamily: 'monospace', boxSizing: 'border-box', marginBottom: 10 }} />
        <button onClick={handleProposeAdminRotation} disabled={!connectedWallet || proposingAdmin}
          style={{ width: '100%', padding: '11px 0', borderRadius: 12, border: 'none', background: COLORS.warning, color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', opacity: (!connectedWallet || proposingAdmin) ? 0.6 : 1 }}>
          {proposingAdmin ? 'Signing…' : 'Propose Admin Replacement (signs as 1st confirmation)'}
        </button>
      </div>

      {/* ── Propose a role change ────────────────────────────────────────── */}
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: 14, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.text, marginBottom: 10 }}>Propose a role change</div>
        <select value={action} onChange={e => setAction(e.target.value as RoleAction)}
          style={{ width: '100%', background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 13.5, marginBottom: 10 }}>
          {ROLE_ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
        {ROLE_ACTIONS.find(a => a.value === action)?.needsTarget && (
          <input value={target} onChange={e => setTarget(e.target.value)} placeholder="Target address 0x…"
            style={{ width: '100%', background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 13.5, fontFamily: 'monospace', boxSizing: 'border-box', marginBottom: 10 }} />
        )}
        {overlapWarning && (
          <div style={{ marginBottom: 10, padding: 10, borderRadius: 10, background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <AlertTriangle size={13} color={COLORS.error} />
              <span style={{ fontSize: 12, fontWeight: 700, color: COLORS.error }}>Blocked — would revert on-chain</span>
            </div>
            <p style={{ fontSize: 11.5, color: COLORS.muted, margin: 0, lineHeight: 1.4 }}>{overlapWarning}</p>
          </div>
        )}
        <button onClick={handlePropose} disabled={!connectedWallet || submitting || !!overlapWarning}
          style={{ width: '100%', padding: '11px 0', borderRadius: 12, border: 'none', background: COLORS.primary, color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', opacity: (!connectedWallet || submitting || !!overlapWarning) ? 0.6 : 1 }}>
          {submitting ? 'Signing…' : 'Propose (signs as 1st confirmation)'}
        </button>
      </div>

      {/* ── Rotate a signer ──────────────────────────────────────────────── */}
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: 14, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <RefreshCw size={14} color={COLORS.text} />
          <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>Rotate a signer</span>
        </div>
        <p style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 10, lineHeight: 1.4 }}>
          Replace one of the 3 fixed signer slots — e.g. a key was lost or compromised. Also requires 2-of-3
          confirmation; the new address can't already be one of the 3 current signers.
        </p>
        <select value={rotateIndex} onChange={e => setRotateIndex(Number(e.target.value))}
          style={{ width: '100%', background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 13.5, marginBottom: 10 }}>
          {[0, 1, 2].map(i => <option key={i} value={i}>Slot {i + 1} {signerAddresses[i] ? `(${shortAddr(signerAddresses[i])})` : ''}</option>)}
        </select>
        <input value={rotateTarget} onChange={e => setRotateTarget(e.target.value)} placeholder="New signer address 0x…"
          style={{ width: '100%', background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 13.5, fontFamily: 'monospace', boxSizing: 'border-box', marginBottom: 10 }} />
        <button onClick={handleRotate} disabled={!connectedWallet || rotating}
          style={{ width: '100%', padding: '11px 0', borderRadius: 12, border: `1px solid ${COLORS.border}`, background: 'transparent', color: COLORS.text, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', opacity: (!connectedWallet || rotating) ? 0.6 : 1 }}>
          {rotating ? 'Signing…' : 'Propose Rotation (signs as 1st confirmation)'}
        </button>
      </div>

      {/* ── Recent proposals ─────────────────────────────────────────────── */}
      <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 8 }}>Recent proposals</div>
      {loadingProposals ? (
        <span style={{ fontSize: 13, color: COLORS.muted }}>Loading…</span>
      ) : proposals.length === 0 ? (
        <span style={{ fontSize: 13, color: COLORS.muted }}>No proposals yet.</span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {proposals.map(p => {
            const nowSec = Math.floor(nowMs / 1000)
            const isTimelocked = !p.executed && !p.cancelled && p.executableAfter > 0 && nowSec < p.executableAfter
            const isReady = !p.executed && !p.cancelled && p.executableAfter > 0 && nowSec >= p.executableAfter
            const isPendingApproval = !p.executed && !p.cancelled && p.executableAfter === 0
            const remaining = isTimelocked ? p.executableAfter - nowSec : 0
            const hours = Math.floor(remaining / 3600)
            const minutes = Math.floor((remaining % 3600) / 60)
            const statusLabel = p.executed ? 'Executed' : p.cancelled ? 'Cancelled'
              : isReady ? 'Ready to execute'
              : isTimelocked ? `Timelocked — execution available in ${hours}h ${minutes}m`
              : `Pending Role Change — ${p.confirmations}/2 approvals`
            const statusColor = p.executed ? COLORS.success : p.cancelled ? COLORS.error
              : isReady ? COLORS.primary : COLORS.warning
            const confirmedBy = confirmedByForProposal(p.id)
            const connectedAlreadyConfirmed = !!connectedWallet && confirmedBy.includes(connectedWallet.toLowerCase())
            return (
              <div key={String(p.id)} style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>
                    #{String(p.id)} — {p.action}{p.action === 'RotateSigner' ? ` (slot ${p.signerIndex + 1})` : ''}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: statusColor, marginTop: 4 }}>{statusLabel}</div>
                {/* Per-signer confirmation status — which of the 3 fixed
                    signers has actually confirmed, not just a count, so a
                    signer can tell at a glance whether they still need to
                    act without risking an "already confirmed" revert. */}
                {!p.executed && !p.cancelled && signerAddresses.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                    {signerAddresses.map((addr, i) => {
                      const has = confirmedBy.includes(addr.toLowerCase())
                      const isMe = !!connectedWallet && connectedWallet.toLowerCase() === addr.toLowerCase()
                      return (
                        <span key={addr} style={{
                          fontSize: 10.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 3,
                          color: has ? COLORS.success : COLORS.muted,
                        }}>
                          {has ? <CheckCircle2 size={11} /> : <span style={{ width: 11, height: 11, borderRadius: '50%', border: `1.5px solid ${COLORS.border}`, display: 'inline-block' }} />}
                          Signer {i + 1}{isMe ? ' (you)' : ''}
                        </span>
                      )
                    })}
                  </div>
                )}
                <div style={{ marginTop: 6 }}>
                  {p.target === '0x0000000000000000000000000000000000000000' ? (
                    <span style={{ fontSize: 11.5, color: COLORS.muted }}>No target (cancels the pending admin nomination)</span>
                  ) : (
                    <AddressChip address={p.target} size={11.5} color={COLORS.muted} />
                  )}
                </div>
                {!p.executed && !p.cancelled && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    {isPendingApproval && (
                      <button onClick={() => handleConfirm(p.id)} disabled={!connectedWallet || !isConnectedWalletASigner || submitting || connectedAlreadyConfirmed}
                        title={connectedAlreadyConfirmed ? 'This wallet already confirmed — a DIFFERENT signer needs to confirm next.' : !isConnectedWalletASigner ? 'Connected wallet is not one of the 3 role manager signers.' : undefined}
                        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: COLORS.success, background: 'color-mix(in srgb, var(--success) 10%, transparent)', border: 'none', borderRadius: 8, padding: '6px 0', cursor: 'pointer', opacity: (connectedAlreadyConfirmed || !isConnectedWalletASigner) ? 0.5 : 1 }}>
                        <CheckCircle2 size={12} /> {connectedAlreadyConfirmed ? 'Already confirmed' : 'Confirm'}
                      </button>
                    )}
                    {isReady && (
                      <button onClick={() => handleExecute(p.id)} disabled={!connectedWallet || !isConnectedWalletASigner || submitting}
                        title={!isConnectedWalletASigner ? 'Connected wallet is not one of the 3 role manager signers.' : undefined}
                        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: '#fff', background: COLORS.primary, border: 'none', borderRadius: 8, padding: '6px 0', cursor: 'pointer', opacity: !isConnectedWalletASigner ? 0.5 : 1 }}>
                        Execute now
                      </button>
                    )}
                    <button onClick={() => handleCancel(p.id)} disabled={!connectedWallet || !isConnectedWalletASigner || submitting}
                      title={!isConnectedWalletASigner ? 'Connected wallet is not one of the 3 role manager signers.' : undefined}
                      style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: COLORS.error, background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: 'none', borderRadius: 8, padding: '6px 0', cursor: 'pointer', opacity: !isConnectedWalletASigner ? 0.5 : 1 }}>
                      <XCircle size={12} /> Cancel
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Security notifications — derived from on-chain events only ──── */}
      <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.3, marginTop: 20, marginBottom: 8 }}>
        Security Notifications
      </div>
      <p style={{ fontSize: 11, color: COLORS.muted, marginBottom: 10, lineHeight: 1.4 }}>
        Every entry below is read directly from an on-chain event this contract emitted — never from a database
        record. Tap a transaction hash to see the real event that produced it.
      </p>
      {loadingEvents ? (
        <span style={{ fontSize: 13, color: COLORS.muted }}>Loading…</span>
      ) : events.length === 0 ? (
        <span style={{ fontSize: 13, color: COLORS.muted }}>No governance events in the recent window.</span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {events.slice(0, 25).map((e, i) => {
            const meta = EVENT_META[e.name] ?? { label: e.name, color: 'muted' as const }
            return (
              <div key={`${e.txHash}-${i}`} style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, color: COLORS[meta.color],
                    background: `color-mix(in srgb, ${COLORS[meta.color]} 12%, transparent)`, padding: '2px 8px', borderRadius: 999,
                  }}>{meta.label}</span>
                  <span style={{ flexShrink: 0, fontSize: 10.5, color: COLORS.muted }}>
                    {e.timestamp ? new Date(e.timestamp * 1000).toLocaleString() : `block ${e.blockNumber}`}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {Object.entries(e.args).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', gap: 6, fontSize: 11, alignItems: 'center', minWidth: 0 }}>
                      <span style={{ color: COLORS.muted, flexShrink: 0 }}>{k}:</span>
                      {isAddressLike(v) ? <AddressChip address={v} size={11} /> : <span style={{ color: COLORS.text, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(v)}</span>}
                    </div>
                  ))}
                </div>
                <a href={`${ARC.explorerUrl}/tx/${e.txHash}`} target="_blank" rel="noreferrer"
                  style={{ display: 'inline-block', fontSize: 10, color: COLORS.primary, fontFamily: 'monospace', marginTop: 6, textDecoration: 'none' }}>
                  View transaction ↗
                </a>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
