'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useVoteData } from '@/hooks/use-vote-data'
import { NomineeStats } from './nominee-stats'
import { UserVotePanel } from './user-vote-panel'

export function VotePageContent() {
  const {
    isConnected,
    isLoading,
    refetch,
    veOlasBalance,
    userAllocatedPower,
    nomineeWeight,
    weightsSum,
    existingV3Power,
    existingV1Power,
    existingV2Power,
    existingLegacyPower,
    maxAvailableBps,
  } = useVoteData()

  return (
    <div className="space-y-6">
      {/* Header with connect button */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Vote for Jinn</h1>
          <p className="text-sm text-muted-foreground">
            Direct OLAS emissions to the Jinn v3 staking contract
          </p>
        </div>
        {isConnected && <ConnectButton showBalance={false} />}
      </div>

      {/* Nominee stats */}
      <NomineeStats nomineeWeight={nomineeWeight} weightsSum={weightsSum} />

      {/* Vote panel */}
      <UserVotePanel
        isConnected={isConnected}
        veOlasBalance={veOlasBalance}
        userAllocatedPower={userAllocatedPower}
        existingV3Power={existingV3Power}
        existingV1Power={existingV1Power}
        existingV2Power={existingV2Power}
        existingLegacyPower={existingLegacyPower}
        maxAvailableBps={maxAvailableBps}
        onVoteSuccess={refetch}
      />

      {/* Info */}
      <div className="text-xs text-muted-foreground space-y-1">
        <p>
          Voting uses the{' '}
          <a
            href="https://etherscan.io/address/0x95418b46d5566D3d1ea62C12Aea91227E566c5c1"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            VoteWeighting
          </a>{' '}
          contract on Ethereum mainnet. You need veOLAS (locked OLAS) to vote.
        </p>
        <p>
          Votes have a ~10-day cooldown. A new vote replaces your previous allocation
          for this nominee.
        </p>
      </div>
    </div>
  )
}
