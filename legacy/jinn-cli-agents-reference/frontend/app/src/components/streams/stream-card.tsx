'use client';

import Link from 'next/link';
import { Rss, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Venture } from '@/lib/ventures';

interface StreamCardProps {
  venture: Venture;
}

export function StreamCard({ venture }: StreamCardProps) {
  const hasLiveStream = Boolean(venture.root_workstream_id);
  const href = hasLiveStream ? `/streams/${venture.slug}` : `/ventures/${venture.slug}`;
  const cta = hasLiveStream ? 'Read stream' : 'View venture';

  return (
    <Link href={href} className="block group">
      <Card className="hover:border-primary/30 transition-colors">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Rss className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">{venture.name}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {venture.description && (
            <p className="text-sm text-muted-foreground line-clamp-2">
              {venture.description}
            </p>
          )}
          <div className="flex justify-end">
            <span className="inline-flex items-center gap-1 text-sm font-medium text-primary group-hover:underline">
              {cta} <ArrowRight className="h-3 w-3" />
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
