'use client'

import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatUnits } from 'viem'
import { JINN_V3_STAKING_CONTRACT, VOTE_WEIGHTING_ADDRESS } from '@/lib/vote/constants'

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function formatVeOlas(value: bigint): string {
  return parseFloat(formatUnits(value, 18)).toFixed(2)
}

export function NomineeStats({
  nomineeWeight,
  weightsSum,
}: {
  nomineeWeight: bigint | undefined
  weightsSum: bigint | undefined
}) {
  const relativePercent =
    nomineeWeight && weightsSum && weightsSum > BigInt(0)
      ? (Number(nomineeWeight) * 100) / Number(weightsSum)
      : 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Jinn v3 Nominee</CardTitle>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="font-mono text-xs">
            <a
              href={`https://basescan.org/address/${JINN_V3_STAKING_CONTRACT}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              {truncateAddress(JINN_V3_STAKING_CONTRACT)}
            </a>
          </Badge>
          <span>on Base</span>
          <span className="text-muted-foreground/50">|</span>
          <a
            href={`https://etherscan.io/address/${VOTE_WEIGHTING_ADDRESS}#writeContract`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            VoteWeighting
          </a>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-2xl font-bold tabular-nums">
              {nomineeWeight !== undefined ? formatVeOlas(nomineeWeight) : '--'}
            </div>
            <div className="text-xs text-muted-foreground">Nominee Weight (veOLAS)</div>
          </div>
          <div>
            <div className="text-2xl font-bold tabular-nums">
              {relativePercent > 0 ? `${relativePercent.toFixed(2)}%` : '--'}
            </div>
            <div className="text-xs text-muted-foreground">Relative Weight</div>
          </div>
          <div>
            <div className="text-2xl font-bold tabular-nums">
              {weightsSum !== undefined ? formatVeOlas(weightsSum) : '--'}
            </div>
            <div className="text-xs text-muted-foreground">Total Weights</div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
