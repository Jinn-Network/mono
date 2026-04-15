import { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { SiteHeader } from '@/components/site-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getBlueprint, getVenture, type Blueprint } from '@/lib/ventures-services';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const template = await getBlueprint(id);
  return {
    title: template?.name || 'Workstream Template',
    description: template?.description || 'Workstream template details',
  };
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    published: 'bg-green-500/10 text-green-500 border-green-500/20',
    draft: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    archived: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  };
  return <Badge variant="outline" className={colors[status] || colors.archived}>{status}</Badge>;
}

function SafetyBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    public: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
    private: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
    restricted: 'bg-red-500/10 text-red-500 border-red-500/20',
  };
  return <Badge variant="outline" className={colors[tier] || colors.public}>{tier}</Badge>;
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function JsonBlock({ data, label }: { data: object; label: string }) {
  const content = JSON.stringify(data, null, 2);
  if (!content || content === '{}' || content === '[]' || content === 'null') return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="text-xs font-mono bg-muted p-3 rounded-md overflow-x-auto max-h-96 overflow-y-auto">
          {content}
        </pre>
      </CardContent>
    </Card>
  );
}

async function TemplateDetail({ id }: { id: string }) {
  const template = await getBlueprint(id);
  if (!template) notFound();

  const venture = template.venture_id ? await getVenture(template.venture_id) : null;

  return (
    <div className="space-y-6">
      {/* Identity */}
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-2xl font-bold mb-1">{template.name}</h1>
                <code className="text-sm text-muted-foreground">{template.slug}</code>
                <div className="text-xs text-muted-foreground font-mono mt-1">id: {template.id}</div>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={template.status} />
                <SafetyBadge tier={template.safety_tier} />
              </div>
            </div>
            {template.description && (
              <p className="text-muted-foreground">{template.description}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Metadata */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground block text-xs mb-1">Version</span>
              <span className="font-mono">{template.version}</span>
            </div>
            <div>
              <span className="text-muted-foreground block text-xs mb-1">Cyclic</span>
              <span>{template.default_cyclic ? 'Yes' : 'No'}</span>
            </div>
            <div>
              <span className="text-muted-foreground block text-xs mb-1">Price (USD)</span>
              <span>{template.price_usd || '-'}</span>
            </div>
            <div>
              <span className="text-muted-foreground block text-xs mb-1">Price (Wei)</span>
              <span className="font-mono">{template.price_wei || '-'}</span>
            </div>
            <div>
              <span className="text-muted-foreground block text-xs mb-1">Venture</span>
              {venture ? (
                <Link href={`/ventures/${venture.root_workstream_id || venture.id}`} className="text-primary hover:underline">
                  {venture.name}
                </Link>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </div>
            {template.olas_agent_id && (
              <div>
                <span className="text-muted-foreground block text-xs mb-1">OLAS Agent ID</span>
                <span className="font-mono">{template.olas_agent_id}</span>
              </div>
            )}
            <div>
              <span className="text-muted-foreground block text-xs mb-1">Created</span>
              <span>{formatDate(template.created_at)}</span>
            </div>
            <div>
              <span className="text-muted-foreground block text-xs mb-1">Updated</span>
              <span>{formatDate(template.updated_at)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tool Policy */}
      {template.enabled_tools.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Tool Policy</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {template.enabled_tools.map((tool) => (
                <Badge key={tool} variant="outline" className="font-mono text-xs">{tool}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Blueprint */}
      <JsonBlock data={template.blueprint} label="Blueprint" />

      {/* Input Schema */}
      <JsonBlock data={template.input_schema} label="Input Schema" />

      {/* Output Spec */}
      <JsonBlock data={template.output_spec} label="Output Spec" />
    </div>
  );
}

function TemplateDetailSkeleton() {
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
          <div className="grid grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-10 bg-muted animate-pulse rounded" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default async function WorkstreamTemplatePage({ params }: PageProps) {
  const { id } = await params;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Templates', href: '/templates' },
          { label: 'Workstream Template' },
        ]}
      />
      <main className="flex-1 py-6">
        <div className="container mx-auto px-4 max-w-4xl">
          <Suspense fallback={<TemplateDetailSkeleton />}>
            <TemplateDetail id={id} />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
