import { getVentures } from '@/lib/ventures-services';
import { ServiceForm } from '../../components/service-form';

export const metadata = {
  title: 'Create Service',
  description: 'Create a new service',
};

export const dynamic = 'force-dynamic';

export default async function NewServicePage() {
  const ventures = await getVentures();

  return (
    <div className="max-w-2xl mx-auto">
      <ServiceForm ventures={ventures} />
    </div>
  );
}
