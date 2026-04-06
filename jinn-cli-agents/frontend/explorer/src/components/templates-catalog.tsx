'use client'

import * as React from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { 
  Dialog, 
  DialogContent, 
  DialogDescription, 
  DialogHeader, 
  DialogTitle, 
  DialogTrigger 
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ExternalLink, Play, Shield, Tag, Zap, ChevronDown, ChevronUp } from 'lucide-react'
import { TemplateExecutionForm } from './template-execution-form'

// Template type from x402-gateway
interface JobTemplate {
  templateId: string
  name: string
  description: string | null
  tags: string[]
  price: string
  priceWei: string
  outputSpecSummary: string
  enabledTools?: string[]
  inputSchema?: Record<string, unknown>
  outputSpec?: Record<string, unknown>
}

// Gateway URL - defaults to production, override with env var for local dev
const GATEWAY_URL = process.env.NEXT_PUBLIC_X402_GATEWAY_URL || 'https://x402-gateway-production.up.railway.app'

export function TemplatesCatalog() {
  const [templates, setTemplates] = React.useState<JobTemplate[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [selectedTemplate, setSelectedTemplate] = React.useState<JobTemplate | null>(null)

  React.useEffect(() => {
    async function fetchTemplates() {
      try {
        const res = await fetch(`${GATEWAY_URL}/templates`)
        if (!res.ok) throw new Error('Failed to fetch templates')
        const data = await res.json()
        setTemplates(data.templates || [])
      } catch (err) {
        // Fallback to mock data for hackathon demo
        setTemplates(MOCK_TEMPLATES)
        setError('Using demo data (gateway not available)')
      } finally {
        setLoading(false)
      }
    }
    fetchTemplates()
  }, [])

  if (loading) {
    return <TemplatesLoading />
  }

  return (
    <div className="space-y-6">
      {error && (
        <Badge variant="outline" className="text-yellow-600 border-yellow-600">
          {error}
        </Badge>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {templates.map((template) => (
          <TemplateCard 
            key={template.templateId} 
            template={template}
            onSelect={() => setSelectedTemplate(template)}
          />
        ))}
      </div>

      {templates.length === 0 && !loading && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No templates available. Seed templates using the gateway CLI.
          </CardContent>
        </Card>
      )}

      <TemplateDetailDialog 
        template={selectedTemplate} 
        onClose={() => setSelectedTemplate(null)} 
      />
    </div>
  )
}

function TemplateCard({ 
  template, 
  onSelect 
}: { 
  template: JobTemplate
  onSelect: () => void 
}) {
  return (
    <Card className="hover:border-primary/50 transition-colors cursor-pointer" onClick={onSelect}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <CardTitle className="text-lg">{template.name}</CardTitle>
        </div>
        <CardDescription className="line-clamp-2">
          {template.description || 'No description'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <Zap className="h-4 w-4 text-yellow-500" />
          <span className="font-mono">{template.price}</span>
        </div>
        
        <div className="flex flex-wrap gap-1">
          {template.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="secondary" className="text-xs">
              <Tag className="h-3 w-3 mr-1" />
              {tag}
            </Badge>
          ))}
          {template.tags.length > 3 && (
            <Badge variant="secondary" className="text-xs">
              +{template.tags.length - 3}
            </Badge>
          )}
        </div>

        <div className="text-xs text-muted-foreground">
          Output: {template.outputSpecSummary}
        </div>
      </CardContent>
    </Card>
  )
}

function TemplateDetailDialog({
  template,
  onClose
}: {
  template: JobTemplate | null
  onClose: () => void
}) {
  const [showApiDetails, setShowApiDetails] = React.useState(false)
  const [fullTemplate, setFullTemplate] = React.useState<JobTemplate | null>(null)
  const [loadingDetails, setLoadingDetails] = React.useState(false)

  // Fetch full template details (including inputSchema) when dialog opens
  React.useEffect(() => {
    if (!template) {
      setFullTemplate(null)
      return
    }

    async function fetchDetails() {
      setLoadingDetails(true)
      try {
        const res = await fetch(`${GATEWAY_URL}/templates/${template!.templateId}`)
        if (res.ok) {
          setFullTemplate(await res.json())
        } else {
          setFullTemplate(template!)
        }
      } catch {
        setFullTemplate(template!)
      } finally {
        setLoadingDetails(false)
      }
    }

    fetchDetails()
  }, [template?.templateId])

  if (!template) return null

  // Use full template if loaded, otherwise fall back to basic info
  const displayTemplate = fullTemplate || template

  const executeSnippet = `curl -X POST "${GATEWAY_URL}/templates/${template.templateId}/execute" \\
  -H "Content-Type: application/json" \\
  -d '{"input": {}}'`

  return (
    <Dialog open={!!template} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>{template.name}</DialogTitle>
          </div>
          <DialogDescription>
            {template.description || 'No description available'}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[50vh]">
          <div className="space-y-4">
            {/* Price */}
            <div>
              <h4 className="text-sm font-medium mb-1">Price</h4>
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-yellow-500" />
                <span className="font-mono text-lg">{template.price}</span>
                <span className="text-xs text-muted-foreground">
                  ({template.priceWei} wei)
                </span>
              </div>
            </div>

            {/* Tags */}
            <div>
              <h4 className="text-sm font-medium mb-1">Tags</h4>
              <div className="flex flex-wrap gap-1">
                {template.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Output Contract */}
            <div>
              <h4 className="text-sm font-medium mb-1">Output Contract</h4>
              <p className="text-sm text-muted-foreground">
                {template.outputSpecSummary}
              </p>
            </div>

            {/* Execution Form */}
            <div className="pt-2 border-t">
              <h4 className="text-sm font-medium mb-3">Execute Template</h4>
              {loadingDetails ? (
                <div className="space-y-3">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : (
                <TemplateExecutionForm template={displayTemplate} />
              )}
            </div>

            {/* Collapsible API Details */}
            <div className="pt-2 border-t">
              <button
                type="button"
                onClick={() => setShowApiDetails(!showApiDetails)}
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {showApiDetails ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
                API Details
              </button>

              {showApiDetails && (
                <div className="mt-3 space-y-3">
                  {/* Execute Snippet */}
                  <div>
                    <h4 className="text-xs font-medium mb-1 text-muted-foreground">cURL Example</h4>
                    <pre className="bg-muted p-3 rounded-md text-xs overflow-x-auto">
                      {executeSnippet}
                    </pre>
                  </div>

                  {/* Input Schema (if available) */}
                  {displayTemplate.inputSchema && Object.keys(displayTemplate.inputSchema).length > 0 && (
                    <div>
                      <h4 className="text-xs font-medium mb-1 text-muted-foreground">Input Schema</h4>
                      <pre className="bg-muted p-3 rounded-md text-xs overflow-x-auto max-h-40">
                        {JSON.stringify(displayTemplate.inputSchema, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button asChild variant="secondary">
            <a
              href={`${GATEWAY_URL}/templates/${template.templateId}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              View in Gateway
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TemplatesLoading() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-4 w-full mt-2" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-4 w-20" />
              <div className="flex gap-1 mt-3">
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-5 w-16" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

// Mock data for hackathon demo when gateway is not available
const MOCK_TEMPLATES: JobTemplate[] = [
  {
    templateId: 'ethereum-daily-research',
    name: 'Ethereum Daily Research',
    description: 'Generates a comprehensive daily brief on Ethereum on-chain activity including market metrics, protocol deep dives, and narrative synthesis.',
    tags: ['ethereum', 'research', 'defi', 'daily'],
    price: '0.0010 ETH',
    priceWei: '1000000000000000',
    outputSpecSummary: 'reportMarkdown*, executiveSummary*, marketMetrics + 1 more',
  },
  {
    templateId: 'x402-ecosystem-research',
    name: 'x402 Ecosystem Research',
    description: 'Researches and catalogs the x402 agent ecosystem including services, agents, and integrations.',
    tags: ['x402', 'research', 'ecosystem', 'agents'],
    price: '0.0005 ETH',
    priceWei: '500000000000000',
    outputSpecSummary: 'summary*, servicesFound, agentsFound + 1 more',
  },
  {
    templateId: 'prediction-market-analysis',
    name: 'Prediction Market Analysis',
    description: 'Analyzes prediction market opportunities with EV calculations, risk assessment, and trade recommendations.',
    tags: ['prediction-markets', 'trading', 'analysis', 'polymarket'],
    price: '0.0020 ETH',
    priceWei: '2000000000000000',
    outputSpecSummary: 'recommendations*, marketOverview* + 1 more',
  },
]

