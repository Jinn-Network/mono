'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import ReactMarkdown from 'react-markdown'
import { parseInvariants } from '@/lib/invariant-utils'
import { InvariantCard, type Invariant, type LegacyInvariant } from '@jinn/shared-ui'

interface JobDefinition {
  id: string
  name: string
  enabledTools?: string[]
  blueprint?: string
  promptContent?: string
}

interface BlueprintToolsProps {
  jobDefinition: JobDefinition
}

export function JobDefinitionBlueprintTools({ jobDefinition }: BlueprintToolsProps) {
  const blueprintContent = jobDefinition.blueprint || jobDefinition.promptContent || ''

  // Try to parse as JSON to check if it's structured
  let blueprintRendering = null
  try {
    const parsed = JSON.parse(blueprintContent)

    // Check for invariants (new schema) or assertions (legacy schema)
    const items = parseInvariants(parsed)
    if (items.length > 0) {
      blueprintRendering = (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {items.map((item, idx) => (
            <InvariantCard
              key={item.id || idx}
              invariant={item as Invariant | LegacyInvariant}
            />
          ))}
        </div>
      )
    } else {
      // Otherwise render as markdown
      blueprintRendering = (
        <div className="prose prose-sm max-w-none bg-muted p-4 rounded border">
          <ReactMarkdown>{typeof blueprintContent === 'string' ? blueprintContent : JSON.stringify(parsed, null, 2)}</ReactMarkdown>
        </div>
      )
    }
  } catch {
    // If not JSON, render as markdown
    blueprintRendering = (
      <div className="prose prose-sm max-w-none bg-muted p-4 rounded border">
        <ReactMarkdown>{blueprintContent}</ReactMarkdown>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Blueprint Card */}
      <Card>
        <CardHeader>
          <CardTitle>Blueprint</CardTitle>
        </CardHeader>
        <CardContent>
          {blueprintContent ? (
            blueprintRendering
          ) : (
            <div className="text-gray-500">[No blueprint content available]</div>
          )}
        </CardContent>
      </Card>

      {/* Enabled Tools */}
      {jobDefinition.enabledTools && jobDefinition.enabledTools.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Enabled Tools</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {jobDefinition.enabledTools.map((tool, index) => (
                <Badge key={index} variant="outline" className="bg-primary/10 text-primary border-primary/30">
                  {tool}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
