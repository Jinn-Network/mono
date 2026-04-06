import { DataTableSkeleton, PageHeaderSkeleton } from '@/components/loading-skeleton'

export default function Loading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <DataTableSkeleton />
    </div>
  )
}