import { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { SiteHeader } from '@/components/site-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getServices, getVentures, type Service } from '@/lib/ventures-services';
import { GitBranch, ExternalLink, ArrowRight } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Services Registry',
  description: 'Browse all registered services in the Jinn platform',
};

export const dynamic = 'force-dynamic';

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function ServiceCard({ service, ventureName }: { service: Service; ventureName?: string }) {
  return (
    <Card className="hover:border-primary/50 transition-colors">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle>
              <Link href={`/services/${service.id}`} className="hover:text-primary hover:underline">
                {service.name}
              </Link>
            </CardTitle>
            <p className="text-sm text-muted-foreground font-mono">
              {service.slug}
            </p>
          </div>
          <Link
            href={`/services/${service.id}`}
            className="text-sm text-muted-foreground hover:text-primary flex items-center gap-1"
          >
            View <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {service.description && (
          <p className="text-sm text-muted-foreground mb-3">
            {service.description}
          </p>
        )}

        {service.repository_url && (
          <a
            href={service.repository_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary mb-3"
          >
            <GitBranch className="h-3 w-3" />
            {new URL(service.repository_url).pathname.slice(1)}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground border-t pt-3 mt-3">
          {ventureName ? (
            <span>Venture: {ventureName}</span>
          ) : (
            <span className="font-mono text-[10px]">{service.venture_id.slice(0, 8)}...</span>
          )}
          <span>Updated {formatDate(service.updated_at)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

async function ServicesList() {
  const [services, ventures] = await Promise.all([
    getServices(),
    getVentures(),
  ]);

  const ventureMap = new Map(ventures.map(v => [v.id, v.name]));

  if (services.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No services found
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        {services.length} service{services.length !== 1 ? 's' : ''} registered
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {services.map((service) => (
          <ServiceCard
            key={service.id}
            service={service}
            ventureName={ventureMap.get(service.venture_id)}
          />
        ))}
      </div>
    </div>
  );
}

function ServicesListSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-5 w-32 bg-muted animate-pulse rounded" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <div className="h-5 w-3/4 bg-muted animate-pulse rounded" />
              <div className="h-3 w-1/2 bg-muted animate-pulse rounded mt-2" />
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="h-4 w-full bg-muted animate-pulse rounded" />
              <div className="h-4 w-2/3 bg-muted animate-pulse rounded" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function ServicesPage() {
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
          <Suspense fallback={<ServicesListSkeleton />}>
            <ServicesList />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
