import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { SiteHeader } from '@/components/site-header';
import { getServiceInstance } from '@/lib/ventures/service-queries';
import { VentureDetail, VentureDetailSkeleton } from '../page';

interface VentureArtifactsPageProps {
  params: Promise<{ id: string }>;
}

export default async function VentureArtifactsPage({ params }: VentureArtifactsPageProps) {
  const { id } = await params;
  const instance = await getServiceInstance(id);

  if (!instance) {
    notFound();
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Ventures', href: '/ventures' },
          { label: instance.jobName }
        ]}
      />

      <main className="flex-1 py-6 flex flex-col min-h-0">
        <div className="flex-1 flex flex-col min-h-0 px-4">
          <Suspense fallback={<VentureDetailSkeleton />}>
            <VentureDetail id={id} initialTab="artifacts" />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
