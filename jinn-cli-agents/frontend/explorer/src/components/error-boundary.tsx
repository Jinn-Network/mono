'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface ErrorBoundaryProps {
  error: Error & { digest?: string }
  reset: () => void
}

export function ErrorBoundary({ error, reset }: ErrorBoundaryProps) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error('Error boundary caught:', error)
  }, [error])

  return (
    <div className="min-h-[400px] flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-red-600">Something went wrong!</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-gray-400">
            We encountered an unexpected error while loading this page.
          </p>
          
          <details className="text-sm">
            <summary className="cursor-pointer text-gray-500 hover:text-gray-400">
              Error details
            </summary>
            <pre className="mt-2 p-2 bg-gray-100 rounded text-xs overflow-auto max-h-32">
              {error.message}
            </pre>
          </details>
          
          <div className="flex gap-2">
            <Button 
              onClick={reset}
              variant="default"
              size="sm"
            >
              Try again
            </Button>
            <Button 
              onClick={() => window.location.href = '/'}
              variant="outline"
              size="sm"
            >
              Go home
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}