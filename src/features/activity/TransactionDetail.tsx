import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { ArrowLeft } from 'lucide-react'
import { ActivityRecord, fetchActivityById } from '@/lib/ActivityService'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DetailSheet, ActivityPage } from './ActivityPage'
import { AnimatePresence } from 'framer-motion'

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

  // Opened from a link: the Activity list sits behind, and the receipt opens
  // over it once the record has loaded (no blank page with a spinner first).
  // Closing returns to where the user came from, or to Activity.
  const close = () => { if (window.history.length > 1) navigate(-1); else navigate('/activity', { replace: true }) }
  return (
    <div className="flex flex-col h-full bg-bg">
      <ActivityPage />
      <AnimatePresence>
        {record && <DetailSheet key="detail" record={record} onClose={close} />}
      </AnimatePresence>
      {!loading && !record && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3" style={{ background: 'rgba(6,10,14,0.62)' }} onClick={close}>
          <p className="text-white font-semibold">Transaction not found</p>
          {!isDesktop && (
            <button onClick={close} className="back-btn"><ArrowLeft className="w-5 h-5 text-white"/></button>
          )}
        </div>
      )}
    </div>
  )
}
