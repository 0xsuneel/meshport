/**
 * StaffView — list of staff members with role legend.
 * StaffForm — invite / edit form.
 * StaffBanner — shown to a staff member on the overview.
 * StaffModeHeader — replaces BusinessHeader when in staff mode.
 */
import React from 'react'
import {
  UserPlus, Pencil, Trash2, Loader2, ShieldCheck, UserCheck, ExternalLink,
} from 'lucide-react'
import { useAuthStore } from '@/store'
import { useUserSearch } from '@/hooks/useUserSearch'
import { pickerProblem } from '@/lib/userSearch'

// ─── Types ────────────────────────────────────────────────────────────────────

export type StaffRole   = 'cashier' | 'manager'
export type StaffStatus = 'invited' | 'active'

export interface StaffMember {
  id: string
  name: string       // "ravi.arc"
  role: StaffRole
  status: StaffStatus
  store?: string
}

// ─── Role capabilities legend ─────────────────────────────────────────────────

const ROLE_LEGEND: Record<StaffRole, { label: string; perms: string[]; color: string }> = {
  cashier: {
    label: 'Cashier',
    color: 'bg-brand/10 text-brand-text',
    perms: ['Show QR', 'Request', "Today's payments"],
  },
  manager: {
    label: 'Manager',
    color: 'bg-success/10 text-success',
    perms: ['Cashier actions', 'Payment links', 'Send bill', 'Requests', 'Statements'],
  },
}

// ─── StaffView ────────────────────────────────────────────────────────────────

export interface StaffViewProps {
  staff: StaffMember[]
  onInvite: () => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
}

export function StaffView({ staff, onInvite, onEdit, onRemove }: StaffViewProps) {
  return (
    <div className="flex flex-col gap-5 px-5 py-4">
      {/* Role legend */}
      <div className="flex flex-col gap-2">
        <p className="text-xs text-text-muted font-medium">Roles</p>
        <div className="grid grid-cols-2 gap-2">
          {(Object.entries(ROLE_LEGEND) as [StaffRole, typeof ROLE_LEGEND[StaffRole]][]).map(([roleKey, info]) => (
            <div key={roleKey} className="bg-card border border-border rounded-2xl p-3 flex flex-col gap-1.5">
              <span className={`self-start px-2 py-0.5 rounded-full text-xs font-semibold ${info.color}`}>
                {info.label}
              </span>
              {info.perms.map(p => (
                <p key={p} className="text-xs text-text-secondary">· {p}</p>
              ))}
            </div>
          ))}
        </div>
        <p className="text-xs text-text-muted">
          Refunds, settlements and cash out are owner only.
        </p>
      </div>

      {/* Staff list */}
      {staff.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <UserCheck className="size-9 text-text-muted" />
          <p className="text-text-secondary font-medium">No staff yet</p>
          <p className="text-sm text-text-muted">Invite a cashier or manager to help accept payments.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {staff.map(member => {
            const legend = ROLE_LEGEND[member.role]
            return (
              <div
                key={member.id}
                className="bg-card border border-border rounded-2xl px-4 py-3.5 flex items-center gap-3"
              >
                <span className={`size-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${legend.color}`}>
                  {member.name[0].toUpperCase()}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-text-primary truncate">
                    {member.name}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`px-1.5 py-0.5 rounded-full text-[11px] font-semibold ${legend.color}`}>
                      {legend.label}
                    </span>
                    {member.status === 'invited' && (
                      <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-warning/10 text-warning font-medium">
                        Invited
                      </span>
                    )}
                    {member.store && (
                      <span className="text-[11px] text-text-muted truncate">{member.store}</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    type="button"
                    aria-label={`Edit ${member.name}`}
                    onClick={() => onEdit(member.id)}
                    className="size-9 rounded-xl text-text-muted hover:text-text-secondary hover:bg-border/30 flex items-center justify-center transition"
                  >
                    <Pencil className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${member.name}`}
                    onClick={() => onRemove(member.id)}
                    className="size-9 rounded-xl text-text-muted hover:text-danger hover:bg-danger/10 flex items-center justify-center transition"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <button
        type="button"
        onClick={onInvite}
        className="w-full h-12 rounded-2xl border border-dashed border-border text-text-secondary text-sm font-medium flex items-center justify-center gap-2 hover:border-brand/40 hover:text-brand-text transition"
      >
        <UserPlus className="size-4.5" />
        Invite staff
      </button>
    </div>
  )
}

// ─── StaffForm ────────────────────────────────────────────────────────────────

export interface StaffStore { id: string; name: string }

export interface StaffFormProps {
  username: string
  onUsername: (v: string) => void
  role: StaffRole
  onRole: (r: StaffRole) => void
  stores: StaffStore[]
  store?: string
  onStore: (id: string) => void
  busy?: boolean
  error?: string
  onSave: () => void
  onCancel: () => void
  /** Inviting someone new: check the username as it's typed. */
  checkUser?: boolean
}

const NO_PEOPLE: never[] = []

export function StaffForm({
  username, onUsername, role, onRole, stores, store, onStore,
  busy, error, onSave, onCancel, checkUser = false,
}: StaffFormProps) {
  // Only a full username.arc is looked up; the hint says what's wrong.
  const me = useAuthStore(s => s.user?.username ?? '')
  const { results, searching } = useUserSearch(checkUser ? username : '', NO_PEOPLE, true)
  const self = !!me && username.trim().toLowerCase().replace(/\.arc$/, '') === me.toLowerCase().replace(/\.arc$/, '')
  const problem = checkUser ? pickerProblem(username, { searching, found: self ? 0 : results.length, self }) : null
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-text-muted font-medium">Arc username</span>
        <input
          type="text"
          value={username}
          onChange={e => onUsername(e.target.value)}
          placeholder="ravi.arc"
          autoCapitalize="none"
          className="h-12 px-4 rounded-2xl bg-card border border-border text-text-primary text-sm ![font-size:max(var(--fs-field,0px),0.875rem)] focus:outline-none focus:ring-2 focus:ring-brand/40"
        />
        {problem && <span className={`text-[12px] px-0.5 ${problem.tone === 'danger' ? 'text-danger font-semibold' : 'text-text-muted'}`} role={problem.tone === 'danger' ? 'alert' : undefined}>{problem.text}</span>}
      </label>

      {/* Role segmented */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-text-muted font-medium">Role</span>
        <div className="flex gap-1.5 bg-bg rounded-2xl p-1">
          {(['cashier', 'manager'] as StaffRole[]).map(r => (
            <button
              key={r}
              type="button"
              onClick={() => onRole(r)}
              className={[
                'flex-1 h-9 rounded-xl text-sm font-medium capitalize transition',
                role === r ? 'bg-brand text-white' : 'text-text-secondary hover:text-text-primary',
              ].join(' ')}
            >
              {ROLE_LEGEND[r].label}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-muted">{ROLE_LEGEND[role].perms.join(', ')}</p>
      </div>

      {/* Store picker */}
      {stores.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-text-muted font-medium">Assign to store</span>
          <div className="flex flex-col gap-1">
            {stores.map(s => (
              <button
                key={s.id}
                type="button"
                onClick={() => onStore(s.id)}
                className={[
                  'flex items-center gap-3 px-4 py-3 rounded-2xl border text-left transition text-sm',
                  store === s.id
                    ? 'border-brand bg-brand/5 text-text-primary font-medium'
                    : 'border-border text-text-secondary hover:border-border',
                ].join(' ')}
              >
                <span className={`size-4 rounded-full border-2 flex items-center justify-center transition-colors ${store === s.id ? 'border-brand' : 'border-border'}`}>
                  {store === s.id && <span className="size-2 rounded-full bg-brand" />}
                </span>
                {s.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 h-12 rounded-2xl border border-border text-text-secondary text-sm font-medium hover:bg-border/20 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !username.trim()}
          className="flex-1 h-12 rounded-2xl bg-brand text-white font-semibold text-sm disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          {username.trim() ? 'Send invite' : 'Enter username'}
        </button>
      </div>
    </div>
  )
}

// ─── StaffBanner ──────────────────────────────────────────────────────────────

export interface StaffBannerProps {
  ownerStore: string
  role: StaffRole
  /** Not accepted yet: the button accepts the invite. */
  invited?: boolean
  onOpen: () => void
}

export function StaffBanner({ ownerStore, role, invited, onOpen }: StaffBannerProps) {
  const legend = ROLE_LEGEND[role]
  return (
    <div className="mx-5 bg-card border border-border rounded-2xl px-4 py-4 flex items-center gap-3">
      <span className={`size-10 rounded-xl flex items-center justify-center shrink-0 ${legend.color}`}>
        <ShieldCheck className="size-5" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-text-primary">
          {invited ? 'Invited as a' : "You're a"} {legend.label.toLowerCase()} at
        </p>
        <p className="text-sm text-text-secondary truncate">{ownerStore}</p>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="shrink-0 h-9 px-4 rounded-xl bg-brand text-white text-sm font-semibold flex items-center gap-1.5 hover:opacity-90 transition-opacity"
      >
        {invited ? 'Accept' : <>Open<ExternalLink className="size-3.5" /></>}
      </button>
    </div>
  )
}

// ─── StaffModeHeader ──────────────────────────────────────────────────────────

export interface StaffModeHeaderProps {
  store: string
  role: StaffRole
  onExit: () => void
}

export function StaffModeHeader({ store, role, onExit }: StaffModeHeaderProps) {
  const legend = ROLE_LEGEND[role]
  return (
    <header className="flex items-center gap-3 px-5 pt-5 pb-3">
      <span className={`size-9 rounded-xl flex items-center justify-center shrink-0 ${legend.color}`}>
        <ShieldCheck className="size-4.5" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-text-primary truncate">{store}</p>
        <p className="text-xs text-text-muted">{legend.label} mode</p>
      </div>
      <button
        type="button"
        onClick={onExit}
        className="shrink-0 h-9 px-4 rounded-xl border border-border text-text-secondary text-sm font-medium hover:bg-border/30 transition-colors"
      >
        Exit
      </button>
    </header>
  )
}
