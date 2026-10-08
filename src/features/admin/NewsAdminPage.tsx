import { useEffect, useState, type CSSProperties } from 'react'
import { Newspaper, Send, Eye, EyeOff, Trash2, Pencil } from 'lucide-react'
import { AdminCard } from '@/components/admin/AdminCard'
import { supabase } from '@/lib/supabase'
import { NEWS_SOURCE_LABEL, newsDate, type NewsSource } from '@/lib/news'

// Admin → News. Writes MeshPort's own posts into public.news_items (shown in
// the Home News box and /news next to Arc and Circle stories), and lets an
// admin hide any story. Row-level security only lets admin_users do this.

interface AdminNewsRow {
  id: string
  source: NewsSource
  url: string | null
  title: string
  summary: string | null
  body: string[]
  image_url: string | null
  published_at: string
  hidden: boolean
}

const field: CSSProperties = {
  width: '100%', marginTop: 6, background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)',
  borderRadius: 14, padding: '12px 14px', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box',
}
const label: CSSProperties = { fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }

function validHttpsUrl(s: string): boolean {
  try { return new URL(s).protocol === 'https:' } catch { return false }
}

export function NewsAdminPage() {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [body, setBody] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [link, setLink] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [rows, setRows] = useState<AdminNewsRow[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    const { data, error } = await supabase.from('news_items')
      .select('id,source,url,title,summary,body,image_url,published_at,hidden')
      .order('published_at', { ascending: false }).limit(60)
    if (error) setError(error.message)
    setRows((data ?? []) as AdminNewsRow[])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const reset = () => { setEditingId(null); setTitle(''); setSummary(''); setBody(''); setImageUrl(''); setLink('') }

  const save = async () => {
    setError(null); setNotice(null)
    if (!title.trim()) { setError('Add a headline'); return }
    if (imageUrl.trim() && !validHttpsUrl(imageUrl.trim())) { setError('Cover image must be an https:// link'); return }
    if (link.trim() && !validHttpsUrl(link.trim())) { setError('Link must be an https:// link'); return }
    setSaving(true)
    const payload = {
      title: title.trim(),
      summary: summary.trim() || null,
      // A blank line starts a new paragraph.
      body: body.split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean),
      image_url: imageUrl.trim() || null,
      url: link.trim() || null,
    }
    const { data: auth } = await supabase.auth.getUser()
    const res = editingId
      ? await supabase.from('news_items').update(payload).eq('id', editingId).eq('source', 'meshport')
      : await supabase.from('news_items').insert({ ...payload, source: 'meshport', created_by: auth.user?.id ?? null })
    setSaving(false)
    if (res.error) {
      setError(res.error.code === '23505' ? 'Another story already uses that link' : res.error.message)
      return
    }
    setNotice(editingId ? 'Post updated' : 'Posted — it now shows in the app')
    reset(); load()
  }

  const edit = (r: AdminNewsRow) => {
    setEditingId(r.id); setTitle(r.title); setSummary(r.summary ?? ''); setBody(r.body.join('\n\n'))
    setImageUrl(r.image_url ?? ''); setLink(r.url ?? ''); setNotice(null); setError(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const toggleHidden = async (r: AdminNewsRow) => {
    const { error } = await supabase.from('news_items').update({ hidden: !r.hidden }).eq('id', r.id)
    if (error) { setError(error.message); return }
    setRows(list => list.map(x => x.id === r.id ? { ...x, hidden: !r.hidden } : x))
  }

  const remove = async (id: string) => {
    const { error } = await supabase.from('news_items').delete().eq('id', id).eq('source', 'meshport')
    setConfirmDelete(null)
    if (error) { setError(error.message); return }
    setRows(list => list.filter(x => x.id !== id))
    if (editingId === id) reset()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <AdminCard>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{ width: 38, height: 38, borderRadius: 12, background: 'color-mix(in srgb, var(--brand) 15%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Newspaper size={18} color="var(--brand-text)" />
          </div>
          <div>
            <p style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)', fontSize: 15 }}>{editingId ? 'Edit MeshPort post' : 'New MeshPort post'}</p>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>Shows in the Home Updates box and the Updates page, next to Arc and Circle stories</p>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={label}>Headline</label>
            <input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} placeholder="e.g. Bulk Pay is live" style={field} />
          </div>
          <div>
            <label style={label}>Summary (shown first, in bold)</label>
            <textarea value={summary} onChange={e => setSummary(e.target.value)} rows={2} maxLength={360} style={{ ...field, resize: 'vertical' }} />
          </div>
          <div>
            <label style={label}>Article (leave a blank line between paragraphs)</label>
            <textarea value={body} onChange={e => setBody(e.target.value)} rows={7} maxLength={8000} style={{ ...field, resize: 'vertical' }} />
          </div>
          <div>
            <label style={label}>Cover image link (optional, https, wide 1200×630 works best)</label>
            <input value={imageUrl} onChange={e => setImageUrl(e.target.value)} placeholder="https://…" style={field} />
          </div>
          <div>
            <label style={label}>Button link (optional — adds an "Open link" button)</label>
            <input value={link} onChange={e => setLink(e.target.value)} placeholder="https://…" style={field} />
          </div>

          {error && <div style={{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 25%, transparent)', borderRadius: 12, padding: '10px 12px', color: 'var(--danger)', fontSize: 13 }}>{error}</div>}
          {notice && <div style={{ background: 'color-mix(in srgb, var(--success) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--success) 25%, transparent)', borderRadius: 12, padding: '10px 12px', color: 'var(--success)', fontSize: 13 }}>{notice}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} disabled={saving || !title.trim()}
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 14, borderRadius: 20, border: 'none',
                background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', opacity: (saving || !title.trim()) ? 0.5 : 1 }}>
              <Send size={16} /> {saving ? 'Saving…' : editingId ? 'Save changes' : 'Publish'}
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
        <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 10px 4px' }}>All stories</p>
        {loading ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading…</p>
        ) : rows.length === 0 ? (
          <AdminCard><p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0, textAlign: 'center' }}>No stories yet. Arc and Circle stories arrive within 30 minutes of the news sync running.</p></AdminCard>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map(r => (
              <AdminCard key={r.id} padding={12} style={{ opacity: r.hidden ? 0.55 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 650, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</p>
                    <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                      {NEWS_SOURCE_LABEL[r.source]} · {newsDate(r.published_at)}{r.hidden ? ' · Hidden' : ''}
                    </p>
                  </div>
                  {r.source === 'meshport' && (
                    <button onClick={() => edit(r)} title="Edit" style={iconBtn}><Pencil size={15} /></button>
                  )}
                  <button onClick={() => toggleHidden(r)} title={r.hidden ? 'Show in app' : 'Hide from app'} style={iconBtn}>
                    {r.hidden ? <Eye size={15} /> : <EyeOff size={15} />}
                  </button>
                  {r.source === 'meshport' && (confirmDelete === r.id ? (
                    <button onClick={() => remove(r.id)} style={{ ...iconBtn, width: 'auto', padding: '0 10px', color: 'var(--danger)', fontSize: 12, fontWeight: 700 }}>Delete?</button>
                  ) : (
                    <button onClick={() => setConfirmDelete(r.id)} title="Delete" style={{ ...iconBtn, color: 'var(--danger)' }}><Trash2 size={15} /></button>
                  ))}
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
