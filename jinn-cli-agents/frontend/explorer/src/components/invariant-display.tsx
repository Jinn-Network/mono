'use client'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  type InvariantItem,
  type Invariant,
  isNewInvariant,
  getLegacyInvariantText,
  renderInvariantForDisplay,
} from '@/lib/invariant-utils'
import {
  InvariantCard,
  type LegacyInvariant,
} from '@jinn/shared-ui'

interface InvariantDisplayProps {
  items: InvariantItem[]
  /** Default tab to show (default: 'blueprint') */
  defaultTab?: 'raw' | 'blueprint' | 'rendered'
}

/**
 * Display invariants with three-tab view:
 * - Raw: Show raw JSON
 * - Blueprint: Structured view with type badges, metrics, thresholds
 * - Rendered: Natural language prose (what the agent sees)
 */
export function InvariantDisplay({ items, defaultTab = 'blueprint' }: InvariantDisplayProps) {
  if (items.length === 0) {
    return <div className="text-gray-500 text-sm">No invariants defined</div>
  }

  return (
    <Tabs defaultValue={defaultTab} className="w-full">
      <TabsList className="mb-4">
        <TabsTrigger value="blueprint">Blueprint</TabsTrigger>
        <TabsTrigger value="rendered">Rendered</TabsTrigger>
        <TabsTrigger value="raw">Raw</TabsTrigger>
      </TabsList>

      {/* Blueprint Tab - Structured view using shared components */}
      <TabsContent value="blueprint" className="mt-0">
        <div className="space-y-3">
          {items.map((item, idx) => (
            <InvariantCard
              key={item.id || idx}
              invariant={item as Invariant | LegacyInvariant}
            />
          ))}
        </div>
      </TabsContent>

      {/* Rendered Tab - Natural language */}
      <TabsContent value="rendered" className="mt-0">
        <ScrollArea className="max-h-[500px] rounded-md border bg-muted/50 p-4">
          <div className="space-y-3">
            {items.map((item, idx) => {
              if (isNewInvariant(item)) {
                const prose = renderInvariantForDisplay(item)
                return (
                  <div key={item.id || idx} className="space-y-1">
                    <div className="flex items-start gap-2">
                      <span className="text-xs font-mono text-muted-foreground shrink-0">
                        {item.id}:
                      </span>
                      <span className="text-sm whitespace-pre-wrap">{prose}</span>
                    </div>
                  </div>
                )
              } else {
                const text = getLegacyInvariantText(item as LegacyInvariant)
                const legacy = item as LegacyInvariant
                return (
                  <div key={item.id || idx} className="space-y-1">
                    <div className="flex items-start gap-2">
                      <span className="text-xs font-mono text-muted-foreground shrink-0">
                        {item.id}:
                      </span>
                      <span className="text-sm">{text}</span>
                    </div>
                    {legacy.measurement && (
                      <div className="ml-6 text-xs text-muted-foreground">
                        Measurement: {legacy.measurement}
                      </div>
                    )}
                  </div>
                )
              }
            })}
          </div>
        </ScrollArea>
      </TabsContent>

      {/* Raw Tab - JSON view */}
      <TabsContent value="raw" className="mt-0">
        <ScrollArea className="max-h-[500px] rounded-md border bg-muted/50">
          <pre className="p-4 text-xs font-mono leading-relaxed">
            {JSON.stringify(items, null, 2)}
          </pre>
        </ScrollArea>
      </TabsContent>
    </Tabs>
  )
}
