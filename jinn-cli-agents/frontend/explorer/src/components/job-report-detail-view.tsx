'use client'

// useState removed as it was not being used
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { MarkdownField } from '@/components/markdown-field'
import { IdLink } from '@/components/id-link'
import { DbRecord } from '@/lib/types'

interface JobReportDetailViewProps {
  record: DbRecord
}

function humanizeFieldName(fieldName: string): string {
  return fieldName
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function ObjectViewer({ data }: { data: unknown }) {
  if (data === null || data === undefined) {
    return <span className="text-gray-400 italic">null</span>
  }

  if (typeof data === 'object') {
    return (
      <div className="space-y-2">
        <pre className="text-sm bg-muted p-3 rounded overflow-auto max-h-96">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    )
  }

  return <span>{String(data)}</span>
}

function ResponseTextCard({ responseText }: { responseText: unknown }) {
  if (!responseText || !Array.isArray(responseText)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Response Text</CardTitle>
        </CardHeader>
        <CardContent>
          <span className="text-gray-400 italic">No response data available</span>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Response Text</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {(responseText as unknown[]).map((item: unknown, index: number) => {
                        // Extract thought content from response structure
            const extractThought = (item: unknown) => {
              try {
                // If item is a string that looks like JSON, try to parse it
                if (typeof item === 'string' && item.trim().startsWith('[')) {
                  const parsed = JSON.parse(item)
                  if (Array.isArray(parsed) && parsed.length > 0) {
                    item = parsed
                  } else {
                    return item.substring(0, 100) + (item.length > 100 ? '...' : '')
                  }
                } else if (typeof item === 'string') {
                  return item.substring(0, 100) + (item.length > 100 ? '...' : '')
                }

                // Handle array of response objects (most common case)
                if (Array.isArray(item) && item.length > 0) {
                  // Process all items in the array and find the best content
                  for (const responseItem of item) {
                    const respObj = responseItem as Record<string, unknown>
                    // Check for Gemini API response structure with thought content
                    const candidates = respObj.candidates as { content?: { parts?: { text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }[] } }[] | undefined
                    if (candidates?.[0]?.content?.parts?.[0]?.text) {
                      const fullText = candidates[0].content.parts[0].text
                      return fullText.trim()
                    }

                    // Check for parts array directly
                    const parts = respObj.parts as { text?: string }[] | undefined
                    if (parts?.[0]?.text) {
                      const fullText = parts[0].text
                      return fullText.trim()
                    }

                    // Check for function call responses - show what function was called
                    if (candidates?.[0]?.content?.parts?.[0]?.functionCall?.name) {
                      const funcName = candidates[0].content.parts[0].functionCall.name
                      const args = candidates[0].content.parts[0].functionCall.args
                      return `Function Call: ${funcName}(${Object.keys(args || {}).join(', ')})`
                    }

                    // Check for thought signature and function calls (step responses)
                    if (candidates?.[0]?.content?.parts) {
                      const parts = candidates[0].content.parts
                      // Look for function calls in parts
                      const functionCalls = parts.filter((part: { functionCall?: unknown }) => part.functionCall)
                      if (functionCalls.length > 0) {
                        const callNames = functionCalls.map((part: { functionCall?: { name: string } }) => part.functionCall?.name).filter(Boolean)
                        return `Function Calls: ${callNames.join(', ')}`
                      }
                    }

                    // Try to find meaningful text in the object
                    if (responseItem && typeof responseItem === 'object') {
                      const textFields = ['text', 'content', 'thought', 'message']
                      for (const field of textFields) {
                        if (respObj[field] && typeof respObj[field] === 'string') {
                          return (respObj[field] as string).trim()
                        }
                      }
                    }
                  }
                }

                // Handle single object
                if (item && typeof item === 'object') {
                  // Check for Gemini API response structure
                  const itemObj = item as Record<string, unknown>
                  const candidates = itemObj.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined
                  if (candidates?.[0]?.content?.parts?.[0]?.text) {
                    const fullText = candidates[0].content.parts[0].text
                    return fullText.trim()
                  }

                  // Check other fields
                  const textFields = ['text', 'content', 'thought', 'message']
                  for (const field of textFields) {
                    if (itemObj[field] && typeof itemObj[field] === 'string') {
                      return (itemObj[field] as string).trim()
                    }
                  }
                }

                return `Response ${index + 1}`
              } catch {
                // If parsing fails, return a truncated version of the original string
                if (typeof item === 'string') {
                  return item.substring(0, 100) + (item.length > 100 ? '...' : '')
                }
                return `Response ${index + 1}`
              }
            }
            
            const thought = extractThought(item)

            return (
              <div key={index}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <MarkdownField content={thought} />
                  </div>
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="outline" size="sm" className="text-xs shrink-0">
                        View Details
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
                      <DialogHeader>
                        <DialogTitle>Response {index + 1} Details</DialogTitle>
                      </DialogHeader>
                      <ObjectViewer data={item} />
                    </DialogContent>
                  </Dialog>
                </div>
                {index < responseText.length - 1 && (
                  <div className="border-t border dark:border-gray-700 my-4" />
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

export function JobReportDetailView({ record }: JobReportDetailViewProps) {
  if (!record) {
    return null
  }

  // Extract the main content fields
  const { 
    final_output, 
    response_text, 
    request_text, 
    job_id,
    worker_id,
    status,
    duration_ms,
    total_tokens,
    tools_called,
    error_message,
    error_type,
    raw_telemetry,
    created_at,
    source_artifact_id,
    ...otherFields 
  } = record

  // Fields to hide from the detail view
  const hiddenFields = ['id']
  
  // Prepare details for the right sidebar
  const detailFields = {
    job_id,
    source_artifact_id,
    worker_id,
    status,
    duration_ms,
    total_tokens,
    tools_called,
    error_message,
    error_type,
    raw_telemetry,
    created_at,
    ...otherFields
  }

  // Filter out hidden fields and null/undefined values
  const visibleDetailFields = Object.entries(detailFields).filter(([key, value]) => 
    !hiddenFields.includes(key) && value !== null && value !== undefined
  )

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      {/* Main Content Area - spans 3 columns */}
      <div className="lg:col-span-3 space-y-6">
        {/* Final Output Card - Top Priority */}
        {final_output && (
          <Card>
            <CardHeader>
              <CardTitle>Final Output</CardTitle>
            </CardHeader>
            <CardContent>
              <MarkdownField content={final_output} />
            </CardContent>
          </Card>
        )}

        {/* Response Text Card */}
        <ResponseTextCard responseText={response_text} />

        {/* Request Text Card */}
        {request_text && (
          <Card>
            <CardHeader>
              <CardTitle>Request Text</CardTitle>
            </CardHeader>
            <CardContent>
              {Array.isArray(request_text) ? (
                <div className="space-y-4">
                  {(request_text as unknown[]).map((req: unknown, index: number) => (
                    <div key={index} className="border rounded p-3">
                      <h4 className="font-medium mb-2 text-sm text-gray-400">
                        Request {index + 1}
                      </h4>
                      <MarkdownField 
                        content={typeof req === 'string' ? req : JSON.stringify(req, null, 2)} 
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <MarkdownField 
                  content={typeof request_text === 'string' ? request_text : JSON.stringify(request_text, null, 2)} 
                />
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Details Sidebar - Right aligned */}
      <div className="lg:col-span-1">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {visibleDetailFields.map(([key, value]) => (
                <div key={key} className="border-b border-gray-100 pb-3 last:border-b-0 last:pb-0">
                  <div className="font-medium text-gray-900 text-sm mb-1" title={`Field: ${key}`}>
                    {humanizeFieldName(key)}:
                  </div>
                  <div className="text-sm">
                    {/* Special handling for job_id */}
                    {key === 'job_id' && value ? (
                      <IdLink id={value} fieldName="job_id" />
                    ) : /* Special handling for source_artifact_id */
                    key === 'source_artifact_id' && value ? (
                      <IdLink id={value} fieldName="artifact_id" />
                    ) : /* Special handling for different data types */
                    typeof value === 'boolean' ? (
                      <span className={`inline-flex items-center px-2 py-1 rounded text-xs ${
                        value 
                          ? 'text-green-700 dark:text-green-400 bg-green-500/10 border border-green-500/30' 
                          : 'text-red-700 dark:text-red-400 bg-red-500/10 border border-red-500/30'
                      }`}>
                        {value ? '✓ true' : '✗ false'}
                      </span>
                    ) : typeof value === 'number' ? (
                      <span className="font-mono">
                        {key === 'duration_ms' ? `${value.toLocaleString()} ms` : value.toLocaleString()}
                      </span>
                    ) : typeof value === 'object' && value !== null ? (
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="outline" size="sm" className="text-xs">
                            View {Array.isArray(value) ? 'Array' : 'Object'}
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
                          <DialogHeader>
                            <DialogTitle>{humanizeFieldName(key)}</DialogTitle>
                          </DialogHeader>
                          <ObjectViewer data={value} />
                        </DialogContent>
                      </Dialog>
                    ) : (
                      <span className="break-words">
                        {String(value)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}