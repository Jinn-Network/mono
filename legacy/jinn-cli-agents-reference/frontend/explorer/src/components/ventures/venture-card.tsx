import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatRelativeTime, truncateAddress } from '@jinn/shared-ui';
import type { ServiceInstance } from '@/lib/ventures/service-types';

interface VentureCardProps {
  instance: ServiceInstance;
}

export function VentureCard({ instance, tokenSymbol, poolAddress }: VentureCardProps & { tokenSymbol?: string | null; poolAddress?: string | null }) {
  const status = instance.delivered ? 'completed' : 'active';

  return (
    <Card className="hover:border-primary/30 transition-colors">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <Link href={`/ventures/${instance.workstreamId}`}>
              <CardTitle className="text-lg hover:text-primary transition-colors cursor-pointer">
                {instance.jobName}
                {tokenSymbol && (
                  <span className="ml-2 text-sm font-mono text-primary">
                    {poolAddress ? (
                      <a
                        href={`https://basescan.org/address/${poolAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        ${tokenSymbol}
                      </a>
                    ) : (
                      `$${tokenSymbol}`
                    )}
                  </span>
                )}
              </CardTitle>
            </Link>
            <CardDescription className="mt-1">
              Created by {truncateAddress(instance.sender)}
            </CardDescription>
          </div>
          <Badge variant={status === 'active' ? 'default' : 'secondary'}>
            {status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {formatRelativeTime(instance.blockTimestamp)}
          </span>
          <Link
            href={`/workstreams/${instance.workstreamId}`}
            className="text-primary hover:underline text-sm"
          >
            Details
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

// Loading skeleton
export function VentureCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <div className="h-5 w-36 animate-pulse rounded bg-muted" />
            <div className="mt-2 h-4 w-24 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-5 w-16 animate-pulse rounded bg-muted" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="h-4 w-20 animate-pulse rounded bg-muted" />
          <div className="h-4 w-16 animate-pulse rounded bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}
