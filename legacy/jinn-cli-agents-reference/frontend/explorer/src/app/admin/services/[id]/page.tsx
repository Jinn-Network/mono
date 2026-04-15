import { notFound } from 'next/navigation';
import { getServiceWithAllDetails, getVentures } from '@/lib/ventures-services';
import { ServiceEditTabs } from './service-edit-tabs';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  const { service } = await getServiceWithAllDetails(id);
  return {
    title: service ? `Edit ${service.name}` : 'Edit Service',
    description: service?.description || 'Edit service details',
  };
}

export const dynamic = 'force-dynamic';

export default async function EditServicePage({ params }: PageProps) {
  const { id } = await params;
  const [{ service, deployments, interfaces, docs }, ventures] = await Promise.all([
    getServiceWithAllDetails(id),
    getVentures(),
  ]);

  if (!service) {
    notFound();
  }

  return (
    <div className="max-w-4xl mx-auto">
      <ServiceEditTabs
        service={service}
        ventures={ventures}
        deployments={deployments}
        interfaces={interfaces}
        docs={docs}
      />
    </div>
  );
}
