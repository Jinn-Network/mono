import { SiteHeader } from '@/components/site-header'
import { Card, CardHeader, CardContent } from '@/components/ui/card'

export default function StakingLoading() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        subtitle="Staked services and epoch progress"
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Staking' },
        ]}
      />

      <main className="flex-1 py-6">
        <div className="container mx-auto px-4">
          <div className="space-y-6">
            <div className="h-5 w-48 bg-muted animate-pulse rounded" />
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <Card key={i}>
                  <CardHeader className="pb-2">
                    <div className="h-5 w-3/4 bg-muted animate-pulse rounded" />
                    <div className="h-3 w-1/2 bg-muted animate-pulse rounded mt-2" />
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="h-2 w-full bg-muted animate-pulse rounded-full" />
                    <div className="h-3 w-24 bg-muted animate-pulse rounded" />
                    <div className="h-4 w-full bg-muted animate-pulse rounded" />
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
