import { Suspense } from 'react'
import { WorkstreamsPageContent } from '@/components/workstreams-page-content'

export default function WorkstreamsPage() {
  return (
    <Suspense
      fallback={<div className="p-4 md:p-6 text-center text-muted-foreground">Loading workstreams…</div>}
    >
      <WorkstreamsPageContent />
    </Suspense>
  )
}
