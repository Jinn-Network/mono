'use client'

import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'

interface MarkdownFieldProps {
  content: string
  title?: string
  className?: string
  showRawToggle?: boolean
}

// Function to clean up and preprocess content for better markdown rendering
function preprocessContent(content: string): string {
  let cleaned = content;
  
  // Remove excessive backslashes and escape sequences
  cleaned = cleaned.replace(/\\{4,}/g, '\\'); // Replace 4+ backslashes with single
  cleaned = cleaned.replace(/\\{2}/g, ''); // Replace double backslashes
  cleaned = cleaned.replace(/\\\"/g, '"'); // Replace escaped quotes
  cleaned = cleaned.replace(/\\\'/g, "'"); // Replace escaped single quotes
  cleaned = cleaned.replace(/\\\//g, '/'); // Replace escaped forward slashes
  cleaned = cleaned.replace(/\\n/g, '\n'); // Replace literal \n with actual newlines
  cleaned = cleaned.replace(/\\t/g, '    '); // Replace literal \t with spaces
  
  // Fix JSON-like structures that got mangled
  cleaned = cleaned.replace(/\\\{/g, '{');
  cleaned = cleaned.replace(/\\\}/g, '}');
  cleaned = cleaned.replace(/\\\[/g, '[');
  cleaned = cleaned.replace(/\\\]/g, ']');
  
  // Clean up excessive whitespace but preserve intentional formatting
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n'); // Max 2 consecutive newlines
  cleaned = cleaned.replace(/[ \t]{3,}/g, '  '); // Max 2 consecutive spaces
  
  // Fix malformed markdown that might have been escaped
  cleaned = cleaned.replace(/\\\*/g, '*'); // Fix escaped asterisks
  cleaned = cleaned.replace(/\\\#/g, '#'); // Fix escaped hashes
  cleaned = cleaned.replace(/\\\-/g, '-'); // Fix escaped dashes
  cleaned = cleaned.replace(/\\\`/g, '`'); // Fix escaped backticks
  
  return cleaned.trim();
}

export function MarkdownField({ content, title, className = "", showRawToggle = true }: MarkdownFieldProps) {
  const [showRaw, setShowRaw] = useState(false)

  if (!content || content.trim() === '') {
    return <span className="text-muted-foreground italic text-sm">Empty content</span>
  }

  const cleanedContent = preprocessContent(content);

  return (
    <div className={`space-y-3 ${className}`}>
      {title && (
        <div className="flex items-center justify-between">
          <h4 className="font-medium text-foreground text-sm">{title}</h4>
          {showRawToggle && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRaw(!showRaw)}
              className="text-xs px-2 py-1 h-auto"
            >
              {showRaw ? 'Show Formatted' : 'Show Raw'}
            </Button>
          )}
        </div>
      )}

      {!title && showRawToggle && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRaw(!showRaw)}
            className="text-xs px-2 py-1 h-auto"
          >
            {showRaw ? 'Show Formatted' : 'Show Raw'}
          </Button>
        </div>
      )}

      <div className="border rounded-lg overflow-hidden">
        {showRaw ? (
          <div className="bg-muted p-4">
            <pre className="text-sm text-foreground/80 whitespace-pre-wrap font-mono break-words">
              {content}
            </pre>
          </div>
        ) : (
          <div className="bg-card p-4 prose prose-sm max-w-none dark:prose-invert">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // Customize markdown rendering - use theme-aware colors
                h1: ({ children }) => <h1 className="text-lg font-bold text-foreground mt-0 mb-3">{children}</h1>,
                h2: ({ children }) => <h2 className="text-base font-semibold text-foreground mt-4 mb-2">{children}</h2>,
                h3: ({ children }) => <h3 className="text-sm font-medium text-foreground mt-3 mb-2">{children}</h3>,
                p: ({ children }) => <p className="text-sm text-foreground/90 mb-2 leading-relaxed">{children}</p>,
                ul: ({ children }) => <ul className="text-sm text-foreground/90 list-disc pl-5 mb-2 space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="text-sm text-foreground/90 list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
                li: ({ children }) => <li className="leading-relaxed text-foreground/90">{children}</li>,
                code: ({ children, className }) => {
                  const isInline = !className
                  if (isInline) {
                    return <code className="bg-muted text-foreground px-1 py-0.5 rounded text-xs font-mono">{children}</code>
                  }
                  return (
                    <pre className="bg-muted text-foreground p-3 rounded text-xs font-mono overflow-auto">
                      <code>{children}</code>
                    </pre>
                  )
                },
                blockquote: ({ children }) => (
                  <blockquote className="border-l-4 border-primary/30 bg-primary/10 pl-4 py-2 my-3 text-sm text-primary">
                    {children}
                  </blockquote>
                ),
                strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
                em: ({ children }) => <em className="italic text-foreground/80">{children}</em>,
                a: ({ href, children }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:text-primary underline"
                  >
                    {children}
                  </a>
                ),
                // Table support (GFM)
                table: ({ children }) => (
                  <div className="overflow-x-auto my-4">
                    <table className="min-w-full border-collapse border border-border text-sm">
                      {children}
                    </table>
                  </div>
                ),
                thead: ({ children }) => (
                  <thead className="bg-muted">{children}</thead>
                ),
                tbody: ({ children }) => (
                  <tbody className="divide-y divide-border">{children}</tbody>
                ),
                tr: ({ children }) => (
                  <tr className="hover:bg-muted/50">{children}</tr>
                ),
                th: ({ children }) => (
                  <th className="px-3 py-2 text-left font-semibold text-foreground border border-border">{children}</th>
                ),
                td: ({ children }) => (
                  <td className="px-3 py-2 text-foreground border border-border">{children}</td>
                ),
              }}
            >
              {cleanedContent}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}