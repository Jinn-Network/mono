import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Building2, Server, Plus } from 'lucide-react';
import { getVentures, getServices } from '@/lib/ventures-services';

export const metadata = {
  title: 'Admin Dashboard',
  description: 'Manage ventures, services, and more',
};

export const dynamic = 'force-dynamic';

async function AdminStats() {
  const [ventures, services] = await Promise.all([
    getVentures(),
    getServices(),
  ]);

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Total Ventures</CardTitle>
          <Building2 className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{ventures.length}</div>
          <p className="text-xs text-muted-foreground">
            {ventures.filter(v => v.status === 'active').length} active
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Total Services</CardTitle>
          <Server className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{services.length}</div>
          <p className="text-xs text-muted-foreground">
            registered in the platform
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminDashboard() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Admin Dashboard</h1>
        <p className="text-muted-foreground">
          Manage ventures, services, deployments, and documentation.
        </p>
      </div>

      <AdminStats />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              Ventures
            </CardTitle>
            <CardDescription>
              Create and manage ventures - the top-level entities that group services.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button asChild>
              <Link href="/admin/ventures/new">
                <Plus className="h-4 w-4 mr-1" />
                Create Venture
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/admin/ventures">View All</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              Services
            </CardTitle>
            <CardDescription>
              Create and manage services with their deployments, interfaces, and docs.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button asChild>
              <Link href="/admin/services/new">
                <Plus className="h-4 w-4 mr-1" />
                Create Service
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/admin/services">View All</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
