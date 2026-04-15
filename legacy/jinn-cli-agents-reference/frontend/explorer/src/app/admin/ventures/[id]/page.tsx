import { notFound } from 'next/navigation';
import { getVenture } from '@/lib/ventures-services';
import { VentureForm } from '../../components/venture-form';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  const venture = await getVenture(id);
  return {
    title: venture ? `Edit ${venture.name}` : 'Edit Venture',
    description: venture?.description || 'Edit venture details',
  };
}

export const dynamic = 'force-dynamic';

export default async function EditVenturePage({ params }: PageProps) {
  const { id } = await params;
  const venture = await getVenture(id);

  if (!venture) {
    notFound();
  }

  return (
    <div className="max-w-2xl mx-auto">
      <VentureForm venture={venture} />
    </div>
  );
}
