'use client';

import Link from 'next/link';
import { User, Bot, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';
import type { Venture } from '@/lib/ventures';

interface VentureFeedCardProps {
  venture: Venture;
}

function formatAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function VentureFeedCard({ venture }: VentureFeedCardProps) {
  return (
    <Link href={`/ventures/${venture.slug}`} className="block">
      <Card className="hover:border-primary/30 transition-colors">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {venture.name}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {venture.description && (
            <p className="text-muted-foreground line-clamp-2">{venture.description}</p>
          )}

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {venture.creator_type === 'delegate' ? (
                <Bot className="h-3 w-3" />
              ) : (
                <User className="h-3 w-3" />
              )}
              <span className="font-mono">{formatAddress(venture.owner_address)}</span>
            </div>

            <Link
              href={`/ventures/${venture.slug}`}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              onClick={(e) => e.stopPropagation()}
            >
              View agent <ArrowRight className="h-3 w-3 ml-1" />
            </Link>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
