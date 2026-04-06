import Link from 'next/link'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { formatDate } from '@/lib/utils'
import type { StakingDelivery, StakingRequest } from '@/lib/staking/queries'

function truncateHash(hash: string): string {
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`
}

export function DeliveriesTable({ deliveries }: { deliveries: StakingDelivery[] }) {
  if (deliveries.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No deliveries found</p>
  }

  return (
    <div className="rounded-md border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Request ID</TableHead>
            <TableHead>Timestamp</TableHead>
            <TableHead>Delivery Rate</TableHead>
            <TableHead>TX Hash</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {deliveries.map((d) => (
            <TableRow key={d.id}>
              <TableCell className="font-mono text-xs">
                <Link href={`/requests/${d.requestId}`} className="text-primary hover:underline">
                  {truncateHash(d.requestId)}
                </Link>
              </TableCell>
              <TableCell className="text-xs">{formatDate(d.blockTimestamp)}</TableCell>
              <TableCell className="text-xs">{d.deliveryRate}</TableCell>
              <TableCell className="font-mono text-xs">
                <a
                  href={`https://basescan.org/tx/${d.transactionHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {truncateHash(d.transactionHash)}
                </a>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function RequestsTable({ requests }: { requests: StakingRequest[] }) {
  if (requests.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No requests found</p>
  }

  return (
    <div className="rounded-md border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Request ID</TableHead>
            <TableHead>Job Name</TableHead>
            <TableHead>Timestamp</TableHead>
            <TableHead>Delivered</TableHead>
            <TableHead>TX Hash</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {requests.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-mono text-xs">
                <Link href={`/requests/${r.id}`} className="text-primary hover:underline">
                  {truncateHash(r.id)}
                </Link>
              </TableCell>
              <TableCell className="text-xs">{r.jobName || '-'}</TableCell>
              <TableCell className="text-xs">{formatDate(r.blockTimestamp)}</TableCell>
              <TableCell className="text-xs">
                {r.delivered ? (
                  <span className="text-green-500">Yes</span>
                ) : (
                  <span className="text-muted-foreground">No</span>
                )}
              </TableCell>
              <TableCell className="font-mono text-xs">
                <a
                  href={`https://basescan.org/tx/${r.transactionHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {truncateHash(r.transactionHash)}
                </a>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
