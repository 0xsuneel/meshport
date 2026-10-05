import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { ArrowLeft } from 'lucide-react'
import { ActivityRecord, fetchActivityById } from '@/lib/ActivityService'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DetailSheet } from './ActivityPage'

export function TransactionDetailPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate  = useNavigate()
  const location  = useLocation()
  const { id }    = useParams<{ id: string }>()
  const [record, setRecord] = useState<ActivityRecord | null>(location.state?.record ?? null)
  const [loading, setLoading] = useState(!record)

  useEffect(() => {
    if (record || !id) return
    setLoading(true)
    fetchActivityById(id)
      .then(found => { if (found) setRecord(found) })
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return (
    <div className="flex flex-col h-full bg-bg items-center justify-center">
      <div className="w-8 h-8 border-2 border-brand/30 border-t-brand rounded-full animate-spin" />
    </div>
  )

  if (!record) return (
    <div className="flex flex-col h-full bg-bg items-center justify-center gap-3">
      <p className="text-text-secondary">Transaction not found</p>
      {!isDesktop && (
        <button onClick={() => navigate(-1)} className="back-btn"><ArrowLeft className="w-5 h-5 text-text-primary"/></button>
      )}
    </div>
  )

  // Same receipt a live payment ends on (and that tapping any history card
  // opens) — see DetailSheet/ReceiptPopup. Closing returns to where the
  // user came from, or to Activity when opened directly from a link.
  const close = () => { if (window.history.length > 1) navigate(-1); else navigate('/activity', { replace: true }) }
  return (
    <div className="flex flex-col h-full bg-bg">
      <DetailSheet record={record} onClose={close} />
    </div>
  )
}
