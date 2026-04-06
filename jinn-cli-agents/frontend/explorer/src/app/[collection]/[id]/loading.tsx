import { DetailViewSkeleton, PageHeaderSkeleton } from '@/components/loading-skeleton'

export default function Loading() {
  return (
    <div>
      <div className="mb-6">
        <div className="h-4 w-32 bg-gray-200 rounded animate-pulse"></div>
      </div>
      <PageHeaderSkeleton />
      <DetailViewSkeleton />
    </div>
  )
}