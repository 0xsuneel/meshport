// Profile → Merchant account (business accounts only).
// A business account applies at sign-up; this page shows that application's
// status (pending / approved / rejected / revoked), lets a rejected or
// revoked business apply again, and lets a business whose sign-up
// application didn't go through send it. Every application needs a reason.
// Personal accounts don't apply - they see how to open a business account.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Store, Clock, CheckCircle2, XCircle } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useUIStore } from '@/store'
import { useMerchant, applyForMerchant, type BusinessDoc } from '@/lib/merchant'
import { BusinessDocsField } from './BusinessDocsField'
import { BUSINESS_CATEGORIES, toCategory } from '@/lib/businessCategories'

const TYPES = BUSINESS_CATEGORIES

export function MerchantApplyPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const { showToastMessage } = useUIStore()
  const { loaded, status, application, accountType, storeName } = useMerchant()
  // Store name and type typed at sign-up (this device), to prefill the form.
  const draft = (() => { try { return JSON.parse(localStorage.getItem('meshport_business_draft') || 'null') as { storeName?: string; storeType?: string } | null } catch { return null } })()
  const [reapply, setReapply] = useState(false)
  const [businessName, setBusinessName] = useState(() => storeName || draft?.storeName || '')
  const [businessType, setBusinessType] = useState<string>(() => toCategory(draft?.storeType))
  const [contact, setContact] = useState('')
  const [description, setDescription] = useState('')
  const [registration, setRegistration] = useState('')
  const [docs, setDocs] = useState<BusinessDoc[]>([])
  const [submitting, setSubmitting] = useState(false)

  const showForm = (status === 'none' && accountType === 'business') || ((status === 'rejected' || status === 'revoked') && reapply)
  const personalOnly = status === 'none' && accountType === 'personal'

  const submit = async () => {
    if (businessName.trim().length < 2) { showToastMessage('Enter your business name', 'error'); return }
    if (description.trim().length < 10) { showToastMessage('Tell us why you need a business account', 'error'); return }
    if (!docs.length) { showToastMessage('Add at least one document - an ID or a photo of your shop', 'error'); return }
    setSubmitting(true)
    try {
      await applyForMerchant({ businessName, businessType, contact, description, registrationNumber: registration, documents: docs })
      setReapply(false); setDocs([]); setRegistration('')
      try { localStorage.removeItem('meshport_business_draft') } catch { /* storage unavailable */ }
      showToastMessage('Sent for review - we’ll let you know once it’s approved', 'success')
    } catch (e) {
      showToastMessage(e instanceof Error ? e.message : 'Could not submit - try again', 'error')
    }
    setSubmitting(false)
  }

  const input = 'w-full bg-surface border border-border rounded-2xl px-4 py-3 text-sm text-text-primary placeholder-text-secondary outline-none focus:border-brand'

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="header-row sticky top-0 z-20 bg-bg px-5 pt-header pb-header">
        <div className="flex items-center gap-3">
          {!isDesktop && (
            <button onClick={() => navigate(-1)} className="back-btn">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <h1 className="text-xl font-bold text-text-primary">{status === 'none' && accountType === 'business' ? 'Complete your business account' : 'Business account'}</h1>
        </div>
      </div>

      <div className="px-5 pb-10 pt-2 space-y-5 lg:max-w-[560px]">
        {!loaded ? (
          <div className="text-center py-10 text-sm text-text-secondary">Loading…</div>
        ) : personalOnly ? (
          <div className="bg-surface border border-border rounded-3xl p-6 flex flex-col items-center text-center gap-3">
            <Store className="w-10 h-10 text-brand-text" />
            <p className="text-base font-bold text-text-primary">Business tools are for business accounts</p>
            <p className="text-sm text-text-secondary leading-relaxed max-w-[340px]">
              This is a personal account. To accept payments as a store, create a business account: choose Business on the first sign-up screen and claim your store username.
            </p>
          </div>
        ) : showForm ? (
          <>
            <div className="bg-surface border border-border rounded-3xl p-5 flex gap-4 items-start">
              <div className="w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0 bg-brand/15 text-brand-text"><Store className="w-5 h-5" /></div>
              <div>
                <p className="text-sm font-semibold text-text-primary">Receive payments as a business</p>
                <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                  Customers can pay you in USDC on supported chains. Payments are collected to your Arc wallet automatically and listed in your Business tab.
                  MeshPort reviews every application.
                </p>
              </div>
            </div>

            <div className="bg-surface border border-border rounded-3xl p-5 space-y-4">
              <div>
                <p className="text-xs font-semibold text-text-secondary mb-2">Business name</p>
                <input value={businessName} onChange={e => setBusinessName(e.target.value)} maxLength={80} placeholder="e.g. Sunil Store" className={input} />
              </div>
              <div>
                <p className="text-xs font-semibold text-text-secondary mb-2">Business type</p>
                <div className="flex flex-wrap gap-2">
                  {TYPES.map(t => (
                    <button key={t} onClick={() => setBusinessType(t)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${businessType === t ? 'bg-brand text-white' : 'bg-surface text-text-secondary border border-border'}`}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-semibold text-text-secondary mb-2">Contact (email or phone) - optional</p>
                <input value={contact} onChange={e => setContact(e.target.value)} maxLength={120} placeholder="How can we reach you?" className={input} />
              </div>
              <div>
                <p className="text-xs font-semibold text-text-secondary mb-2">Why do you need a business account?</p>
                <textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={500} rows={3}
                  placeholder="What you sell and how customers will pay you" className={`${input} resize-none`} />
              </div>
              <div>
                <p className="text-xs font-semibold text-text-secondary mb-2">Registration number - optional</p>
                <input value={registration} onChange={e => setRegistration(e.target.value)} maxLength={40} placeholder="GST, VAT, EIN, ABN or business licence number" className={input} />
              </div>
              <div>
                <p className="text-xs font-semibold text-text-secondary mb-2">Documents</p>
                <BusinessDocsField docs={docs} onChange={setDocs} onError={m => showToastMessage(m, 'error')} />
              </div>
              <button onClick={submit} disabled={submitting}
                className="w-full py-3 rounded-2xl text-white text-sm font-semibold active:scale-95 transition-transform disabled:opacity-60"
                style={{ background: 'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
                {submitting ? 'Submitting…' : 'Apply for business account'}
              </button>
            </div>
          </>
        ) : application && (
          <div className="bg-surface border border-border rounded-3xl p-6 flex flex-col items-center text-center gap-3">
            {status === 'pending' && <Clock className="w-10 h-10 text-warning" />}
            {status === 'approved' && <CheckCircle2 className="w-10 h-10 text-success" />}
            {(status === 'rejected' || status === 'revoked') && <XCircle className="w-10 h-10 text-danger" />}
            <p className="text-base font-bold text-text-primary">
              {status === 'pending' ? 'Application under review'
                : status === 'approved' ? 'Business account approved'
                : status === 'revoked' ? 'Business access removed'
                : 'Application not approved'}
            </p>
            <p className="text-sm text-text-secondary">{application.businessName}{application.businessType ? ` · ${application.businessType}` : ''}</p>
            <p className="text-xs text-text-secondary leading-relaxed max-w-[340px]">
              {status === 'pending' && 'MeshPort is reviewing your application. You’ll get a notification when it’s decided.'}
              {status === 'approved' && 'Your collections, payments and settlements are in the Business tab. Payments on other chains wait in Settlements until you tap Settle now.'}
              {(status === 'rejected' || status === 'revoked') && (application.reviewNote || 'You can keep using MeshPort as usual.')}
            </p>
            <p className="text-[11px] text-text-secondary">Applied {new Date(application.createdAt).toLocaleDateString()}</p>
            {status === 'approved' && (
              <button onClick={() => navigate('/business')}
                className="mt-2 px-5 py-3 rounded-2xl text-white text-sm font-semibold"
                style={{ background: 'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
                Open Business
              </button>
            )}
            {(status === 'rejected' || status === 'revoked') && (
              <button onClick={() => setReapply(true)}
                className="mt-2 px-5 py-3 rounded-2xl text-sm font-semibold text-text-primary border border-border">
                Apply again
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
