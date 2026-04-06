'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import Link from 'next/link'
import { TruncatedId } from '@/components/truncated-id'

interface MetadataSidebarProps {
  requestId: string
  mech?: string
  sender?: string
  blockNumber?: string
  blockTimestamp?: string
  transactionHash?: string
  delivered?: boolean
  jobDefinitionId?: string
  sourceRequestId?: string
  sourceJobDefinitionId?: string
}

export function MetadataSidebar({
  requestId,
  mech,
  sender,
  blockNumber,
  blockTimestamp,
  transactionHash,
  delivered,
  jobDefinitionId,
  sourceRequestId,
  sourceJobDefinitionId
}: MetadataSidebarProps) {
  const formatTimestamp = (timestamp?: string) => {
    if (!timestamp) return 'N/A'
    const date = new Date(Number(timestamp) * 1000)
    return date.toLocaleString()
  }

  return (
    <div className="space-y-4 sticky top-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Job Metadata</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Request ID</h4>
            <TruncatedId value={requestId} showFull={true} className="text-xs bg-muted p-2 rounded block" />
          </div>

          {delivered !== undefined && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Status</h4>
              <span className={`inline-block px-3 py-1 text-xs font-semibold rounded-full ${
                delivered 
                  ? 'bg-green-500/10 text-green-700 dark:text-green-400' 
                  : 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400'
              }`}>
                {delivered ? '✓ Delivered' : '⏳ Pending'}
              </span>
            </div>
          )}

          {mech && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Mech Address</h4>
              <TruncatedId value={mech} className="text-xs bg-muted p-2 rounded block" />
            </div>
          )}

          {sender && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Sender Address</h4>
              <TruncatedId value={sender} className="text-xs bg-muted p-2 rounded block" />
            </div>
          )}

          {blockNumber && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Block Number</h4>
              <p className="text-sm text-gray-900">{blockNumber}</p>
            </div>
          )}

          {blockTimestamp && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Timestamp</h4>
              <p className="text-xs text-gray-400">{formatTimestamp(blockTimestamp)}</p>
              <p className="text-xs text-gray-500 mt-1">Raw: {blockTimestamp}</p>
            </div>
          )}

          {transactionHash && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Transaction Hash</h4>
              <TruncatedId value={transactionHash} className="text-xs bg-muted p-2 rounded block" />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Relationships</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {jobDefinitionId && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Job Definition</h4>
              <code className="text-xs bg-muted p-2 rounded block truncate">{jobDefinitionId}</code>
            </div>
          )}

          {sourceRequestId && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Parent Request</h4>
              <TruncatedId 
                value={sourceRequestId}
                linkTo={`/requests/${sourceRequestId}`}
                className="text-xs"
              />
            </div>
          )}

          {sourceJobDefinitionId && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Parent Job Definition</h4>
              <code className="text-xs bg-muted p-2 rounded block truncate">{sourceJobDefinitionId}</code>
            </div>
          )}

          <div className="pt-2 mt-2 border-t">
            <Link 
              href={`/graph/workstream/${requestId}`}
              className="block w-full px-4 py-2 text-sm font-medium text-center text-primary bg-primary/10 border border-primary/30 rounded hover:bg-primary/20 transition-colors"
            >
              🔗 Work Graph
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

