// Documents on a merchant application: what the admin checks before
// approving (owner ID, shop photo, registration certificate). Each file is
// uploaded as soon as it's picked, into the applicant's private folder; the
// application lists the uploaded paths when it's sent.
import { useRef, useState } from 'react'
import { FileText, Image as ImageIcon, Plus, X } from 'lucide-react'
import {
  uploadBusinessDoc, removeBusinessDoc, BUSINESS_DOC_KINDS, MAX_BUSINESS_DOCS,
  type BusinessDoc, type BusinessDocKind,
} from '@/lib/merchant'

const kindLabel = (k: BusinessDocKind) => BUSINESS_DOC_KINDS.find(x => x.id === k)?.label ?? 'Document'

export function BusinessDocsField({ docs, onChange, onError }: {
  docs: BusinessDoc[]
  onChange: (docs: BusinessDoc[]) => void
  onError: (message: string) => void
}) {
  const [kind, setKind] = useState<BusinessDocKind>(() => docs.some(d => d.kind === 'id') ? 'shop_photo' : 'id')
  const [uploading, setUploading] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const full = docs.length >= MAX_BUSINESS_DOCS

  const pick = async (file: File | undefined) => {
    if (!file) return
    setUploading(true)
    try {
      const doc = await uploadBusinessDoc(file, kind)
      onChange([...docs, doc])
      if (kind === 'id') setKind('shop_photo')
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not upload - try again')
    }
    setUploading(false)
    if (input.current) input.current.value = ''
  }
  const remove = (d: BusinessDoc) => {
    onChange(docs.filter(x => x.path !== d.path))
    void removeBusinessDoc(d.path).catch(() => {})
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {BUSINESS_DOC_KINDS.map(k => (
          <button key={k.id} type="button" onClick={() => setKind(k.id)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${kind === k.id ? 'bg-brand text-white' : 'bg-surface text-text-secondary border border-border'}`}>
            {k.label}
          </button>
        ))}
      </div>
      {docs.length > 0 && (
        <ul className="space-y-2">
          {docs.map(d => (
            <li key={d.path} className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-3 py-2">
              {d.path.endsWith('.pdf') ? <FileText className="w-4 h-4 shrink-0 text-text-secondary" /> : <ImageIcon className="w-4 h-4 shrink-0 text-text-secondary" />}
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-semibold text-text-primary">{kindLabel(d.kind)}</span>
                <span className="block text-[11px] text-text-secondary truncate">{d.name}</span>
              </span>
              <button type="button" onClick={() => remove(d)} aria-label={`Remove ${d.name}`}
                className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-text-secondary active:bg-border/30">
                <X className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="hidden"
        onChange={e => { void pick(e.target.files?.[0]) }} />
      <button type="button" disabled={uploading || full} onClick={() => input.current?.click()}
        className="w-full min-h-[44px] rounded-2xl border border-dashed border-border text-sm font-semibold text-text-primary flex items-center justify-center gap-2 disabled:opacity-50">
        <Plus className="w-4 h-4" />
        {uploading ? 'Uploading…' : full ? `Up to ${MAX_BUSINESS_DOCS} files` : `Add ${kindLabel(kind).toLowerCase()}`}
      </button>
      <p className="text-[11px] text-text-secondary leading-relaxed">
        Photo or PDF, up to 5 MB each. Only MeshPort's review team can see these.
      </p>
    </div>
  )
}
