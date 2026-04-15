import { VentureForm } from '../../components/venture-form';

export const metadata = {
  title: 'Create Venture',
  description: 'Create a new venture',
};

export default function NewVenturePage() {
  return (
    <div className="max-w-2xl mx-auto">
      <VentureForm />
    </div>
  );
}
