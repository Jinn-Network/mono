import React from 'react'
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
interface ArtifactsTableProps {
  records: SubgraphRecord[]
}

export function ArtifactsTable({ records }: ArtifactsTableProps) {
  if (records.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        No records found
      </div>
    )
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Preview</TableHead>
            <TableHead>Timestamp</TableHead>
            <TableHead>CID</TableHead>
            <TableHead>Topic</TableHead>
            <TableHead>Venture</TableHead>
            <TableHead>Workstream</TableHead>
            <TableHead>Template</TableHead>
            <TableHead>Request</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((record) => {
            const name = 'name' in record && record.name
              ? (record.name.length > 40 ? record.name.substring(0, 40) + '...' : record.name)
              : 'Unnamed'
            
            const preview = 'contentPreview' in record && record.contentPreview 
              ? (record.contentPreview.length > 60 ? record.contentPreview.substring(0, 60) + '...' : record.contentPreview)
              : '-'
            
            const timestamp = 'blockTimestamp' in record && record.blockTimestamp 
              ? formatDate(record.blockTimestamp) 
              : '-'
            
            const cid = 'cid' in record && record.cid 
              ? record.cid 
              : null
            
            const topic = 'topic' in record && record.topic 
              ? record.topic 
              : '-'
            
            const ventureId = 'ventureId' in record && record.ventureId
              ? record.ventureId
              : null

            const workstreamId = 'workstreamId' in record && record.workstreamId
              ? record.workstreamId
              : null

            const templateId = 'templateId' in record && record.templateId
              ? record.templateId
              : null

            const requestId = 'requestId' in record && record.requestId
              ? record.requestId
              : null

            return (
              <TableRow key={record.id}>
                <TableCell>
                  <Link 
                    href={`/artifacts/${record.id}`}
                    className="text-primary hover:text-primary hover:underline font-medium"
                  >
                    {name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {preview}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {timestamp}
                </TableCell>
                <TableCell>
                  {cid ? (
                    <a
                      href={`https://gateway.autonolas.tech/ipfs/${cid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:text-primary hover:underline font-mono inline-flex items-center gap-1.5"
                    >
                      <TruncatedId value={cid} copyable={false} />
                    </a>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {topic}
                </TableCell>
                <TableCell>
                  {ventureId ? (
                    <TruncatedId
                      value={ventureId}
                      linkTo={`/ventures/${ventureId}`}
                    />
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell>
                  {workstreamId ? (
                    <TruncatedId
                      value={workstreamId}
                      linkTo={`/workstreams/${workstreamId}`}
                    />
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell>
                  {templateId ? (
                    <TruncatedId value={templateId} />
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell>
                  {requestId ? (
                    <TruncatedId
                      value={requestId}
                      linkTo={`/requests/${requestId}`}
                    />
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

