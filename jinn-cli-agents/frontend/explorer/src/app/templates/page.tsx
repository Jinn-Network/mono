import { Metadata } from 'next';
import { Suspense } from 'react';
import { SiteHeader } from '@/components/site-header';
import { TemplatesTabs } from './templates-tabs';
import { getBlueprints, getVentureTemplates, getVentures } from '@/lib/ventures-services';

export const metadata: Metadata = {
  title: 'Templates',
  description: 'Browse workstream and venture templates in the Jinn platform',
};

export const dynamic = 'force-dynamic';

async function TemplatesList() {
  const [workstreamTemplates, ventureTemplates, ventures] = await Promise.all([
    getBlueprints(),
    getVentureTemplates(),
    getVentures(),
  ]);

  const ventureMap = new Map(ventures.map(v => [v.id, v.name]));

  return (
    <TemplatesTabs
      workstreamTemplates={workstreamTemplates}
      ventureTemplates={ventureTemplates}
      ventureMap={Object.fromEntries(ventureMap)}
    />
  );
}

function TemplatesListSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-10 w-64 bg-muted animate-pulse rounded" />
      <div className="rounded-md border">
        <div className="p-4 space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex gap-4">
              <div className="h-4 w-1/4 bg-muted animate-pulse rounded" />
              <div className="h-4 w-1/3 bg-muted animate-pulse rounded" />
              <div className="h-4 w-16 bg-muted animate-pulse rounded" />
              <div className="h-4 w-12 bg-muted animate-pulse rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function TemplatesPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        subtitle="Workstream and venture templates in the Jinn platform"
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Templates' },
        ]}
      />

      <main className="flex-1 py-6">
        <div className="container mx-auto px-4">
          <Suspense fallback={<TemplatesListSkeleton />}>
            <TemplatesList />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
