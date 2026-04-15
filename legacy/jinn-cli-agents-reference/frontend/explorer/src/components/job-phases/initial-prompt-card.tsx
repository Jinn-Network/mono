'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useEffect, useState } from 'react'

interface InitialPromptCardProps {
  requestId: string
  jobName?: string
  ipfsHash?: string
  enabledTools?: string[]
}

interface BlueprintData {
  blueprint?: string
  // Legacy structured fields for backward compatibility
  objective?: string
  context?: string
  acceptanceCriteria?: string
  deliverables?: string
  constraints?: string
}

export function InitialPromptCard({ jobName, ipfsHash, enabledTools }: InitialPromptCardProps) {
  const [blueprintData, setBlueprintData] = useState<BlueprintData | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!ipfsHash) return

    const fetchBlueprint = async () => {
      try {
        setLoading(true)
        const response = await fetch(`https://gateway.autonolas.tech/ipfs/${ipfsHash}`)
        if (response.ok) {
          const data = await response.json()
          setBlueprintData(data)
        }
      } catch (error) {
        console.error('Error fetching blueprint:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchBlueprint()
  }, [ipfsHash])

  return (
    <Card className="border-primary/30 bg-primary/10/50">
      <CardHeader>
        <CardTitle className="text-xl flex items-center gap-2">
          📝 Initial Blueprint
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {jobName && (
          <div>
            <h3 className="text-2xl font-bold text-gray-900 mb-2">{jobName}</h3>
          </div>
        )}

        {loading && (
          <div className="text-sm text-gray-500">Loading blueprint details...</div>
        )}

        {blueprintData && (
          <div className="space-y-3">
            {/* Show full blueprint if available (new architecture) */}
            {blueprintData.blueprint && (
              <div>
                <h4 className="text-sm font-semibold text-gray-400 mb-1">Blueprint</h4>
                <div className="text-sm text-gray-900 bg-card p-3 rounded border whitespace-pre-wrap font-mono text-xs">
                  {blueprintData.blueprint}
                </div>
              </div>
            )}

            {/* Otherwise show legacy structured fields */}
            {!blueprintData.blueprint && (
              <>
                {blueprintData.objective && (
                  <div>
                    <h4 className="text-sm font-semibold text-gray-400 mb-1">Objective</h4>
                    <p className="text-sm text-gray-900 bg-card p-3 rounded border">{blueprintData.objective}</p>
                  </div>
                )}

                {blueprintData.context && (
                  <div>
                    <h4 className="text-sm font-semibold text-gray-400 mb-1">Context</h4>
                    <p className="text-sm text-gray-400 bg-card p-3 rounded border whitespace-pre-wrap">{blueprintData.context}</p>
                  </div>
                )}

                {blueprintData.acceptanceCriteria && (
                  <div>
                    <h4 className="text-sm font-semibold text-gray-400 mb-1">Acceptance Criteria</h4>
                    <p className="text-sm text-gray-400 bg-card p-3 rounded border whitespace-pre-wrap">{blueprintData.acceptanceCriteria}</p>
                  </div>
                )}

                {blueprintData.deliverables && (
                  <div>
                    <h4 className="text-sm font-semibold text-gray-400 mb-1">Deliverables</h4>
                    <p className="text-sm text-gray-400 bg-card p-3 rounded border">{blueprintData.deliverables}</p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {enabledTools && enabledTools.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-gray-400 mb-2">Enabled Tools</h4>
            <div className="flex flex-wrap gap-2">
              {enabledTools.map((tool, index) => (
                <Badge key={index} variant="secondary" className="bg-primary/20 text-primary">
                  {tool}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {!loading && !blueprintData && ipfsHash && (
          <div className="text-sm text-gray-500">
            Blueprint details not available from IPFS
          </div>
        )}
      </CardContent>
    </Card>
  )
}

