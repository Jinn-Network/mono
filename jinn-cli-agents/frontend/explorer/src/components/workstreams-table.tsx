'use client'

import Link from 'next/link'
import { SubgraphRecord } from '@/hooks/use-subgraph-collection'
import { formatDate } from '@/lib/utils'
import { TruncatedId } from '@/components/truncated-id'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface WorkstreamsTableProps {
  records: SubgraphRecord[]
}

export function WorkstreamsTable({ records }: WorkstreamsTableProps) {
  if (records.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No workstreams found
      </div>
    )
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Job Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Jobs</TableHead>
            <TableHead>Template</TableHead>
            <TableHead>Venture</TableHead>
            <TableHead>Last Activity</TableHead>
            <TableHead className="text-right">ID</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((record) => {
            const jobName = 'jobName' in record && record.jobName
              ? (record.jobName.length > 60 ? record.jobName.substring(0, 60) + '…' : record.jobName)
              : record.id.toString().substring(0, 16) + '…'

            const delivered = 'delivered' in record ? record.delivered : false
            const lastStatus = 'lastStatus' in record && record.lastStatus ? record.lastStatus : null

            const statusText = lastStatus || (delivered ? 'DELIVERED' : 'ACTIVE')
            const statusClass = delivered
              ? 'text-green-700 dark:text-green-400 bg-green-500/10 border-green-500/30'
              : 'text-blue-700 dark:text-blue-400 bg-blue-500/10 border-blue-500/30'

            const childCount = 'childRequestCount' in record ? record.childRequestCount : 0
            const templateId = 'templateId' in record ? record.templateId : null
            const ventureId = 'ventureId' in record ? record.ventureId : null
            const lastActivity = 'lastActivity' in record && record.lastActivity
              ? formatDate(record.lastActivity as string)
              : 'blockTimestamp' in record ? formatDate(record.blockTimestamp as string) : '-'

            return (
              <TableRow key={record.id}>
                <TableCell>
                  <Link
                    href={`/workstreams/${record.id}`}
                    className="text-primary hover:text-primary hover:underline font-medium"
                  >
                    {jobName}
                  </Link>
                </TableCell>
                <TableCell>
                  <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs border ${statusClass}`}>
                    {statusText}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {childCount ?? 0}
                </TableCell>
                <TableCell>
                  {templateId ? (
                    <TruncatedId value={templateId as string} />
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell>
                  {ventureId ? (
                    <TruncatedId
                      value={ventureId as string}
                      linkTo={`/ventures/${ventureId}`}
                    />
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {lastActivity}
                </TableCell>
                <TableCell className="text-right">
                  <TruncatedId value={record.id.toString()} />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
