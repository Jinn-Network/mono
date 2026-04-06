import { SiteHeader } from '@/components/site-header';
import { Card, CardContent } from '@/components/ui/card';

export default function ServiceLoading() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Services', href: '/services' },
          { label: 'Loading...' },
        ]}
      />

      <main className="flex-1 py-6">
        <div className="container mx-auto px-4">
          <div className="space-y-6">
            <div className="space-y-2">
              <div className="h-8 w-64 bg-muted animate-pulse rounded" />
              <div className="h-5 w-96 bg-muted animate-pulse rounded" />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <Card key={i}>
                  <CardContent className="pt-6">
                    <div className="h-8 w-16 bg-muted animate-pulse rounded mb-2" />
                    <div className="h-4 w-24 bg-muted animate-pulse rounded" />
                  </CardContent>
                </Card>
              ))}
            </div>
            <Card>
              <CardContent className="pt-6">
                <div className="h-48 bg-muted/20 animate-pulse rounded" />
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
