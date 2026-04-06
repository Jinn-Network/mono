'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

interface TruncatedIdProps {
  value: string | number | null | undefined
  /**
   * If provided, the ID will be rendered as a link to this path
   */
  linkTo?: string
  /**
   * Show the full ID without truncation
   */
  showFull?: boolean
  /**
   * Additional CSS classes
   */
  className?: string
  /**
   * Show copy button
   */
  copyable?: boolean
}

/**
 * Truncates an ID or address to show first 5 and last 5 meaningful characters
 * (excluding 0x prefix for addresses)
 */
function truncateId(value: string): string {
  // Handle 0x-prefixed addresses
  if (value.startsWith('0x')) {
    const withoutPrefix = value.slice(2)
    if (withoutPrefix.length <= 10) {
      return value
    }
    return `0x${withoutPrefix.slice(0, 5)}...${withoutPrefix.slice(-5)}`
  }
  
  // Handle other IDs
  if (value.length <= 10) {
    return value
  }
  
  return `${value.slice(0, 5)}...${value.slice(-5)}`
}

export function TruncatedId({ 
  value, 
  linkTo, 
  showFull = false, 
  className = '',
  copyable = true 
}: TruncatedIdProps) {
  const [copied, setCopied] = useState(false)
  
  if (!value) {
    return <span className="text-gray-400 italic">null</span>
  }
  
  const stringValue = value.toString()
  const displayValue = showFull ? stringValue : truncateId(stringValue)
  
  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    
    try {
      await navigator.clipboard.writeText(stringValue)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }
  
  const baseClasses = `font-mono text-sm inline-flex items-center gap-1.5 ${className}`
  
  const content = (
    <>
      <span className="truncate" title={stringValue}>
        {displayValue}
      </span>
      {copyable && (
        <Button
          onClick={handleCopy}
          variant="ghost"
          size="icon"
          className="h-4 w-4 p-0 hover:bg-transparent"
          title="Copy to clipboard"
          type="button"
        >
          {copied ? (
            <Check className="w-3 h-3 text-green-600" />
          ) : (
            <Copy className="w-3 h-3 text-muted-foreground hover:text-foreground transition-colors" />
          )}
        </Button>
      )}
    </>
  )
  
  if (linkTo) {
    return (
      <Link 
        href={linkTo}
        className={`${baseClasses} text-primary hover:text-primary hover:underline`}
      >
        {content}
      </Link>
    )
  }
  
  return (
    <span className={`${baseClasses} text-gray-400`}>
      {content}
    </span>
  )
}

