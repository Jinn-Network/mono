import { SiteHeader } from '@/components/site-header'
import { Card, CardHeader, CardContent } from '@/components/ui/card'

export default function ServiceDetailLoading() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Staking', href: '/nodes/staking' },
          { label: 'Loading...' },
        ]}
      />

      <main className="flex-1 py-6">
        <div className="container mx-auto px-4 space-y-6">
          <Card>
            <CardHeader>
              <div className="h-6 w-40 bg-muted animate-pulse rounded" />
            </CardHeader>
            <CardContent className="space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="flex justify-between py-1.5">
                  <div className="h-4 w-20 bg-muted animate-pulse rounded" />
                  <div className="h-4 w-80 bg-muted animate-pulse rounded" />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="h-5 w-32 bg-muted animate-pulse rounded" />
            </CardHeader>
            <CardContent>
              <div className="h-2 w-full bg-muted animate-pulse rounded-full" />
              <div className="h-3 w-24 bg-muted animate-pulse rounded mt-2" />
            </CardContent>
          </Card>

          <div className="space-y-3">
            <div className="h-6 w-40 bg-muted animate-pulse rounded" />
            <div className="rounded-md border p-4 space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-4 w-full bg-muted animate-pulse rounded" />
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
