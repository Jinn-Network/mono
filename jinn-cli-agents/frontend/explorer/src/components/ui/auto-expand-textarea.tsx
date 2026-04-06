'use client'

import * as React from "react"
import { Textarea } from "./textarea"
import { cn } from "@/lib/utils"

interface AutoExpandTextareaProps extends Omit<React.ComponentProps<"textarea">, 'onChange'> {
  value: string
  onChange: (value: string) => void
}

export function AutoExpandTextarea({
  value,
  onChange,
  className,
  ...props
}: AutoExpandTextareaProps) {
  const ref = React.useRef<HTMLTextAreaElement>(null)

  // Auto-resize on value change
  React.useEffect(() => {
    const el = ref.current
    if (el) {
      // Reset height to auto to get the correct scrollHeight
      el.style.height = 'auto'
      // Set height to scrollHeight, capped at 50vh
      const maxHeight = window.innerHeight * 0.5
      el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px'
    }
  }, [value])

  return (
    <Textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn("overflow-hidden", className)}
      {...props}
    />
  )
}
