import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getVentures } from '@/lib/ventures-services';
import { Plus, Pencil } from 'lucide-react';

export const metadata = {
  title: 'Manage Ventures',
  description: 'Create and edit ventures',
};

export const dynamic = 'force-dynamic';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-500/10 text-green-500 border-green-500/20',
    paused: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    archived: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  };
  return (
    <Badge variant="outline" className={colors[status] || colors.archived}>
      {status}
    </Badge>
  );
}

export default async function VenturesAdminPage() {
  const ventures = await getVentures();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Ventures</h1>
          <p className="text-muted-foreground">
            {ventures.length} venture{ventures.length !== 1 ? 's' : ''} total
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/ventures/new">
            <Plus className="h-4 w-4 mr-1" />
            Create Venture
          </Link>
        </Button>
      </div>

      {ventures.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">No ventures yet.</p>
            <Button asChild className="mt-4">
              <Link href="/admin/ventures/new">Create your first venture</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {ventures.map((venture) => (
            <Card key={venture.id} className="hover:border-primary/50 transition-colors">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <CardTitle className="flex items-center gap-2">
                      {venture.name}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground font-mono">
                      {venture.slug}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={venture.status} />
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/admin/ventures/${venture.id}`}>
                        <Pencil className="h-4 w-4 mr-1" />
                        Edit
                      </Link>
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {venture.description && (
                  <p className="text-sm text-muted-foreground mb-3">
                    {venture.description}
                  </p>
                )}
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>Owner: {venture.owner_address.slice(0, 8)}...</span>
                  {venture.blueprint?.invariants?.length > 0 && (
                    <span>
                      {venture.blueprint.invariants.length} invariant
                      {venture.blueprint.invariants.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
