import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { ArrowLeft } from 'lucide-react'
import { ActivityRecord, fetchActivityById } from '@/lib/ActivityService'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DetailSheet, ActivityPage } from './ActivityPage'
import { AnimatePresence } from 'framer-motion'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'

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
        {/* Nothing to show: the app's centred popup says so (tap outside,
            Esc, Back or the arrow close it, like the receipt). */}
        {!loading && !record && (
          <DesktopDialogFrame key="not-found" onClose={close} maxWidth={320}>
            <div className="flex flex-col items-center gap-3" style={{ padding: '24px 20px' }}>
              <p className="text-text-primary font-semibold">Transaction not found</p>
              {!isDesktop && (
                <button onClick={close} className="back-btn" aria-label="Back"><ArrowLeft className="w-5 h-5 text-text-primary"/></button>
              )}
            </div>
          </DesktopDialogFrame>
        )}
    </div>
  )
}
