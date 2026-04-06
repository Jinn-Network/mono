'use client';

import Link from 'next/link';
import { Rocket } from 'lucide-react';
import { usePrivy } from '@privy-io/react-auth';
import { Button } from '@/components/ui/button';

export function NavHeader() {
  const { ready, authenticated, user, login, logout } = usePrivy();

  return (
    <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 font-semibold text-lg">
            <Rocket className="h-5 w-5 text-primary" />
            Jinn
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors">
              Explore
            </Link>
            <Link href="/streams" className="text-muted-foreground hover:text-foreground transition-colors">
              Streams
            </Link>
            <Link href="/create" className="text-muted-foreground hover:text-foreground transition-colors">
              Create
            </Link>
          </nav>
        </div>
        {ready && (
          authenticated ? (
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">
                {user?.email?.address || user?.wallet?.address?.slice(0, 6) + '...' + user?.wallet?.address?.slice(-4) || 'Connected'}
              </span>
              <Button variant="outline" size="sm" onClick={logout}>
                Sign Out
              </Button>
            </div>
          ) : (
            <Button onClick={login} size="sm">
              Sign In
            </Button>
          )
        )}
      </div>
    </header>
  );
}
