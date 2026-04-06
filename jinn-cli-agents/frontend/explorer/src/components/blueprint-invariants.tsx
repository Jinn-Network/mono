'use client'

import { useMemo } from 'react'
import { parseInvariants } from '@/lib/invariant-utils'
import {
  InvariantCard,
  matchInvariantsWithMeasurements,
  type Invariant,
  type LegacyInvariant,
  type InvariantWithMeasurementDisplay,
} from '@jinn/shared-ui'

interface Artifact {
  id: string
  topic?: string
  name?: string
  cid?: string
  contentPreview?: string
}

interface BlueprintInvariantsProps {
  /** The parsed blueprint content (already JSON parsed) */
  blueprintParsed: unknown
  /** All artifacts for this request - will filter for MEASUREMENT topic */
  artifacts: Artifact[]
}

/**
 * Renders blueprint invariants with their measurement status.
 * Matches invariants from the blueprint with MEASUREMENT artifacts.
 */
export function BlueprintInvariants({ blueprintParsed, artifacts }: BlueprintInvariantsProps) {
  // Parse invariants from blueprint
  const parsedInvariants = useMemo(() => {
    return parseInvariants(blueprintParsed)
  }, [blueprintParsed])

  // Match invariants with measurements from artifacts
  const matchedInvariants = useMemo<InvariantWithMeasurementDisplay[]>(() => {
    if (parsedInvariants.length === 0) return []

    // Filter for MEASUREMENT artifacts
    const measurementArtifacts = artifacts.filter(a => a.topic === 'MEASUREMENT')

    if (measurementArtifacts.length === 0) {
      // No measurements yet - return invariants without measurements
      return parsedInvariants.map(inv => ({
        id: inv.id,
        invariant: inv,
        text: '',
        measurement: undefined,
        status: 'unknown' as const,
      }))
    }

    // Match invariants with measurements
    return matchInvariantsWithMeasurements(parsedInvariants, measurementArtifacts)
  }, [parsedInvariants, artifacts])

  if (matchedInvariants.length === 0) {
    return null
  }

  return (
    <div className="space-y-4">
      {matchedInvariants.map((item) => (
        <InvariantCard
          key={item.id}
          invariant={item.invariant}
          measurement={item.measurement}
          status={item.status}
        />
      ))}
    </div>
  )
}
