import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getServices, getVentures } from '@/lib/ventures-services';
import { Plus, Pencil } from 'lucide-react';

export const metadata = {
  title: 'Manage Services',
  description: 'Create and edit services',
};

export const dynamic = 'force-dynamic';

export default async function ServicesAdminPage() {
  const [services, ventures] = await Promise.all([
    getServices(),
    getVentures(),
  ]);

  const ventureMap = new Map(ventures.map(v => [v.id, v]));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Services</h1>
          <p className="text-muted-foreground">
            {services.length} service{services.length !== 1 ? 's' : ''} total
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/services/new">
            <Plus className="h-4 w-4 mr-1" />
            Create Service
          </Link>
        </Button>
      </div>

      {services.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">No services yet.</p>
            <Button asChild className="mt-4">
              <Link href="/admin/services/new">Create your first service</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {services.map((service) => {
            const venture = ventureMap.get(service.venture_id);
            return (
              <Card key={service.id} className="hover:border-primary/50 transition-colors">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <CardTitle>{service.name}</CardTitle>
                      <p className="text-sm text-muted-foreground font-mono">
                        {service.slug}
                      </p>
                    </div>
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/admin/services/${service.id}`}>
                        <Pencil className="h-4 w-4 mr-1" />
                        Edit
                      </Link>
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {service.description && (
                    <p className="text-sm text-muted-foreground mb-3">
                      {service.description}
                    </p>
                  )}
                  {venture && (
                    <div className="text-xs text-muted-foreground">
                      Venture:{' '}
                      <Link href={`/admin/ventures/${venture.id}`} className="text-primary hover:underline">
                        {venture.name}
                      </Link>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
