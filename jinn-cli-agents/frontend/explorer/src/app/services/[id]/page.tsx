import { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { SiteHeader } from '@/components/site-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  getServiceWithAllDetails,
  getVenture,
  type Service,
  type Deployment,
  type Interface,
  type ServiceDoc,
} from '@/lib/ventures-services';
import { ExternalLink, GitBranch, Globe, Clock, AlertCircle, FileText, Book } from 'lucide-react';

export const dynamic = 'force-dynamic';

interface ServicePageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: ServicePageProps): Promise<Metadata> {
  const { id } = await params;
  const { service } = await getServiceWithAllDetails(id);
  return {
    title: service?.name || 'Service',
    description: service?.description || 'Service details',
  };
}

function StatusBadge({ status, size = 'default' }: { status: string; size?: 'sm' | 'default' }) {
  const colors: Record<string, string> = {
    active: 'bg-green-500/10 text-green-500 border-green-500/20',
    healthy: 'bg-green-500/10 text-green-500 border-green-500/20',
    published: 'bg-green-500/10 text-green-500 border-green-500/20',
    deprecated: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    degraded: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    draft: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    unhealthy: 'bg-red-500/10 text-red-500 border-red-500/20',
    failed: 'bg-red-500/10 text-red-500 border-red-500/20',
    archived: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
    unknown: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
    stopped: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
    deploying: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
    removed: 'bg-red-500/10 text-red-500 border-red-500/20',
  };
  const className = size === 'sm' ? 'text-xs px-1.5 py-0' : '';
  return <Badge variant="outline" className={`${colors[status] || colors.unknown} ${className}`}>{status}</Badge>;
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatDateTime(dateString: string) {
  return new Date(dateString).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// Deployment Card
function DeploymentCard({ deployment }: { deployment: Deployment }) {
  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge variant="default">{deployment.environment}</Badge>
            <span className="text-sm text-muted-foreground">{deployment.provider}</span>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={deployment.status} size="sm" />
            <StatusBadge status={deployment.health_status} size="sm" />
          </div>
        </div>

        {deployment.url && (
          <a
            href={deployment.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <Globe className="h-3 w-3" />
            {deployment.url}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}

        {(deployment.provider_project_id || deployment.provider_service_id) && (
          <div className="text-xs text-muted-foreground font-mono space-y-0.5">
            {deployment.provider_project_id && <div>project: {deployment.provider_project_id}</div>}
            {deployment.provider_service_id && <div>service: {deployment.provider_service_id}</div>}
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground pt-2 border-t">
          <div className="flex items-center gap-3">
            {deployment.version && <span>v{deployment.version}</span>}
            {deployment.health_check_url && (
              <a href={deployment.health_check_url} target="_blank" rel="noopener noreferrer" className="hover:text-primary">
                health endpoint
              </a>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatDateTime(deployment.deployed_at)}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Interface Card
function InterfaceCard({ iface }: { iface: Interface }) {
  const typeColors: Record<Interface['interface_type'], string> = {
    mcp_tool: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
    rest_endpoint: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
    graphql: 'bg-pink-500/10 text-pink-500 border-pink-500/20',
    grpc: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
    websocket: 'bg-green-500/10 text-green-500 border-green-500/20',
    webhook: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    other: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  };

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-mono text-sm font-medium">
              {iface.http_method && <span className="text-muted-foreground mr-1">{iface.http_method}</span>}
              {iface.name}
            </div>
            {iface.http_path && (
              <code className="text-xs text-muted-foreground">{iface.http_path}</code>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Badge variant="outline" className={typeColors[iface.interface_type]}>
              {iface.interface_type.replace('_', ' ')}
            </Badge>
            <StatusBadge status={iface.status} size="sm" />
          </div>
        </div>

        {iface.description && (
          <p className="text-sm text-muted-foreground">{iface.description}</p>
        )}

        <div className="flex items-center gap-2 text-xs">
          {iface.auth_required ? (
            <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">
              auth: {iface.auth_type || 'required'}
            </Badge>
          ) : (
            <span className="text-muted-foreground">no auth</span>
          )}
          {iface.x402_price > 0 && (
            <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/20">
              {iface.x402_price} wei
            </Badge>
          )}
        </div>

        {iface.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {iface.tags.map((tag) => (
              <span key={tag} className="text-xs bg-muted px-1.5 py-0.5 rounded">{tag}</span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Doc Card
function DocCard({ doc, serviceId }: { doc: ServiceDoc; serviceId: string }) {
  const typeIcons: Record<ServiceDoc['doc_type'], string> = {
    readme: 'README',
    guide: 'Guide',
    reference: 'Reference',
    tutorial: 'Tutorial',
    changelog: 'Changelog',
    api: 'API',
    architecture: 'Architecture',
    runbook: 'Runbook',
    other: 'Doc',
  };

  return (
    <Card className="hover:border-primary/50 transition-colors">
      <Link href={`/services/${serviceId}/docs/${doc.slug}`}>
        <CardContent className="pt-4 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <Book className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{doc.title}</span>
            </div>
            <div className="flex items-center gap-1">
              <Badge variant="secondary" className="text-xs">{typeIcons[doc.doc_type]}</Badge>
              <StatusBadge status={doc.status} size="sm" />
            </div>
          </div>
          {doc.author && (
            <p className="text-xs text-muted-foreground">by {doc.author}</p>
          )}
          {doc.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {doc.tags.map((tag) => (
                <span key={tag} className="text-xs bg-muted px-1.5 py-0.5 rounded">{tag}</span>
              ))}
            </div>
          )}
        </CardContent>
      </Link>
    </Card>
  );
}

async function ServiceDetail({ id }: { id: string }) {
  const { service, deployments, interfaces, docs } = await getServiceWithAllDetails(id);

  if (!service) {
    notFound();
  }

  const venture = await getVenture(service.venture_id);
  const publishedDocs = docs.filter(d => d.status === 'published');

  return (
    <div className="space-y-6">
      {/* === SERVICE: Identity Group === */}
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-4">
            <div>
              <h1 className="text-2xl font-bold mb-1">{service.name}</h1>
              <code className="text-sm text-muted-foreground">{service.slug}</code>
              <div className="text-xs text-muted-foreground font-mono mt-1">id: {service.id}</div>
            </div>

            {service.description && (
              <p className="text-muted-foreground">{service.description}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* === SERVICE: Technical Details === */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Technical Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {service.repository_url ? (
            <a
              href={service.repository_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-primary hover:underline"
            >
              <GitBranch className="h-4 w-4" />
              {service.repository_url}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">No repository linked</p>
          )}
        </CardContent>
      </Card>

      {/* === SERVICE: Metadata Group === */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Metadata</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Venture:</span>
            {venture ? (
              <Link href={`/ventures/${venture.root_workstream_id || venture.id}`} className="text-primary hover:underline">
                {venture.name}
              </Link>
            ) : (
              <code className="text-xs text-muted-foreground">{service.venture_id}</code>
            )}
          </div>

          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span>Created: {formatDate(service.created_at)}</span>
            <span>Updated: {formatDate(service.updated_at)}</span>
          </div>
        </CardContent>
      </Card>

      {/* === DEPLOYMENTS === */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          Deployments
          <Badge variant="secondary">{deployments.length}</Badge>
        </h2>
        {deployments.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              <AlertCircle className="h-5 w-5 mx-auto mb-2 opacity-50" />
              No deployments registered
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {deployments.map((deployment) => (
              <DeploymentCard key={deployment.id} deployment={deployment} />
            ))}
          </div>
        )}
      </div>

      {/* === INTERFACES === */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          Interfaces
          <Badge variant="secondary">{interfaces.length}</Badge>
        </h2>
        {interfaces.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              <AlertCircle className="h-5 w-5 mx-auto mb-2 opacity-50" />
              No interfaces registered
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {interfaces.map((iface) => (
              <InterfaceCard key={iface.id} iface={iface} />
            ))}
          </div>
        )}
      </div>

      {/* === DOCUMENTATION === */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Documentation
          <Badge variant="secondary">{publishedDocs.length}</Badge>
        </h2>
        {publishedDocs.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              <Book className="h-5 w-5 mx-auto mb-2 opacity-50" />
              No documentation available
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {publishedDocs.map((doc) => (
              <DocCard key={doc.id} doc={doc} serviceId={service.id} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ServiceDetailSkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6 space-y-3">
          <div className="h-8 w-64 bg-muted animate-pulse rounded" />
          <div className="h-4 w-32 bg-muted animate-pulse rounded" />
          <div className="h-16 w-full bg-muted animate-pulse rounded" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6 space-y-3">
          <div className="h-5 w-40 bg-muted animate-pulse rounded" />
          <div className="flex gap-2">
            <div className="h-6 w-16 bg-muted animate-pulse rounded" />
            <div className="h-6 w-20 bg-muted animate-pulse rounded" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default async function ServicePage({ params }: ServicePageProps) {
  const { id } = await params;
  const { service } = await getServiceWithAllDetails(id);

  if (!service) {
    notFound();
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Services', href: '/services' },
          { label: service.name },
        ]}
      />

      <main className="flex-1 py-6">
        <div className="container mx-auto px-4 max-w-4xl">
          <Suspense fallback={<ServiceDetailSkeleton />}>
            <ServiceDetail id={id} />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
