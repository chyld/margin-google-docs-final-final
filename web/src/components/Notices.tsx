import { useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { dismissNotice, getNotices, subscribeNotices } from '../state/notices.ts'

export function Notices() {
  const notices = useSyncExternalStore(subscribeNotices, getNotices)
  if (notices.length === 0) return null
  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map(notice => (
        <div key={notice.id} className="notice">
          <span>{notice.message}</span>
          <button type="button" className="notice-close" aria-label="Dismiss" onClick={() => dismissNotice(notice.id)}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}
