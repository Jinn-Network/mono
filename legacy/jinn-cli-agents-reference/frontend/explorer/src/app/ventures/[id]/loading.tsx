import { SiteHeader } from '@/components/site-header';

export default function VentureDetailLoading() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Ventures', href: '/ventures' },
          { label: 'Loading...' }
        ]}
      />

      <main className="flex-1 py-6 flex flex-col min-h-0">
        <div className="container mx-auto px-4 flex-1 flex flex-col min-h-0">
          <div className="space-y-6">
            <div className="h-10 w-64 animate-pulse rounded bg-muted" />
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[500px]">
              <div className="lg:col-span-2 bg-muted/20 animate-pulse rounded-xl" />
              <div className="lg:col-span-1 bg-muted/20 animate-pulse rounded-xl" />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
