import { SiteHeader } from '@/components/site-header';

export default function ServicesLoading() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        subtitle="Registered services in the Jinn platform"
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Services' },
        ]}
      />

      <main className="flex-1 py-6">
        <div className="container mx-auto px-4">
          <div className="rounded-md border overflow-hidden">
            <div className="p-4 space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex items-center gap-4">
                  <div className="h-5 w-48 bg-muted animate-pulse rounded" />
                  <div className="h-5 w-16 bg-muted animate-pulse rounded" />
                  <div className="h-5 w-20 bg-muted animate-pulse rounded" />
                  <div className="flex-1" />
                  <div className="h-5 w-24 bg-muted animate-pulse rounded" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
