'use client'

import * as React from 'react'
import Link from 'next/link'
import { Input } from '@/components/ui/input'
import { AutoExpandTextarea } from '@/components/ui/auto-expand-textarea'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Loader2, CheckCircle, AlertCircle, ExternalLink } from 'lucide-react'

// Gateway URL - defaults to production, override with env var for local dev
const GATEWAY_URL = process.env.NEXT_PUBLIC_X402_GATEWAY_URL || 'https://x402-gateway-production.up.railway.app'

// JSON Schema property definition
interface SchemaProperty {
  type: string
  description?: string
  enum?: string[]
  default?: string | number | boolean
}

// Input schema structure (matches JSON Schema format)
// Using Record<string, unknown> for compatibility with parent component
interface InputSchema {
  type?: string
  properties?: Record<string, SchemaProperty>
  required?: string[]
}

// Template type (subset needed for form)
interface JobTemplate {
  templateId: string
  name: string
  inputSchema?: Record<string, unknown>
  defaultCyclic?: boolean
}

// Execute response from gateway
interface ExecuteResponse {
  requestId: string
  jobDefinitionId: string
  templateId: string
  statusUrl: string
  resultUrl: string
  explorerUrl: string
}

interface TemplateExecutionFormProps {
  template: JobTemplate
  onSuccess?: (response: ExecuteResponse) => void
}

export function TemplateExecutionForm({ template, onSuccess }: TemplateExecutionFormProps) {
  const [formData, setFormData] = React.useState<Record<string, string>>({})
  const [cyclic, setCyclic] = React.useState(template.defaultCyclic ?? false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<ExecuteResponse | null>(null)

  // Cast the loose Record type to our schema structure
  const schema = template.inputSchema as InputSchema | undefined
  const properties = (schema?.properties || {}) as Record<string, SchemaProperty>
  const required = schema?.required || []

  // Initialize form with default values (skip $provision sentinels - leave blank to trigger auto-provisioning)
  React.useEffect(() => {
    const defaults: Record<string, string> = {}
    Object.entries(properties).forEach(([key, prop]) => {
      if (prop.default !== undefined && prop.default !== '$provision') {
        defaults[key] = String(prop.default)
      }
    })
    setFormData(defaults)
  }, [template.templateId])

  const handleChange = (key: string, value: string) => {
    setFormData((prev) => ({ ...prev, [key]: value }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setResult(null)

    // Validate required fields
    const missingFields = required.filter((field) => !formData[field]?.trim())
    if (missingFields.length > 0) {
      setError(`Missing required fields: ${missingFields.join(', ')}`)
      setLoading(false)
      return
    }

    try {
      const response = await fetch(`${GATEWAY_URL}/templates/${template.templateId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: formData, cyclic }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || `HTTP ${response.status}`)
      }

      const data: ExecuteResponse = await response.json()
      setResult(data)
      onSuccess?.(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Execution failed')
    } finally {
      setLoading(false)
    }
  }

  // If no input schema, show simple execute button
  if (!schema || Object.keys(properties).length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          This template has no input parameters.
        </p>
        <Button onClick={handleSubmit} disabled={loading}>
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Execute Template
        </Button>
        {error && <ErrorMessage message={error} />}
        {result && <SuccessMessage result={result} />}
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {Object.entries(properties).map(([key, prop]) => (
        <FormField
          key={key}
          name={key}
          property={prop}
          value={formData[key] || ''}
          onChange={(value) => handleChange(key, value)}
          required={required.includes(key)}
        />
      ))}

      <div className="flex items-center gap-2 py-2 border-t">
        <input
          type="checkbox"
          id="cyclic"
          checked={cyclic}
          onChange={(e) => setCyclic(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300"
        />
        <label htmlFor="cyclic" className="text-sm text-muted-foreground">
          Run continuously (auto-restart after completion)
        </label>
      </div>

      <div className="pt-2">
        <Button type="submit" disabled={loading} className="w-full">
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Execute Template
        </Button>
      </div>

      {error && <ErrorMessage message={error} />}
      {result && <SuccessMessage result={result} />}
    </form>
  )
}

interface FormFieldProps {
  name: string
  property: SchemaProperty
  value: string
  onChange: (value: string) => void
  required: boolean
}

function FormField({ name, property, value, onChange, required }: FormFieldProps) {
  const id = `field-${name}`
  const label = formatLabel(name)
  const hasEnum = property.enum && property.enum.length > 0

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>

      {hasEnum ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
          </SelectTrigger>
          <SelectContent>
            {property.enum!.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : property.type === 'number' ? (
        <Input
          id={id}
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={property.default ? String(property.default) : undefined}
        />
      ) : property.type === 'array' ? (
        <AutoExpandTextarea
          id={id}
          value={value}
          onChange={onChange}
          placeholder="One item per line"
        />
      ) : (
        <AutoExpandTextarea
          id={id}
          value={value}
          onChange={onChange}
          placeholder={property.default === '$provision' ? 'Leave blank to auto-provision' : (property.default ? String(property.default) : undefined)}
        />
      )}

      {property.description && (
        <p className="text-xs text-muted-foreground">{property.description}</p>
      )}
      {property.default === '$provision' && (
        <p className="text-xs text-blue-600 dark:text-blue-400">
          Auto-provisioned if left blank
        </p>
      )}
    </div>
  )
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="bg-destructive/10 border border-destructive/20 rounded-md p-3 flex items-start gap-2">
      <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
      <p className="text-sm text-destructive">{message}</p>
    </div>
  )
}

function SuccessMessage({ result }: { result: ExecuteResponse }) {
  return (
    <div className="bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-md p-4 space-y-3">
      <div className="flex items-center gap-2">
        <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
        <p className="font-medium text-green-800 dark:text-green-200">
          Template executed successfully
        </p>
      </div>

      <div className="text-sm space-y-1">
        <p className="text-muted-foreground">
          Request ID:{' '}
          <code className="bg-muted px-1 py-0.5 rounded text-xs">
            {result.requestId}
          </code>
        </p>
      </div>

      <div className="flex gap-2 pt-1">
        <Button asChild variant="outline" size="sm">
          <Link href={`/requests/${result.requestId}`}>
            View Request
          </Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <a href={result.statusUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-3 w-3 mr-1" />
            Check Status
          </a>
        </Button>
      </div>
    </div>
  )
}

// Convert camelCase/snake_case to Title Case
function formatLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim()
}
