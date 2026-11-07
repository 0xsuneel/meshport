// Admin Panel → Chains, separately for personal and business accounts.
//
//   Personal   Transfer (chain + its routes)   Bring (chain + its routes)
//   Business   Transfer (chain + its routes)   Bring (chain + its routes)
//              Settle (chain, always CCTP)
//
// Each kind of account has its own rows (business = biz_ keys, see
// src/lib/featureFilters.ts), so a switch here never changes the other kind.
// No overrides or fallbacks: a route is offered only when its switch is on,
// and a chain whose routes are all off is off for users.
import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { AdminCard } from '@/components/admin/AdminCard'
import { AdminToggle } from '@/components/admin/AdminToggle'
import { Chips, Notice, Pill } from '@/components/admin/AdminUi'
import { useSettingsStore } from '@/store/settingsStore'
import { updateSetting, updateSettingValue } from '@/lib/adminSupabase'
import type { AppSetting } from '@/lib/adminSupabase'
import {
  CHAIN_TRANSFER_FEATURE_MAP, CHAIN_CLAIM_FEATURE_MAP, transferKeys, bringKeys, settleKey,
  type AccountKind,
} from '@/lib/featureFilters'
import { UB_CLAIM_CHAINS } from '@/lib/ubChains'
import { canBringOverCctp } from '@/lib/gaslessBridge'

type Flow = 'transfer' | 'bring' | 'settle'
type RouteSwitch = { label: string; key: string | null; supported: boolean; note?: string }
type ChainEntry = { id: string; name: string; chainKey: string | null; routes: RouteSwitch[]; reason?: boolean; note?: string }

const nameOf = (row: AppSetting | undefined, fallback: string) => (row?.label || fallback).replace(/\s*\(.*\)$/, '')

// Polygon has two Bring ids for one chain - one card.
const BRING_IDS = Object.keys(CHAIN_CLAIM_FEATURE_MAP).filter(id => id !== 'Polygon_Amoy_Testnet')

function entries(settings: Record<string, AppSetting>, kind: AccountKind, flow: Flow): ChainEntry[] {
  if (flow === 'transfer') {
    return Object.keys(CHAIN_TRANSFER_FEATURE_MAP).map(id => {
      const k = transferKeys(kind, id)
      return {
        id, name: nameOf(settings[CHAIN_TRANSFER_FEATURE_MAP[id]], id), chainKey: k.chain,
        routes: k.ub
          ? [{ label: 'Unified Balance', key: k.ub, supported: true }, { label: 'CCTP', key: k.cctp, supported: true }]
          : [{ label: 'CCTP', key: null, supported: true, note: 'Only route' }],
      }
    })
  }
  if (flow === 'bring') {
    return BRING_IDS.map(id => {
      const k = bringKeys(kind, id)
      const ub = UB_CLAIM_CHAINS.has(id), cctp = canBringOverCctp(id)
      return {
        id, name: nameOf(settings[CHAIN_CLAIM_FEATURE_MAP[id]], id), chainKey: k.chain, reason: true,
        routes: [
          { label: 'Unified Balance', key: k.ub, supported: ub, note: ub ? (kind === 'business' ? 'Not for approved merchants' : undefined) : 'Not supported on this chain' },
          { label: 'CCTP', key: k.cctp, supported: cctp, note: cctp ? undefined : 'No gasless router on this chain' },
        ],
      }
    })
  }
  return BRING_IDS.map(id => {
    const cctp = canBringOverCctp(id)
    return {
      id, name: nameOf(settings[CHAIN_CLAIM_FEATURE_MAP[id]], id), chainKey: settleKey(id),
      routes: [{ label: 'CCTP', key: null, supported: cctp, note: cctp ? 'Only route' : 'No gasless router - can’t settle' }],
    }
  })
}

function Row({ children, sub }: { children: ReactNode; sub?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: sub ? '8px 0 8px 14px' : '0', borderTop: sub ? '1px solid var(--border)' : undefined }}>
      {children}
    </div>
  )
}

function ChainCard({ e, settings, pending, toggle, reason }: {
  e: ChainEntry; settings: Record<string, AppSetting>; pending: Record<string, boolean>
  toggle: (key: string, next: boolean) => void
  reason: { draft: (key: string) => string; set: (key: string, v: string) => void; save: (key: string) => void }
}) {
  const chainRow = e.chainKey ? settings[e.chainKey] : undefined
  if (!e.chainKey || !chainRow) {
    return (
      <AdminCard padding={14}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{e.name}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>Switch not set up yet ({e.chainKey ?? 'no key'}) - apply the chains migration.</div>
      </AdminCard>
    )
  }
  const chainOn = chainRow.enabled
  const switchable = e.routes.filter(r => r.key && r.supported)
  const routeOn = (r: RouteSwitch) => r.supported && (r.key ? !!settings[r.key]?.enabled : true)
  const anyRoute = e.routes.some(routeOn)
  const live = chainOn && anyRoute
  return (
    <AdminCard padding={14} style={{ display: 'flex', flexDirection: 'column', gap: 8, opacity: live ? 1 : 0.92 }}>
      <Row>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{e.name}</span>
          <Pill color={live ? 'var(--success-text)' : 'var(--text-secondary)'}>{live ? 'ON' : 'OFF'}</Pill>
        </div>
        <AdminToggle checked={chainOn} disabled={!!pending[e.chainKey]} onChange={next => toggle(e.chainKey!, next)} />
      </Row>

      {e.routes.map(r => (
        <Row key={r.label} sub>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: r.supported ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{r.label}</div>
            {r.note && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{r.note}</div>}
          </div>
          {r.key && r.supported
            ? <AdminToggle checked={!!settings[r.key]?.enabled} disabled={!!pending[r.key] || !settings[r.key]} onChange={next => toggle(r.key!, next)} />
            : <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>{r.supported ? 'Always' : 'N/A'}</span>}
        </Row>
      ))}

      {chainOn && !anyRoute && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--warning-text)' }}>
          <AlertTriangle size={13} /> {switchable.length ? 'Every route is off - users don’t see this chain.' : 'This chain has no route - users don’t see it.'}
        </div>
      )}

      {e.reason && !live && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
          Reason shown to users (optional - defaults to "Upgrading - coming soon")
          <input value={reason.draft(e.chainKey)} onChange={ev => reason.set(e.chainKey!, ev.target.value)} onBlur={() => reason.save(e.chainKey!)}
            placeholder="e.g. Bridge upgrading - back Thursday"
            style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 10px', color: 'var(--text-primary)', fontSize: 'max(var(--fs-field, 0px), 13px)', fontFamily: 'inherit' }} />
        </label>
      )}
    </AdminCard>
  )
}

const SECTIONS: Record<AccountKind, { flow: Flow; title: string; text: string }[]> = {
  personal: [
    { flow: 'transfer', title: 'Transfer', text: 'Arc → other chains. Each chain’s routes below it.' },
    { flow: 'bring', title: 'Bring', text: 'Other chains → Arc. Each chain’s routes below it.' },
  ],
  business: [
    { flow: 'transfer', title: 'Transfer', text: 'Arc → other chains, for business accounts.' },
    { flow: 'bring', title: 'Bring', text: 'Other chains → Arc from the Multichain Hub, for business accounts.' },
    { flow: 'settle', title: 'Settle', text: 'Business → Settlements and Claim All: customer payments on other chains → Arc, over CCTP.' },
  ],
}

export function ChainsPage() {
  const { settings, loaded, load, refresh } = useSettingsStore()
  const [kind, setKind] = useState<AccountKind>('personal')
  const [flow, setFlow] = useState<Flow>('transfer')
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  useEffect(() => { load() }, [load])
  useEffect(() => { if (!SECTIONS[kind].some(s => s.flow === flow)) setFlow('transfer') }, [kind, flow])

  const toggle = async (key: string, next: boolean) => {
    const row = settings[key]
    if (!row) return
    setPending(p => ({ ...p, [key]: true }))
    useSettingsStore.setState(s => ({ settings: { ...s.settings, [key]: { ...row, enabled: next } } }))
    const { error } = await updateSetting(key, next)
    if (error) await refresh()
    setPending(p => ({ ...p, [key]: false }))
  }
  const reason = {
    draft: (key: string) => drafts[key] ?? settings[key]?.value ?? '',
    set: (key: string, v: string) => setDrafts(d => ({ ...d, [key]: v })),
    save: async (key: string) => {
      const row = settings[key], next = drafts[key]
      if (!row || next === undefined || next === (row.value ?? '')) return
      useSettingsStore.setState(s => ({ settings: { ...s.settings, [key]: { ...row, value: next } } }))
      await updateSettingValue(key, next)
    },
  }

  if (!loaded) return <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading settings…</p>

  const section = SECTIONS[kind].find(s => s.flow === flow) ?? SECTIONS[kind][0]
  const list = entries(settings, kind, section.flow).sort((a, b) => a.name.localeCompare(b.name))
  const liveCount = list.filter(e => {
    const row = e.chainKey ? settings[e.chainKey] : undefined
    return row?.enabled && e.routes.some(r => r.supported && (r.key ? settings[r.key]?.enabled : true))
  }).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Chips items={[{ key: 'personal', label: 'Personal accounts' }, { key: 'business', label: 'Business accounts' }]} value={kind} onChange={setKind} />
      <Chips items={SECTIONS[kind].map(s => ({ key: s.flow, label: s.title }))} value={section.flow} onChange={setFlow} />
      <Notice>
        <b style={{ color: 'var(--text-primary)' }}>{kind === 'personal' ? 'Personal' : 'Business'} · {section.title}</b> - {section.text}{' '}
        {liveCount} of {list.length} chains on. These switches only affect {kind} accounts.
      </Notice>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
        {list.map(e => <ChainCard key={`${kind}-${section.flow}-${e.id}`} e={e} settings={settings} pending={pending} toggle={toggle} reason={reason} />)}
      </div>
    </div>
  )
}
