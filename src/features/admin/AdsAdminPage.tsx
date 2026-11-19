import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Megaphone, Send, Eye, EyeOff, Trash2, Pencil, ImagePlus, X } from 'lucide-react'
import { AdminCard } from '@/components/admin/AdminCard'
import { supabase } from '@/lib/supabase'
import { AdArt } from '@/components/ui/AdArt'
import { loadAds, type Ad, type AdIcon } from '@/lib/ads'

// Admin → Ads (19 Nov 2026). The ads in the Home banner (they rotate) and on
// the success screens (one picked at random each time): MeshPort's own
// features and partners. public.app_ads; row-level security only lets
// admin_users change it. Images go to the public "ads" storage bucket.

type Row = Ad & { created_at: string }

const field: CSSProperties = {
  width: '100%', marginTop: 6, background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)',
  borderRadius: 14, padding: '12px 14px', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box',
}
const label: CSSProperties = { fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }
const hint: CSSProperties = { fontSize: 11.5, color: 'var(--text-muted)', margin: '5px 2px 0', lineHeight: 1.4 }

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
const MAX_BYTES = 1024 * 1024
const ICONS: { id: AdIcon; name: string }[] = [
  { id: 'hub', name: 'Multichain' }, { id: 'swap', name: 'Swap' }, { id: 'p2p', name: 'P2P' }, { id: 'chat', name: 'Chat' }, { id: 'bulk', name: 'Bulk' },
]

const validLink = (s: string) => /^\/[A-Za-z0-9/_?=&.-]*$/.test(s) || /^https:\/\/\S+$/.test(s)

export function AdsAdminPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [link, setLink] = useState('')
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [icon, setIcon] = useState<AdIcon>('hub')
  const [partner, setPartner] = useState(false)
  const [sponsor, setSponsor] = useState('')
  const [onHome, setOnHome] = useState(true)
  const [onSuccess, setOnSuccess] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = async () => {
    setLoading(true)
    const { data, error } = await supabase.from('app_ads')
      .select('id,title,body,link,image_url,icon,sponsor,on_home,on_success,active,feature_flag,sort,created_at')
      .order('sort', { ascending: true }).order('created_at', { ascending: true })
    if (error) setError(error.message)
    setRows((data ?? []) as Row[])
    setLoading(false)
  }
  useEffect(() => { void load() }, [])
  // The app's own list (this admin's tab) follows the changes.
  const changed = () => { void load(); void loadAds(true).catch(() => {}) }

  const reset = () => {
    setEditingId(null); setTitle(''); setBody(''); setLink(''); setImageUrl(null); setIcon('hub')
    setPartner(false); setSponsor(''); setOnHome(true); setOnSuccess(true)
  }

  const upload = async (file: File) => {
    setError(null)
    if (!IMAGE_TYPES.includes(file.type)) { setError('Use a PNG, JPG, WebP or SVG image'); return }
    if (file.size > MAX_BYTES) { setError('The image is over 1 MB - make it smaller'); return }
    setUploading(true)
    const ext = file.type === 'image/svg+xml' ? 'svg' : file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error } = await supabase.storage.from('ads').upload(path, file, { contentType: file.type, cacheControl: '31536000', upsert: false })
    setUploading(false)
    if (error) { setError(error.message); return }
    setImageUrl(supabase.storage.from('ads').getPublicUrl(path).data.publicUrl)
  }

  const save = async () => {
    setError(null); setNotice(null)
    const t = title.trim(), l = link.trim()
    if (!t) { setError('Add a title'); return }
    if (!validLink(l)) { setError('Link must be an app page (like /swap) or a website starting with https://'); return }
    if (partner && !sponsor.trim()) { setError("Add the partner's name (shown as “Sponsored · …”)"); return }
    if (!onHome && !onSuccess) { setError('Choose where it shows'); return }
    setSaving(true)
    const payload = {
      title: t, body: body.trim(), link: l, image_url: imageUrl,
      icon: imageUrl ? null : icon,
      sponsor: partner ? sponsor.trim() : null,
      on_home: onHome, on_success: onSuccess, updated_at: new Date().toISOString(),
    }
    const res = editingId
      ? await supabase.from('app_ads').update(payload).eq('id', editingId)
      : await supabase.from('app_ads').insert({ ...payload, sort: (rows.reduce((m, r) => Math.max(m, r.sort), 0) || 0) + 10 })
    setSaving(false)
    if (res.error) { setError(res.error.message); return }
    setNotice(editingId ? 'Ad updated' : 'Ad added - it now shows in the app')
    reset(); changed()
  }

  const edit = (r: Row) => {
    setEditingId(r.id); setTitle(r.title); setBody(r.body); setLink(r.link); setImageUrl(r.image_url); setIcon(r.icon ?? 'hub')
    setPartner(!!r.sponsor); setSponsor(r.sponsor ?? ''); setOnHome(r.on_home); setOnSuccess(r.on_success)
    setNotice(null); setError(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const toggle = async (r: Row) => {
    const { error } = await supabase.from('app_ads').update({ active: !r.active, updated_at: new Date().toISOString() }).eq('id', r.id)
    if (error) { setError(error.message); return }
    changed()
  }

  const remove = async (id: string) => {
    const { error } = await supabase.from('app_ads').delete().eq('id', id)
    setConfirmDelete(null)
    if (error) { setError(error.message); return }
    if (editingId === id) reset()
    changed()
  }

  const chip = (on: boolean): CSSProperties => ({
    padding: '8px 12px', borderRadius: 999, fontSize: 13, fontWeight: 650, cursor: 'pointer', fontFamily: 'inherit',
    border: on ? '1.5px solid var(--brand)' : '1px solid var(--border)', color: on ? 'var(--brand-text)' : 'var(--text-secondary)',
    background: on ? 'color-mix(in srgb, var(--brand) 10%, transparent)' : 'var(--surface)',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <AdminCard>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{ width: 38, height: 38, borderRadius: 12, background: 'color-mix(in srgb, var(--brand) 15%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Megaphone size={18} color="var(--brand-text)" />
          </div>
          <div>
            <p style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)', fontSize: 15 }}>{editingId ? 'Edit ad' : 'New ad'}</p>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>Home banner (rotates through the ads) and success screens (one at random each time)</p>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={label}>From</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button type="button" onClick={() => setPartner(false)} style={chip(!partner)}>MeshPort</button>
              <button type="button" onClick={() => setPartner(true)} style={chip(partner)}>Partner (Sponsored)</button>
            </div>
          </div>
          {partner && (
            <div>
              <label style={label}>Partner name</label>
              <input value={sponsor} onChange={e => setSponsor(e.target.value)} maxLength={40} placeholder="e.g. portal.arc.io" style={field} />
              <p style={hint}>Shown as “Sponsored · {sponsor.trim() || 'name'}”.</p>
            </div>
          )}
          <div>
            <label style={label}>Title</label>
            <input value={title} onChange={e => setTitle(e.target.value)} maxLength={60} placeholder="e.g. Arc Portal" style={field} />
            <p style={hint}>Up to 60 characters - about 20 fit on a phone.</p>
          </div>
          <div>
            <label style={label}>Text</label>
            <input value={body} onChange={e => setBody(e.target.value)} maxLength={120} placeholder="e.g. Explore the Arc ecosystem" style={field} />
            <p style={hint}>One short line - about 30 characters fit on a phone.</p>
          </div>
          <div>
            <label style={label}>Link</label>
            <input value={link} onChange={e => setLink(e.target.value)} placeholder="/swap or https://…" style={field} />
            <p style={hint}>An app page (/swap, /multichain, /p2p…) opens in the app; a website (https://…) opens in a new tab.</p>
          </div>

          <div>
            <label style={label}>Image</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
              <AdArt ad={{ image_url: imageUrl, icon, title }} size={56} radius={14} />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
                  style={{ ...chip(false), display: 'flex', alignItems: 'center', gap: 6, opacity: uploading ? 0.6 : 1 }}>
                  <ImagePlus size={15} /> {uploading ? 'Uploading…' : imageUrl ? 'Change image' : 'Upload image'}
                </button>
                {imageUrl && <button type="button" onClick={() => setImageUrl(null)} style={{ ...chip(false), display: 'flex', alignItems: 'center', gap: 6 }}><X size={14} /> Remove</button>}
              </div>
              <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(',')} hidden
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f) }} />
            </div>
            <p style={hint}>
              <b>Square image, 256 × 256 px</b> (at least 128 × 128). PNG, JPG, WebP or SVG, up to 1 MB.
              It shows as a small rounded tile (40 px on the Home banner, 44 px on success screens) -
              a logo or icon with some space around it works best; text in the image won't be readable.
            </p>
            {!imageUrl && (
              <div style={{ marginTop: 8 }}>
                <span style={{ ...label, fontWeight: 500 }}>No image? Use a MeshPort icon:</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {ICONS.map(i => <button key={i.id} type="button" onClick={() => setIcon(i.id)} style={chip(icon === i.id)}>{i.name}</button>)}
                </div>
              </div>
            )}
          </div>

          <div>
            <label style={label}>Shows on</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button type="button" onClick={() => setOnHome(v => !v)} style={chip(onHome)}>Home banner</button>
              <button type="button" onClick={() => setOnSuccess(v => !v)} style={chip(onSuccess)}>Success screens</button>
            </div>
          </div>

          {error && <div style={{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 25%, transparent)', borderRadius: 12, padding: '10px 12px', color: 'var(--danger-text)', fontSize: 13 }}>{error}</div>}
          {notice && <div style={{ background: 'color-mix(in srgb, var(--success) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--success) 25%, transparent)', borderRadius: 12, padding: '10px 12px', color: 'var(--success-text)', fontSize: 13 }}>{notice}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} disabled={saving || uploading || !title.trim()}
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 14, borderRadius: 20, border: 'none',
                background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', opacity: (saving || uploading || !title.trim()) ? 0.5 : 1 }}>
              <Send size={16} /> {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add ad'}
            </button>
            {editingId && (
              <button onClick={reset} style={{ padding: '14px 18px', borderRadius: 20, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
                Cancel
              </button>
            )}
          </div>
        </div>
      </AdminCard>

      <div>
        <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 10px 4px' }}>All ads</p>
        {loading ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading…</p>
        ) : rows.length === 0 ? (
          <AdminCard><p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0, textAlign: 'center' }}>No ads. The Home banner and the success screens' “For you” card are hidden until you add one.</p></AdminCard>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map(r => (
              <AdminCard key={r.id} padding={12} style={{ opacity: r.active ? 1 : 0.55 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <AdArt ad={r} size={38} radius={10} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 650, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.title}
                      <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '2px 8px',
                        color: r.sponsor ? '#B45309' : 'var(--brand-text)', background: r.sponsor ? 'color-mix(in srgb, #F59E0B 16%, transparent)' : 'color-mix(in srgb, var(--brand) 12%, transparent)' }}>
                        {r.sponsor ? 'Sponsored' : 'MeshPort'}
                      </span>
                    </p>
                    <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.link} · {[r.on_home && 'Home', r.on_success && 'Success'].filter(Boolean).join(' + ')}{r.active ? '' : ' · Off'}
                    </p>
                  </div>
                  <button onClick={() => edit(r)} title="Edit" style={iconBtn}><Pencil size={15} /></button>
                  <button onClick={() => toggle(r)} title={r.active ? 'Turn off' : 'Turn on'} style={iconBtn}>
                    {r.active ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                  {confirmDelete === r.id ? (
                    <button onClick={() => remove(r.id)} style={{ ...iconBtn, width: 'auto', padding: '0 10px', color: 'var(--danger-text)', fontSize: 12, fontWeight: 700 }}>Delete?</button>
                  ) : (
                    <button onClick={() => setConfirmDelete(r.id)} title="Delete" style={{ ...iconBtn, color: 'var(--danger-text)' }}><Trash2 size={15} /></button>
                  )}
                </div>
              </AdminCard>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const iconBtn: CSSProperties = {
  width: 34, height: 34, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-secondary)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: 'none',
}
