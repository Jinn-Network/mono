import { Metadata } from 'next';
import { Suspense } from 'react';
import { SiteHeader } from '@/components/site-header';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getBlueprints, getVentures, type Blueprint } from '@/lib/ventures-services';

export const metadata: Metadata = {
  title: 'Blueprints',
  description: 'Browse reusable blueprint templates in the Jinn platform',
};

export const dynamic = 'force-dynamic';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    published: 'bg-green-500/10 text-green-500 border-green-500/20',
    draft: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    archived: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  };
  return (
    <Badge variant="outline" className={colors[status] || colors.archived}>
      {status}
    </Badge>
  );
}

function SafetyBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    public: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
    private: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
    restricted: 'bg-red-500/10 text-red-500 border-red-500/20',
  };
  return (
    <Badge variant="outline" className={colors[tier] || colors.public}>
      {tier}
    </Badge>
  );
}

function TypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    venture: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
    agent: 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20',
  };
  return (
    <Badge variant="outline" className={colors[type] || colors.agent}>
      {type}
    </Badge>
  );
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function BlueprintRow({ blueprint, ventureName }: { blueprint: Blueprint; ventureName?: string }) {
  return (
    <TableRow>
      <TableCell>
        <div className="space-y-1">
          <div className="font-medium">{blueprint.name}</div>
          <div className="text-xs text-muted-foreground font-mono">{blueprint.slug}</div>
        </div>
      </TableCell>
      <TableCell className="max-w-[300px]">
        <p className="text-sm text-muted-foreground truncate">
          {blueprint.description || '-'}
        </p>
      </TableCell>
      <TableCell>
        <StatusBadge status={blueprint.status} />
      </TableCell>
      <TableCell>
        <TypeBadge type={blueprint.type} />
      </TableCell>
      <TableCell className="text-sm font-mono">
        {blueprint.version}
      </TableCell>
      <TableCell>
        {blueprint.price_usd ? (
          <span className="text-sm">{blueprint.price_usd}</span>
        ) : blueprint.price_wei ? (
          <span className="text-sm font-mono text-muted-foreground">{blueprint.price_wei}</span>
        ) : (
          <span className="text-sm text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell>
        <SafetyBadge tier={blueprint.safety_tier} />
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {blueprint.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[10px]">
              {tag}
            </Badge>
          ))}
          {blueprint.tags.length > 3 && (
            <Badge variant="secondary" className="text-[10px]">
              +{blueprint.tags.length - 3}
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {ventureName || '-'}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
        {formatDate(blueprint.created_at)}
      </TableCell>
    </TableRow>
  );
}

async function BlueprintsList() {
  const [blueprints, ventures] = await Promise.all([
    getBlueprints(),
    getVentures(),
  ]);

  const ventureMap = new Map(ventures.map(v => [v.id, v.name]));

  if (blueprints.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No blueprints found
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        {blueprints.length} blueprint{blueprints.length !== 1 ? 's' : ''} registered
      </p>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Venture</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {blueprints.map((blueprint) => (
              <BlueprintRow
                key={blueprint.id}
                blueprint={blueprint}
                ventureName={blueprint.venture_id ? ventureMap.get(blueprint.venture_id) : undefined}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function BlueprintsListSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-5 w-32 bg-muted animate-pulse rounded" />
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

export default function BlueprintsPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        subtitle="Reusable blueprint templates in the Jinn platform"
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Blueprints' },
        ]}
      />

      <main className="flex-1 py-6">
        <div className="container mx-auto px-4">
          <Suspense fallback={<BlueprintsListSkeleton />}>
            <BlueprintsList />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
