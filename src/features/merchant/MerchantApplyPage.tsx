// Profile → Merchant account (business accounts only).
// A business account applies at sign-up; this page shows that application's
// status (pending / approved / rejected / revoked), lets a rejected or
// revoked business apply again, and lets a business whose sign-up
// application didn't go through send it. Every application needs a reason.
// A personal account can apply too (like Venmo's business profile on a
// personal account): it stays personal while MeshPort reviews it and becomes
// a business account - same username, wallet and history - once approved.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Store, Clock, CheckCircle2, XCircle } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useUIStore } from '@/store'
import { useMerchant, applyForMerchant, type BusinessDoc } from '@/lib/merchant'
import { BusinessDocsField } from './BusinessDocsField'
import { toCategory, nameAskFor, displayNameError } from '@/lib/businessCategories'
import { CategoryCards } from './CategoryCards'
import { errorText } from '@/lib/errorText'

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
  // Like Paytm's sign-up (28 Nov): the category first, then the name in that
  // category's words ("Restaurant name"), then the details.
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const ask = nameAskFor(businessType)
  const nameError = businessName.trim() ? displayNameError(businessName) : null

  const showForm = status === 'none' || ((status === 'rejected' || status === 'revoked') && reapply)
  const upgrading = accountType === 'personal'

  const submit = async () => {
    const nErr = displayNameError(businessName)
    if (nErr) { showToastMessage(nErr, 'error'); setStep(2); return }
    if (description.trim().length < 10) { showToastMessage('Tell us why you need a business account', 'error'); return }
    if (!docs.length) { showToastMessage('Add at least one document - an ID or a photo of your shop', 'error'); return }
    setSubmitting(true)
    try {
      await applyForMerchant({ businessName, businessType, contact, description, registrationNumber: registration, documents: docs })
      setReapply(false); setDocs([]); setRegistration('')
      try { localStorage.removeItem('meshport_business_draft') } catch { /* storage unavailable */ }
      showToastMessage('Sent for review - we’ll let you know once it’s approved', 'success')
    } catch (e) {
      showToastMessage(errorText(e, 'Could not submit - try again'), 'error')
    }
    setSubmitting(false)
  }

  const input = 'w-full bg-surface border border-border rounded-2xl px-4 py-3 text-sm text-text-primary placeholder-text-secondary outline-none focus:border-brand'

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="header-row mp-glass-header sticky top-0 z-20 px-5 pt-header pb-header">
        <div className="flex items-center gap-3">
          {!isDesktop && (
            <button onClick={() => navigate(-1)} className="back-btn">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <h1 className="text-xl font-bold text-text-primary">{status === 'none' && accountType === 'business' ? 'Complete your business account'
            : upgrading && status !== 'approved' ? 'Get a business account' : 'Business account'}</h1>
        </div>
      </div>

      <div className="px-5 pb-10 pt-2 space-y-5 lg:max-w-[560px]">
        {!loaded ? (
          <div className="text-center py-10 text-sm text-text-secondary">Loading…</div>
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
                {upgrading && (
                  <ul className="text-xs text-text-secondary mt-2 leading-relaxed list-disc pl-4 space-y-0.5">
                    <li>You keep this account: same username, wallet, contacts and history.</li>
                    <li>It stays personal while we review it. Once approved it becomes a business account with a Shop QR, bills and the Business tab - your Personal QR still works for friends.</li>
                    <li>Business accounts don't earn rewards.</li>
                  </ul>
                )}
              </div>
            </div>

            <p className="text-xs font-semibold text-text-muted px-1">Step {step} of 3</p>
            {step === 1 && (
              <div className="bg-surface border border-border rounded-3xl p-5 space-y-4">
                <div>
                  <p className="text-[15px] font-bold text-text-primary">What kind of business?</p>
                  <p className="text-xs text-text-muted mt-0.5 mb-3">Pick the closest - customers see it, and it sets the words MeshPort uses for you.</p>
                  <CategoryCards value={businessType} onChange={setBusinessType} />
                </div>
                <button onClick={() => setStep(2)}
                  className="w-full py-3 rounded-2xl text-white text-sm font-semibold active:scale-95 transition-transform"
                  style={{ background: 'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>Continue</button>
              </div>
            )}
            {step === 2 && (
              <div className="bg-surface border border-border rounded-3xl p-5 space-y-4">
                <div>
                  <p className="text-[15px] font-bold text-text-primary">{ask.label}</p>
                  <p className="text-xs text-text-muted mt-0.5 mb-3">Your customers see this when they make payment. It's your display name.</p>
                  <input value={businessName} onChange={e => setBusinessName(e.target.value)} maxLength={50} placeholder={`e.g. ${ask.example}`} className={input} autoFocus />
                  <p className={`text-xs mt-2 ${nameError ? 'text-danger' : 'text-text-muted'}`}>{nameError ?? "2–50 characters. Letters, numbers, spaces and & ' . , -"}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <button onClick={() => setStep(1)} className="py-3 rounded-2xl text-sm font-semibold border border-border text-text-primary active:scale-95 transition-transform">Back</button>
                  <button onClick={() => { const e = displayNameError(businessName); if (e) { showToastMessage(e, 'error'); return } setStep(3) }}
                    className="py-3 rounded-2xl text-white text-sm font-semibold active:scale-95 transition-transform"
                    style={{ background: 'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>Continue</button>
                </div>
              </div>
            )}
            {step === 3 && (
            <div className="bg-surface border border-border rounded-3xl p-5 space-y-4">
              <button type="button" onClick={() => setStep(2)} className="w-full text-left rounded-2xl border border-border px-4 py-3 active:bg-border/30">
                <span className="block text-[15px] font-bold text-text-primary">{businessName.trim()}</span>
                <span className="block text-xs text-text-muted mt-0.5">{businessType} · tap to change</span>
              </button>
              <div>
                <p className="text-xs font-semibold text-text-secondary mb-2">Contact (email or phone) - optional</p>
                <input value={contact} onChange={e => setContact(e.target.value)} maxLength={120} placeholder="How can we reach you?" className={input} />
              </div>
              <div>
                <p className="text-xs font-semibold text-text-secondary mb-2">What do you sell, and why do you need a business account?</p>
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
            )}
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
              {status === 'rejected' && (application.reviewNote || 'You can keep using MeshPort as usual.')}
              {status === 'revoked' && `${application.reviewNote ? application.reviewNote + ' ' : ''}You can still send and withdraw your funds; new payments are turned off.`}
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
