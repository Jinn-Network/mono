import { notFound } from 'next/navigation';
import Link from 'next/link';
import { SiteHeader } from '@/components/site-header';
import { Button } from '@/components/ui/button';
import { Home, Building2, Server } from 'lucide-react';

function isAdminEnabled() {
  // Local development
  if (process.env.NODE_ENV === 'development') return true;
  // Vercel preview deployments
  if (process.env.VERCEL_ENV === 'preview') return true;
  // Production - disabled
  return false;
}

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isAdminEnabled()) {
    notFound();
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader
        breadcrumbs={[
          { label: 'Explorer', href: '/' },
          { label: 'Admin' },
        ]}
      />
      <div className="border-b bg-muted/30">
        <div className="container mx-auto px-4">
          <nav className="flex items-center gap-1 py-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/admin">
                <Home className="h-4 w-4 mr-1" />
                Dashboard
              </Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/admin/ventures">
                <Building2 className="h-4 w-4 mr-1" />
                Ventures
              </Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/admin/services">
                <Server className="h-4 w-4 mr-1" />
                Services
              </Link>
            </Button>
          </nav>
        </div>
      </div>
      <main className="flex-1 py-6">
        <div className="container mx-auto px-4">
          {children}
        </div>
      </main>
    </div>
  );
}
